import { FakeModelProvider } from "@jehad/adapters";
import type { ModelRequest, ModelResult } from "@jehad/adapters";
import { randomUUID } from "node:crypto";
import {
  CONVERSE_CAPABILITY,
  ModelEgressPolicyRegistry,
  civilDateOf,
  handleInbound,
  issueGrant,
  openCalibrationItem,
} from "@jehad/core";
import type {
  ConversationDeps,
  ConverseOutcome,
  GatewayPrincipalPolicy,
  InboundConversationMessage,
} from "@jehad/core";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb } from "../../packages/db/tests/test-db.js";
import { persistenceClaimIn } from "./assertions.js";
import {
  intentIsFailure,
  ledgerContainsFailures,
  roundsBoundFailures,
} from "./assertions.js";
import type { LedgerEntryObservation } from "./assertions.js";
import type {
  DbPin,
  ReadOverride,
  Scenario,
  ScenarioExpectations,
  ScriptPass,
  ScriptedPass,
} from "./scenarios.js";

export type CapabilityProbes = Readonly<Record<string, boolean>>;

/** W6(a/R8): the interpret pass observation — captured from the
 * `imessage.converse.interpret` audit rows the interpreter's caller (the
 * orchestrator) emits per turn. Until that wiring lands, requires-gated
 * scenarios skip and audits stay 0. */
export interface InterpretationObservation {
  readonly audits: number;
  readonly payloads: readonly unknown[];
}

export interface TurnObservation {
  readonly user: string;
  readonly replied: boolean;
  readonly replyReason: string | null;
  readonly reply: string | null;
  readonly routedTools: readonly string[];
  /** Legacy path: dispatches classified by prompt marker. Single path
   * (§22): the scripted kinds in consumption order — "cognitive" per model
   * round, "verify" for the truth-verifier call — because the §22.11
   * deletion removes the marker-bearing prompts. */
  readonly passes: readonly ScriptPass[];
  readonly interpretation: InterpretationObservation;
  /** C11: deterministic markers on this turn's `imessage.converse.replied`
   * audit rows (outputs_ref->deterministic; model replies carry none). */
  readonly auditMarkers: readonly string[];
  /** C11: prompts dispatched as the answer pass this turn (prompt-level pins:
   * persona fragment, self-brief). Empty on the single path — its prompts
   * are round contexts, not the legacy answer pass. */
  readonly answerPrompts: readonly string[];
  /** §22: the operation/resolution ledger entries this turn produced,
  * normalized to {opType, status} (§22.2/§22.3 vocabulary, including
  * rejected/failed entries — the same ledger §22.9 verifies against).
  * Empty on the legacy path, which has no typed ledger. */
  readonly ledger: readonly LedgerEntryObservation[];
  /** §22: cognitive rounds executed this turn (0 on the legacy path). */
  readonly rounds: number;
  /** §22: the structured intent from the envelope audit (§22.2 owner
   * correction 5 — the durable enum, never the ephemeral interpretation).
   * null on the legacy path / when no envelope landed. */
  readonly intent: string | null;
  readonly scriptIssues: readonly string[];
}

export interface ScenarioResult {
  readonly id: string;
  readonly status: "pass" | "fail" | "skip";
  readonly reason: string | null;
  readonly failures: readonly string[];
  readonly turns: readonly TurnObservation[];
}

export interface ConversationEvalRun {
  readonly results: readonly ScenarioResult[];
  readonly counts: { readonly pass: number; readonly fail: number; readonly skip: number };
}

export interface ConversationEvalOptions {
  readonly databaseUrl: string;
  readonly scenarios: readonly Scenario[];
  readonly capabilityProbes?: CapabilityProbes;
  readonly dbTag?: string;
  /** §22: the single-path turn entry. Production (run.ts CLI) resolves it
   * from @jehad/core's cognitive_turn export; tests inject a fake core
   * seam to exercise the machinery hermetically before the export lands.
   * Single-path scenarios skip when the probe passes but no entry is
   * supplied. */
  readonly cognitiveTurn?: CognitiveTurnFn;
}

export type SqlRunner = (sql: string) => Promise<readonly Record<string, unknown>[]>;

