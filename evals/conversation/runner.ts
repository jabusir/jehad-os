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
import type { ConversationDeps, GatewayPrincipalPolicy } from "@jehad/core";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb } from "../../packages/db/tests/test-db.js";
import { persistenceClaimIn } from "./assertions.js";
import type { DbPin, Scenario, ScenarioExpectations } from "./scenarios.js";

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
  readonly passes: readonly ("route" | "interpret" | "answer")[];
  readonly interpretation: InterpretationObservation;
  /** C11: deterministic markers on this turn's `imessage.converse.replied`
   * audit rows (outputs_ref->deterministic; model replies carry none). */
  readonly auditMarkers: readonly string[];
  /** C11: prompts dispatched as the answer pass this turn (prompt-level pins:
   * persona fragment, self-brief). */
  readonly answerPrompts: readonly string[];
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
}

export function scriptedDispatch(
  script: readonly { readonly pass: string; readonly output: string }[],
): ScriptedDispatch {
  const mismatches: string[] = [];
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
      return { text: scripted.output };
    },
    mismatches: () => mismatches,
    consumed: () => index,
  };
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

  const knownPrincipals = new Set([scenario.principal]);
  const observations: TurnObservation[] = [];
  let scenarioNow = new Date(anchor.getTime());
  for (const turn of scenario.turns) {
    const before = await toolUsedCount(pool);
    const beforeInterpretations = (
      await pool.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'imessage.converse.interpret'`,
      )
    ).rows[0];
    const beforeReplied = await repliedRowCount(pool);
    const script = scriptedDispatch(turn.modelScript);
    const provider = new FakeModelProvider({ respond: script.responder });
    const deps: ConversationDeps = {
      db: pool,
      provider,
      registry: REGISTRY,
      principalPolicy: (name) => (knownPrincipals.has(name) ? PRINCIPAL_POLICY : null),
      now: () => scenarioNow,
    };
    const outcome = await handleInbound(deps, { principalId, handle, text: turn.user });
    const routedTools = await toolsUsedSince(pool, before);
    const interpretation = await interpretationsSince(pool, Number(beforeInterpretations?.["n"] ?? 0));
    const auditMarkers = await replyMarkersSince(pool, beforeReplied);
    const reply = outcome.notificationId !== undefined ? await replyContent(pool, outcome.notificationId) : null;
    const passes = provider.requests.map((request) => passKindOf(request.prompt));
    const answerPrompts = provider.requests
      .filter((request) => passKindOf(request.prompt) === "answer")
      .map((request) => request.prompt);
    const issues = [...script.mismatches()];
    if (script.consumed() !== turn.modelScript.length) {
      issues.push(`${turn.modelScript.length - script.consumed()} scripted pass(es) never dispatched`);
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
      const missing = scenario.requires.filter((capability) => !probes[capability]);
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
        }),
      );
    }
  } finally {
    await dropIsolatedTestDb(options.databaseUrl, db);
  }
  return { results, counts: tally(results) };
}
