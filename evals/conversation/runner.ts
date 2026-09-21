import { FakeModelProvider } from "@jehad/adapters";
import type { ModelRequest, ModelResult } from "@jehad/adapters";
import {
  CONVERSE_CAPABILITY,
  ModelEgressPolicyRegistry,
  handleInbound,
  issueGrant,
} from "@jehad/core";
import type { ConversationDeps, GatewayPrincipalPolicy } from "@jehad/core";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb } from "../../packages/db/tests/test-db.js";
import type { DbPin, Scenario, ScenarioExpectations } from "./scenarios.js";

export type CapabilityProbes = Readonly<Record<string, boolean>>;

export interface TurnObservation {
  readonly user: string;
  readonly replied: boolean;
  readonly replyReason: string | null;
  readonly reply: string | null;
  readonly routedTools: readonly string[];
  readonly passes: readonly ("route" | "answer")[];
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
  reads: ["calendar", "commitments", "gmail", "state"],
};

const CLEANUP_SQL = `
  DELETE FROM feedback; DELETE FROM calibration_items;
  DELETE FROM memory_candidates;
  DELETE FROM interaction_messages; DELETE FROM interaction_threads;
  DELETE FROM audit_log; DELETE FROM review_refs;
  DELETE FROM action_attempts; DELETE FROM action_intents;
  DELETE FROM model_calls; DELETE FROM runs; DELETE FROM notifications;
  DELETE FROM capability_grants WHERE capability = 'imessage:converse';
`;

export function passKindOf(prompt: string): "route" | "answer" {
  return prompt.includes(ROUTE_PROMPT_MARKER) ? "route" : "answer";
}

interface ScriptedDispatch {
  readonly responder: (request: ModelRequest) => ModelResult;
  readonly mismatches: () => readonly string[];
  readonly consumed: () => number;
}

function scriptedDispatch(script: readonly { readonly pass: string; readonly output: string }[]): ScriptedDispatch {
  const mismatches: string[] = [];
  let index = 0;
  return {
    responder: (request: ModelRequest): ModelResult => {
      const actual = passKindOf(request.prompt);
      const scripted = script[index];
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

export function checkExpectations(
  expectations: ScenarioExpectations,
  lastTurn: TurnObservation | null,
): string[] {
  const failures: string[] = [];
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

export async function evaluatePins(runSql: SqlRunner, pins: readonly DbPin[]): Promise<string[]> {
  const failures: string[] = [];
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
  }
  return failures;
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
    readonly handle: string;
    readonly domainId: string;
  },
): Promise<ScenarioResult> {
  const { scenario, principalId, handle, domainId } = ctx;
  const anchor = new Date(ANCHOR_ISO);
  await issueGrant(pool, {
    principalId,
    runId: null,
    capability: CONVERSE_CAPABILITY,
    resource: "imessage",
    domainId,
    expiresAt: new Date(anchor.getTime() + GRANT_WINDOW_MS),
  });

  const knownPrincipals = new Set([scenario.principal]);
  const observations: TurnObservation[] = [];
  let scenarioNow = new Date(anchor.getTime());
  for (const turn of scenario.turns) {
    const before = await toolUsedCount(pool);
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
    const reply = outcome.notificationId !== undefined ? await replyContent(pool, outcome.notificationId) : null;
    const passes = provider.requests.map((request) => passKindOf(request.prompt));
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
  failures.push(
    ...(await evaluatePins(
      async (sql) => (await pool.query(sql)).rows as readonly Record<string, unknown>[],
      scenario.expectations.dbPins ?? [],
    )),
  );
  failures.push(...checkExpectations(scenario.expectations, observations.at(-1) ?? null));
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
      results.push(await runScenario(db.pool, { scenario, principalId: principal.id, handle: principal.handle, domainId }));
    }
  } finally {
    await dropIsolatedTestDb(options.databaseUrl, db);
  }
  return { results, counts: tally(results) };
}