const ROUTE_PROMPT_MARKER = "query router for a personal assistant message gateway";
// Coordinate (W6(a) lane): the interpret pass is route-class and its prompt
// must open with this sentence — the same convention the route prompt uses —
// so the eval harness can tell the two passes apart by marker.
const INTERPRET_PROMPT_MARKER = "turn interpreter for a personal assistant message gateway";
const ANCHOR_ISO = "2026-09-21T18:00:00.000Z";
const TURN_STEP_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const GRANT_WINDOW_MS = 8 * DAY_MS;

const REGISTRY = new ModelEgressPolicyRegistry([
  {
    id: "conversation-eval-personal-normal",
    domainId: "personal",
    sensitivity: "normal",
    allowedProviders: ["fake"],
    allowRemote: false,
    requireRedaction: false,
  },
]);

const PRINCIPAL_POLICY: GatewayPrincipalPolicy = {
  model: "fake/model-x",
  requestsPerHour: 1000,
  costPerDay: 100,
  reads: ["calendar", "commitments", "gmail", "state", "memory", "system"],
};

const CLEANUP_SQL = `
  DELETE FROM feedback; DELETE FROM calibration_items;
  DELETE FROM memory_candidates;
  DELETE FROM interaction_messages; DELETE FROM interaction_threads;
  DELETE FROM audit_log; DELETE FROM review_refs;
  DELETE FROM action_attempts; DELETE FROM action_intents;
  DELETE FROM model_calls; DELETE FROM runs; DELETE FROM notifications;
  DELETE FROM commitments; DELETE FROM interaction_profiles;
  DELETE FROM gmail_messages; DELETE FROM outcomes;
  DELETE FROM capability_grants WHERE capability = 'imessage:converse';
`;

export function passKindOf(prompt: string): "route" | "interpret" | "answer" {
  if (prompt.includes(INTERPRET_PROMPT_MARKER)) return "interpret";
  return prompt.includes(ROUTE_PROMPT_MARKER) ? "route" : "answer";
}

interface ScriptedDispatch {
  readonly responder: (request: ModelRequest) => ModelResult;
  readonly mismatches: () => readonly string[];
  readonly consumed: () => number;
  readonly kinds: () => readonly ScriptPass[];
}

export function scriptedDispatch(
  script: readonly { readonly pass: string; readonly output: string }[],
): ScriptedDispatch {
  const mismatches: string[] = [];
  const kinds: ScriptPass[] = [];
  let index = 0;
  return {
    responder: (request: ModelRequest): ModelResult => {
      const actual = passKindOf(request.prompt);
      const scripted = script[index];
      // The interpret pass is advisory and dispatched between route and
      // answer: when the NEXT script entry is not interpret, satisfy the
      // dispatch with "no proposals" WITHOUT consuming the script.
      if (actual === "interpret") {
        if (scripted !== undefined && scripted.pass === "interpret") {
          index += 1;
          return { text: scripted.output };
        }
        return { text: "[]" };
      }
      index += 1;
      if (scripted === undefined) {
        mismatches.push(`${actual} pass dispatched but modelScript is exhausted`);
        throw new Error("conversation eval: modelScript exhausted");
      }
      if (scripted.pass !== actual) {
        mismatches.push(`pass mismatch — scripted ${scripted.pass}, dispatched ${actual}`);
      }
      kinds.push(scripted.pass as ScriptPass);
      return { text: scripted.output };
    },
    mismatches: () => mismatches,
    consumed: () => index,
    kinds: () => [...kinds],
  };
}

// ---------------------------------------------------------------------
// §22 single-author path (intelligence-reset §22.15 runner extension).
// The legacy classifier above keys on the route/interpret prompt markers —
// both prompts die per §22.11 — so the single path's dispatch is matched by
// ROUND INDEX instead: every model call the loop makes (cognitive round or
// truth verification) consumes the next script entry, and script order IS
// round order. The scenario schema enforces that single-path scripts use
// only the cognitive/verify kinds.
// ---------------------------------------------------------------------

/** Script the single path's model calls by round index: the loop's Nth
 * provider dispatch returns the Nth script entry verbatim (cognitive
 * entries emit envelope JSON as the model output; verify entries emit the
 * verifier verdict). No prompt classification — a scripted verify entry
 * that never dispatches (e.g. an empty ledger skips §22.9 verification)
 * surfaces as "scripted pass(es) never dispatched", and any extra
 * unscripted dispatch exhausts the script and fails the scenario.
 * `kinds()` is the scripted kinds actually consumed, in dispatch order —
 * the round-indexed `passes` observation for the turn. */
export function singlePathDispatch(script: readonly ScriptedPass[]): ScriptedDispatch {
  const mismatches: string[] = [];
  const kinds: ScriptPass[] = [];
  let index = 0;
  return {
    responder: (request: ModelRequest): ModelResult => {
      // Round-index matching: the prompt is deliberately unread (§22.11
      // deletes the marker-bearing prompts; classification is impossible).
      void request;
      const scripted = script[index];
      index += 1;
      if (scripted === undefined) {
        mismatches.push(`model call ${index} dispatched but modelScript is exhausted`);
        throw new Error("conversation eval: modelScript exhausted");
      }
      kinds.push(scripted.pass);
      return { text: scripted.output };
    },
    mismatches: () => mismatches,
    consumed: () => index,
    kinds: () => [...kinds],
  };
}

/** §22.15(b): the read-override queue handed to the single path through
 * deps.readOverrides. Scenario-level list, consumed IN ORDER PER TOOL: the
 * first unconsumed entry whose tool name matches supplies its `result`
 * verbatim and is then spent, so repeated reads of the same tool get
 * distinct scripted results (G1's sparse variant: read 1 returns the old
 * `{otherOpenCount: 7}` shape, read 2 returns the full item list). Reads
 * with no live override fall through to the DB-backed tool. */
export class ReadOverrideQueue {
  private readonly spent: boolean[];

  constructor(readonly overrides: readonly ReadOverride[]) {
    this.spent = overrides.map(() => false);
  }

  /** First unconsumed override for `tool`, or null to execute normally. */
  take(tool: string): { readonly result: unknown } | null {
    for (const [index, override] of this.overrides.entries()) {
      if (this.spent[index]!) continue;
      if (override.tool === tool) {
        this.spent[index] = true;
        return { result: override.result };
      }
    }
    return null;
  }
}

/** §22: the deps object the runner hands the single path — ConversationDeps
 * plus the eval-only readOverrides seam. */
export interface SinglePathConversationDeps extends ConversationDeps {
  readonly readOverrides?: ReadOverrideQueue;
}

/** §22: what the single-path turn entry returns — ConverseOutcome plus the
 * observations the G-scenarios pin. `ledger` entries are the turn's
 * operation/resolution ledger (§22.2/§22.3, including rejected/failed
 * entries) shaped {opType, status} (`type`/`op_type` are normalized).
 * `intent` is the §22.2 structured enum from the envelope audit. */
export interface CognitiveTurnOutcome extends ConverseOutcome {
  readonly rounds?: number;
  readonly intent?: string | null;
  readonly ledger?: readonly Record<string, unknown>[];
}

/**
 * LOOP-BUILDER CONTRACT (§22.15 runner extension — the seams this harness
 * requires of `packages/core`'s cognitive-turn module; parallel work):
 *
 * 1. ENTRY — core exports ONE function whose name matches the
 *    `cognitive_turn` capability pattern in run.ts (e.g. `runCognitiveTurn`),
 *    with this signature. handleInbound keeps owning the shell (grants,
 *    budgets, locks, thread writes, notifications — §22.14); this entry is
 *    the turn-orchestration core the flag selects.
 *
 * 2. MODEL DISPATCH — every provider call the loop makes (cognitive rounds
 *    AND the §22.9 verification call) flows through deps.provider in loop
 *    order, so the round-indexed script answers each in sequence.
 *
 * 3. READ EXECUTION / OVERRIDES — before executing a DB-backed read tool,
 *    consult `(deps as SinglePathConversationDeps).readOverrides?.take(toolName)`;
 *    a non-null take supplies the RESULT OBJECT verbatim (no DB call). This
 *    is the only way to script read shapes the live tool never emits (G1's
 *    sparse `{otherOpenCount: 7}` variant — read-tools.ts always emits
 *    `open:` alongside).
 *
 * 4. WALL GUARD — thread the scenario clock: read the current instant via
 *    `deps.now?.() ?? new Date()` at turn start AND at every round
 *    boundary, and force the final round when elapsed exceeds §22.5's 20s.
 *    Never use Date.now() and never cache one `now` value across rounds —
 *    G8's injected-clock pin drives the guard through this seam, and the
 *    runner pins one instant per turn (advancing 60s per turn) precisely so
 *    elapsed time is deterministic under the harness.
 *
 * 5. OBSERVATIONS — return rounds/intent/ledger per CognitiveTurnOutcome so
 *    the runner can pin them (rounds may be omitted; the harness then falls
 *    back to the count of scripted cognitive rounds consumed).
 */
export type CognitiveTurnFn = (
  deps: SinglePathConversationDeps,
  input: InboundConversationMessage,
) => Promise<CognitiveTurnOutcome>;

/** §22: capabilities a scenario requires — its declared `requires` plus,
 * for path: "single", the `cognitive_turn` probe key (satisfied once core
 * exports the loop per the contract above; until then single-path
 * scenarios skip cleanly, exactly like the existing requires: pattern). */
export function requiredCapabilities(scenario: Scenario): readonly string[] {
  if (scenario.path !== "single") return scenario.requires;
  return [...new Set([...scenario.requires, "cognitive_turn"])];
}

/** §22: normalize the entry's ledger entries to {opType, status}. */
function normalizeLedger(
  entries: readonly Record<string, unknown>[] | undefined,
): readonly LedgerEntryObservation[] {
  if (entries === undefined) return [];
  return entries.map((entry) => ({
    opType: String(entry["opType"] ?? entry["type"] ?? entry["op_type"] ?? "unknown"),
    status: String(entry["status"] ?? "unknown"),
  }));
}

export interface ExpectationContext {
  /** True when at least one expect_one db pin found its row — i.e. the
   * scenario demonstrated a durable write, which is what licenses a
   * persistence claim in the reply (§5-15). */
  readonly writeEvidence?: boolean;
}

/** Marker-count helper for the C11 audit_markers pin: deterministic markers
 * observed across every turn of the scenario. */
function markerCount(markers: readonly string[], marker: string): number {
  return markers.filter((observed) => observed === marker).length;
}

export function checkExpectations(
  expectations: ScenarioExpectations,
  turns: readonly TurnObservation[],
  ctx: ExpectationContext = {},
): string[] {
  const failures: string[] = [];
  const lastTurn = turns.at(-1) ?? null;
  if (lastTurn === null) {
    failures.push("scenario produced no turn observations");
    return failures;
  }
  if (!lastTurn.replied || lastTurn.reply === null) {
    failures.push(`final turn produced no reply (${lastTurn.replyReason ?? "no notification"})`);
  } else {
    for (const needle of expectations.replyContains ?? []) {
      if (!lastTurn.reply.includes(needle)) failures.push(`reply missing "${needle}"`);
    }
    for (const needle of expectations.replyNotContains ?? []) {
      if (lastTurn.reply.includes(needle)) failures.push(`reply contains "${needle}"`);
    }
    if (expectations.noPersistenceClaimWithoutWrite === true) {
      const claim = persistenceClaimIn(lastTurn.reply);
      if (claim !== null && ctx.writeEvidence !== true) {
        failures.push(
          `persistence claim "${claim}" without a durable write (no db write pin passed)`,
        );
      }
    }
  }
  // C11: machinery/canned-ack needles must be absent from EVERY delivered
  // reply, not just the final one (hijack scenarios repeat the ack).
  for (const [index, observation] of turns.entries()) {
    if (observation.reply === null) continue;
    for (const needle of expectations.everyTurnNotContains ?? []) {
      if (observation.reply.includes(needle)) {
        failures.push(`turn ${index + 1} reply contains "${needle}"`);
      }
    }
  }
  if (expectations.auditMarkers !== undefined) {
    const allMarkers = turns.flatMap((observation) => observation.auditMarkers);
    for (const pin of expectations.auditMarkers) {
      const count = markerCount(allMarkers, pin.marker);
      if (pin.expectOne && count !== 1) {
        failures.push(`audit marker "${pin.marker}" expected exactly once across the scenario, got ${count}`);
      }
      if (pin.expectZero && count > 0) {
        failures.push(`audit marker "${pin.marker}" terminal reply occurred ${count} time(s) — expected none`);
      }
    }
  }
  if (
    expectations.answerPromptContains !== undefined ||
    expectations.answerPromptNotContains !== undefined
  ) {
    const prompts = lastTurn.answerPrompts.join("\n");
    if (prompts.length === 0) {
      failures.push("answer prompt pins set but the final turn dispatched no answer pass");
    } else {
      for (const needle of expectations.answerPromptContains ?? []) {
        if (!prompts.includes(needle)) failures.push(`answer prompt missing "${needle}"`);
      }
      for (const needle of expectations.answerPromptNotContains ?? []) {
        if (prompts.includes(needle)) failures.push(`answer prompt contains "${needle}"`);
      }
    }
  }
  if (expectations.interpretAudits !== undefined) {
    const audits = lastTurn.interpretation.audits;
    if (audits !== expectations.interpretAudits) {
      failures.push(
        `expected ${expectations.interpretAudits} interpret audit row(s) on the final turn, got ${audits}`,
      );
    }
  }
  for (const tool of expectations.routedTools ?? []) {
    if (!lastTurn.routedTools.includes(tool)) {
      failures.push(`expected tool ${tool} not routed (routed: [${lastTurn.routedTools.join(", ")}])`);
    }
  }
  if (expectations.routedNone === true && lastTurn.routedTools.length > 0) {
    failures.push(`expected no tools routed, got [${lastTurn.routedTools.join(", ")}]`);
  }
  // §22 single-path observations (final turn; the legacy path observes an
  // empty ledger / 0 rounds / null intent, so these pins fail there rather
  // than silently passing).
  failures.push(...ledgerContainsFailures(expectations.ledgerContains ?? [], lastTurn.ledger));
  failures.push(
    ...roundsBoundFailures(lastTurn.rounds, {
      atLeast: expectations.roundsAtLeast,
      atMost: expectations.roundsAtMost,
    }),
  );
  if (expectations.intentIs !== undefined) {
    const failure = intentIsFailure(expectations.intentIs, lastTurn.intent);
    if (failure !== null) failures.push(failure);
  }
  return failures;
}

export interface PinRun {
  readonly failures: readonly string[];
  /** True when an expect_one pin found its row — evidence of a durable write. */
  readonly writeEvidence: boolean;
}

async function runPins(runSql: SqlRunner, pins: readonly DbPin[]): Promise<PinRun> {
  const failures: string[] = [];
  let writeEvidence = false;
  for (const pin of pins) {
    let rows: readonly Record<string, unknown>[];
    try {
      rows = await runSql(pin.sql);
    } catch (err) {
      failures.push(`db pin query failed (${pin.sql}): ${err instanceof Error ? err.message : "query error"}`);
      continue;
    }
    if (pin.expectOne && rows.length !== 1) {
      failures.push(`db pin expected exactly 1 row, got ${rows.length} (${pin.sql})`);
    }
    if (pin.expectZero && rows.length !== 0) {
      failures.push(`db pin expected 0 rows, got ${rows.length} (${pin.sql})`);
    }
    if (pin.expectOne && rows.length >= 1) writeEvidence = true;
  }
  return { failures, writeEvidence };
}

export async function evaluatePins(
  runSql: SqlRunner,
  pins: readonly DbPin[],
): Promise<readonly string[]> {
  return (await runPins(runSql, pins)).failures;
}

async function toolUsedCount(pool: ConversationDeps["db"]): Promise<number> {
  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'imessage.converse.tool_used'`,
  );
  return Number(rows.rows[0]?.["n"] ?? 0);
}

async function toolsUsedSince(pool: ConversationDeps["db"], offset: number): Promise<string[]> {
  const rows = await pool.query(
    `SELECT (outputs_ref::jsonb)->>'tool' AS tool FROM audit_log WHERE action = 'imessage.converse.tool_used'`,
  );
  return rows.rows.slice(offset).map((row) => String(row["tool"]));
}

/** W6(a/R8) observation: `imessage.converse.interpret` audit rows the
 * orchestrator emits for the interpreter, sliced to this turn's window. */
async function interpretationsSince(
  pool: ConversationDeps["db"],
  offset: number,
): Promise<InterpretationObservation> {
  const rows = await pool.query(
    `SELECT outputs_ref::jsonb AS payload FROM audit_log WHERE action = 'imessage.converse.interpret'`,
  );
  const slice = rows.rows.slice(offset);
  return { audits: slice.length, payloads: slice.map((row) => row["payload"]) };
}

/** C11 observation: deterministic markers on `imessage.converse.replied`
 * rows (outputs_ref->deterministic), sliced to this turn's window. Model
 * replies audit without the key, so they never appear here. */
async function replyMarkersSince(
  pool: ConversationDeps["db"],
  offset: number,
): Promise<readonly string[]> {
  const rows = await pool.query(
    `SELECT (outputs_ref::jsonb)->>'deterministic' AS marker FROM audit_log WHERE action = 'imessage.converse.replied'`,
  );
  return rows.rows
    .slice(offset)
    .map((row) => row["marker"])
    .filter((marker): marker is string => typeof marker === "string");
}

async function repliedRowCount(pool: ConversationDeps["db"]): Promise<number> {
  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'imessage.converse.replied'`,
  );
  return Number(rows.rows[0]?.["n"] ?? 0);
}

/** C11 seed: open the nightly calibration item via the calibration service
 * (the same call the nightly workflow makes), with prompt_sent_at stamped by
 * the seed — the miss-eligibility window anchors on it. */
async function seedCalibration(
  pool: ConversationDeps["db"],
  opts: { readonly principalId: string; readonly promptSentAt: string },
): Promise<void> {
  const sentAt = new Date(opts.promptSentAt);
  const periodDate = civilDateOf(sentAt);
  await openCalibrationItem(pool, {
    principalId: opts.principalId,
    periodDate,
    summary: { kind: "calibration", day: periodDate, entries: [] },
    surface: "imessage",
    now: () => sentAt,
  });
}

/** C11 seed: gmail_messages rows (ADR-0016 content store) for the C4
 * content read tools. principal_id carries the principal NAME — the table's
 * own convention (default 'josctl'). internal_date/ingested_at land
 * age_hours before the scenario clock so fixtures stay inside retention. */
async function seedGmail(
  pool: ConversationDeps["db"],
  opts: {
    readonly principalName: string;
    readonly anchor: Date;
    readonly messages: readonly {
      readonly from: string;
      readonly subject: string;
      readonly body: string;
      readonly ageHours: number;
    }[];
  },
): Promise<void> {
  for (const [index, message] of opts.messages.entries()) {
    const at = new Date(opts.anchor.getTime() - message.ageHours * 3_600_000).toISOString();
    await pool.query(
      `INSERT INTO gmail_messages
         (id, gmail_message_id, thread_id, principal_id, domain_id, from_addr, to_addrs,
          subject, snippet, body_text, body_bytes, internal_date, ingested_at)
       VALUES ($1, $2, $3, $4, 'personal', $5, '[]'::jsonb, $6, $7, $8, $9, $10::timestamptz, $10::timestamptz)`,
      [
        randomUUID(),
        `eval-gmail-${opts.principalName}-${index}`,
        `eval-gmail-thread-${index}`,
        opts.principalName,
        message.from,
        message.subject,
        message.body.slice(0, 120),
        message.body,
        Buffer.byteLength(message.body, "utf8"),
        at,
      ],
    );
  }
}

async function replyContent(pool: ConversationDeps["db"], notificationId: string): Promise<string | null> {
  const rows = await pool.query(
    `SELECT payload->>'content' AS c FROM notifications WHERE id = $1::uuid`,
    [notificationId],
  );
  const content = rows.rows[0]?.["c"];
  return typeof content === "string" ? content : null;
}

async function ensurePrincipal(
  pool: ConversationDeps["db"],
  name: string,
  handle: string,
): Promise<string> {
  const existing = await pool.query(`SELECT id FROM principals WHERE name = $1`, [name]);
  const existingId = existing.rows[0]?.["id"];
  let principalId = existingId === undefined ? null : String(existingId);
  if (principalId === null) {
    const inserted = await pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id`,
      [name],
    );
    principalId = String(inserted.rows[0]!["id"]);
  }
  const identity = await pool.query(`SELECT 1 FROM transport_identities WHERE handle = $1`, [handle]);
  if (identity.rows.length === 0) {
    const session = await pool.query(
      `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, expires_at)
       VALUES ($1::uuid, 'pair', $2, now() + interval '5 minutes') RETURNING id`,
      [principalId, "d".repeat(64)],
    );
    await pool.query(
      `INSERT INTO transport_identities (principal_id, transport, handle, verified_at, last_seen_at, paired_via_session)
       VALUES ($1::uuid, 'imessage', $2, now(), now(), $3::uuid)`,
      [principalId, handle, session.rows[0]!["id"]],
    );
  }
  return principalId;
}

async function runScenario(
  pool: ConversationDeps["db"],
  ctx: {
    readonly scenario: Scenario;
    readonly principalId: string;
    readonly principalName: string;
    readonly handle: string;
    readonly domainId: string;
    /** §22: the single-path turn entry (guaranteed present for
     * path: "single" — the caller skips those scenarios without one). */
    readonly cognitiveTurn: CognitiveTurnFn;
  },
): Promise<ScenarioResult> {
  const { scenario, principalId, principalName, handle, domainId } = ctx;
  // C11: per-scenario clock override (the 2026-09-21 default anchor stays
  // for scenarios that do not carry one).
  const anchor = new Date(scenario.clock ?? ANCHOR_ISO);
  await issueGrant(pool, {
    principalId,
    runId: null,
    capability: CONVERSE_CAPABILITY,
    resource: "imessage",
    domainId,
    expiresAt: new Date(anchor.getTime() + GRANT_WINDOW_MS),
  });
  if (scenario.seed?.calibrationItem !== undefined) {
    await seedCalibration(pool, {
      principalId,
      promptSentAt: scenario.seed.calibrationItem.promptSentAt,
    });
  }
  if (scenario.seed?.gmailMessages !== undefined && scenario.seed.gmailMessages.length > 0) {
    await seedGmail(pool, {
      principalName,
      anchor,
      messages: scenario.seed.gmailMessages,
    });
  }
  if (scenario.seed?.pendingProposal !== undefined) {
    const seeded = scenario.seed.pendingProposal;
    const { resolveActiveThread } = await import("@jehad/core");
    const thread = await resolveActiveThread(pool, {
      principalId,
      surface: "imessage",
      now: anchor,
    });
    const { setThreadPendingProposals } = await import("@jehad/core");
    await setThreadPendingProposals(pool, {
      threadId: thread.id,
      principalId,
      pending: [
        {
          type: seeded.type as never,
          at: anchor.toISOString(),
          payload: seeded.payload,
          offered: seeded.offered ?? "seeded fixture offer",
          id: seeded.id,
          expiresAt: new Date(anchor.getTime() + 24 * 60 * 60_000).toISOString(),
          parkedAtSeq: 0,
        },
      ],
      now: anchor,
    });
  }

  const knownPrincipals = new Set([scenario.principal]);
  const observations: TurnObservation[] = [];
  let scenarioNow = new Date(anchor.getTime());
  const single = scenario.path === "single";
  // §22.15(b): the scenario-level read-override queue, shared across the
  // scenario's turns (consumed in order per tool — see ReadOverrideQueue).
  const readOverrides = new ReadOverrideQueue(scenario.readOverrides ?? []);
  for (const turn of scenario.turns) {
    const before = await toolUsedCount(pool);
    const beforeInterpretations = (
      await pool.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'imessage.converse.interpret'`,
      )
    ).rows[0];
    const beforeReplied = await repliedRowCount(pool);
    // §22: legacy scripts classify by prompt marker; single-path scripts are
    // consumed by round index (script order IS dispatch order).
    const dispatch = single
      ? singlePathDispatch(turn.modelScript)
      : scriptedDispatch(turn.modelScript);
    const provider = new FakeModelProvider({ respond: dispatch.responder });
    // CLOCK SEAM (§22.5 wall guard, G8's injected-clock pin): `now` is
    // pinned to one scenario instant per turn (advanced TURN_STEP_MS per
    // turn) and threaded through deps. The single path's wall guard MUST
    // read `deps.now?.()` fresh at each round boundary — never Date.now(),
    // never a value captured once at turn start — so the harness clock
    // deterministically drives the >20s forced-final boundary.
    const deps: SinglePathConversationDeps = {
      db: pool,
      provider,
      registry: REGISTRY,
      principalPolicy: (name) => (knownPrincipals.has(name) ? PRINCIPAL_POLICY : null),
      now: () => scenarioNow,
      ...(single ? { readOverrides } : {}),
    };
    const input = { principalId, handle, text: turn.user };
    const outcome = single
      ? await ctx.cognitiveTurn(deps, input)
      : await handleInbound(deps, input);
    const routedTools = await toolsUsedSince(pool, before);
    const interpretation = await interpretationsSince(pool, Number(beforeInterpretations?.["n"] ?? 0));
    const auditMarkers = await replyMarkersSince(pool, beforeReplied);
    const reply = outcome.notificationId !== undefined ? await replyContent(pool, outcome.notificationId) : null;
    const passes = single
      ? dispatch.kinds()
      : provider.requests.map((request) => passKindOf(request.prompt));
    const answerPrompts = single
      ? []
      : provider.requests
          .filter((request) => passKindOf(request.prompt) === "answer")
          .map((request) => request.prompt);
    const singleOutcome = single ? (outcome as CognitiveTurnOutcome) : null;
    const issues = [...dispatch.mismatches()];
    if (dispatch.consumed() !== turn.modelScript.length) {
      issues.push(`${turn.modelScript.length - dispatch.consumed()} scripted pass(es) never dispatched`);
    }
    observations.push({
      user: turn.user,
      replied: outcome.replied,
      replyReason: outcome.reason ?? null,
      reply,
      routedTools,
      passes,
      interpretation,
      auditMarkers,
      answerPrompts,
      ledger: normalizeLedger(singleOutcome?.ledger),
      // Authoritative when the entry reports rounds; otherwise fall back to
      // the scripted cognitive rounds actually consumed.
      rounds:
        singleOutcome?.rounds ??
        (single ? dispatch.kinds().filter((kind) => kind === "cognitive").length : 0),
      intent: singleOutcome?.intent ?? null,
      scriptIssues: issues,
    });
    scenarioNow = new Date(scenarioNow.getTime() + TURN_STEP_MS);
  }

  const failures: string[] = [];
  for (const [index, observation] of observations.entries()) {
    for (const issue of observation.scriptIssues) {
      failures.push(`turn ${index + 1} modelScript: ${issue}`);
    }
  }
  const pinRun = await runPins(
    async (sql) => (await pool.query(sql)).rows as readonly Record<string, unknown>[],
    scenario.expectations.dbPins ?? [],
  );
  failures.push(...pinRun.failures);
  failures.push(
    ...checkExpectations(scenario.expectations, observations, {
      writeEvidence: pinRun.writeEvidence,
    }),
  );
  return { id: scenario.id, status: failures.length === 0 ? "pass" : "fail", reason: null, failures, turns: observations };
}

function tally(results: readonly ScenarioResult[]): ConversationEvalRun["counts"] {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  for (const result of results) {
    if (result.status === "pass") pass += 1;
    else if (result.status === "fail") fail += 1;
    else skip += 1;
  }
  return { pass, fail, skip };
}

export async function runConversationEval(options: ConversationEvalOptions): Promise<ConversationEvalRun> {
  const probes = options.capabilityProbes ?? {};
  const db = await createIsolatedTestDb(options.databaseUrl, options.dbTag ?? "conv_eval");
  const results: ScenarioResult[] = [];
  try {
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    const domainId = String(domain.rows[0]!["id"]);
    const principals = new Map<string, { id: string; handle: string }>();
    let handleIndex = 0;
    for (const scenario of options.scenarios) {
      // §22: single-path scenarios implicitly require the cognitive_turn
      // capability (core's cognitive-loop export per the contract above).
      const missing = requiredCapabilities(scenario).filter((capability) => !probes[capability]);
      if (missing.length > 0) {
        results.push({
          id: scenario.id,
          status: "skip",
          reason: `capability not available: ${missing.join(", ")}`,
          failures: [],
          turns: [],
        });
        continue;
      }
      if (scenario.path === "single" && options.cognitiveTurn === undefined) {
        // Probe passed but no entry was supplied (CLI resolves it from
        // core; tests inject a fake). Skip rather than crash.
        results.push({
          id: scenario.id,
          status: "skip",
          reason: "single-path cognitive turn entry not resolved",
          failures: [],
          turns: [],
        });
        continue;
      }
      let principal = principals.get(scenario.principal);
      if (principal === undefined) {
        const handle = `+1555000${1001 + handleIndex}`;
        handleIndex += 1;
        principal = { id: await ensurePrincipal(db.pool, scenario.principal, handle), handle };
        principals.set(scenario.principal, principal);
      }
      await db.pool.query(CLEANUP_SQL);
      results.push(
        await runScenario(db.pool, {
          scenario,
          principalId: principal.id,
          principalName: scenario.principal,
          handle: principal.handle,
          domainId,
          cognitiveTurn: options.cognitiveTurn!,
        }),
      );
    }
  } finally {
    await dropIsolatedTestDb(options.databaseUrl, db);
  }
  return { results, counts: tally(results) };
}
