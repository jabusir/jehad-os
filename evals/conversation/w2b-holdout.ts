// W2b — OWNER-AUTHORED BLIND HOLDOUT runner (holdout-v2.yaml,
// sha256 e42f4f8cd9938ac1f9cb29ab0f2d446f90133400d06bfedd946b01904473dfdb;
// freeze 2ae3585). Same production-fidelity machinery as semantic-live.ts
// (isolated DB world, metered provider with transient retry, majority-of-3
// production judge, per-case reset) — but the EXPECTATIONS are the owner's
// v2 shapes, scored on semantic outcome + canonical effect, never on
// identical internal tool choices.
//
// CLI:
//   tsx evals/conversation/w2b-holdout.ts --driver A|B [--label X] [--ceiling N]
// A = envelope (repo policy), B = native (native fixture policy).
// Requires TEST_DATABASE_URL + OPENROUTER_API_KEY. Refuses to start when
// the provider balance is below MIN_BALANCE_USD (never run to the
// affordability boundary — owner directive).

import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createOpenRouterProvider } from "@jehad/adapters";
import type { ChatRequest, ChatResult, ModelProvider, ModelRequest, ModelResult } from "@jehad/adapters";
import {
  ModelEgressPolicyRegistry,
  buildVerificationPrompt,
  callModel,
  createReminder,
  executeOperation,
  executeReadTool,
  handleInbound,
  loadRepoPolicy,
  parseVerificationVerdict,
  resolveActiveThread,
  setThreadPendingProposals,
  collectWorkState,
  renderWorkSnapshotText,
} from "@jehad/core";
import type { CognitiveOperation, LedgerEntry, OperationResult } from "@jehad/core";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb } from "../../packages/db/tests/test-db.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "out");
const HOLDOUT_FILE = path.join(HERE, "holdout-v2.yaml");
const HOLDOUT_SHA256 = "e42f4f8cd9938ac1f9cb29ab0f2d446f90133400d06bfedd946b01904473dfdb";
const NATIVE_FIXTURE_POLICY = path.join(HERE, "..", "..", "packages/core/src/imessage/native-test.policy.yaml");
const SPEND_CEILING_USD = 1.2;
const MIN_BALANCE_USD = 2.5;
const NOW = new Date("2026-09-25T17:00:00.000Z"); // 10:00 AM PDT Friday
const TOMORROW = "2026-09-26";
const PRINCIPAL_NAME = "josctl";
const JUDGE_MODEL_FALLBACK = "openai/gpt-4.1";

// Common-control set for W2b (mirrors the dev corpus's cc classes present
// in the holdout). calendar_today is scored but flagged deferred-surface
// for B (no calendar read tool in the W1 spike — a known, ratified gap).
const W2B_COMMON_CONTROL = new Set([
  "reminder_create", "reminder_datetime", "commitment_done", "commitment_missed",
  "task_capture", "offer_apply", "offer_decline", "list_commitments",
  "calendar_today", "gmail_search", "delegate_intent", "delegate_confirm",
]);

function parseArgv(argv: readonly string[]): { options: Map<string, string> } {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--driver" || arg === "--label" || arg === "--ceiling") {
      options.set(arg.slice(2), argv[i + 1] ?? "");
      i += 1;
    }
  }
  return { options };
}

function resolveApiKey(): string {
  if ((process.env.OPENROUTER_API_KEY ?? "").trim().length > 0) return process.env.OPENROUTER_API_KEY!;
  try {
    const envText = readFileSync(path.join(HERE, "..", "..", ".env"), "utf8");
    const match = envText.match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (match !== null && match[1]!.trim().length > 0) return match[1]!.trim();
  } catch { /* fallthrough */ }
  try {
    return execSync("launchctl getenv OPENROUTER_API_KEY", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

async function providerBalance(apiKey: string): Promise<number> {
  const response = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const body = (await response.json()) as { data?: { total_credits?: number; total_usage?: number } };
  return (body.data?.total_credits ?? 0) - (body.data?.total_usage ?? 0);
}

// ------------------------------------------------------------------ corpus

interface V2Case {
  id: string;
  behavior: string;
  seed?: {
    commitments?: string[];
    calendar?: { summary: string; time: string }[];
    gmail?: { from: string; subject: string; body: string }[];
    pending_items?: string[];
    outcome?: { title: string; status: string };
    history?: string[];
    canonical_outcomes?: unknown[];
  };
  user?: string;
  turns?: { user: string }[];
  expect: Record<string, unknown>;
}

function loadHoldout(): V2Case[] {
  const raw = parse(readFileSync(HOLDOUT_FILE, "utf8")) as { version: number; cases: V2Case[] };
  if (raw.version !== 2) throw new Error(`holdout: version must be 2, got ${String(raw.version)}`);
  return raw.cases;
}

// ------------------------------------------------------------------ runner

interface CaseObservation {
  id: string;
  behavior: string;
  commonControl: boolean;
  shipped: boolean;
  verified: string;
  reply: string | null;
  reads: string[];
  ops: { type: string; status: string }[];
  invalidToolCalls: number;
  modelCalls: number;
  checks: Record<string, boolean>;
  failures: string[];
  judgeUnavailable?: boolean;
  costUsd: number;
  latencyMs: number;
  turnLatencyMs?: number;
  turnPhases?: { cognitionMs: number; toolsMs: number; verifyMs: number };
}

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

function containsAll(haystack: string | null, needles: readonly string[]): boolean {
  if (haystack === null) return false;
  const flat = haystack.toLowerCase();
  return needles.every((n) => flat.includes(n.toLowerCase()));
}

async function main(): Promise<void> {
  const { options } = parseArgv(process.argv.slice(2));
  const driver = options.get("driver") === "B" ? "B" : "A";
  const label = options.get("label") ?? `w2b-${driver}`;
  const ceiling = options.get("ceiling") !== undefined ? Number(options.get("ceiling")) : SPEND_CEILING_USD;

  const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
  const apiKey = resolveApiKey();
  if (databaseUrl === "") throw new Error("TEST_DATABASE_URL is required");
  if (apiKey === "") throw new Error("OPENROUTER_API_KEY is not set");

  if (driver === "B" && process.env.POLICY_YAML_PATH === undefined) {
    process.env.POLICY_YAML_PATH = NATIVE_FIXTURE_POLICY;
  }

  const balance = await providerBalance(apiKey);
  console.log(`provider balance $${balance.toFixed(2)} (min start ${MIN_BALANCE_USD})`);
  if (balance < MIN_BALANCE_USD) {
    throw new Error(`W2b refuses to start: balance $${balance.toFixed(2)} < $${MIN_BALANCE_USD} — top up first (owner directive: never run to the affordability boundary)`);
  }

  const judgeModel = process.env.JUDGE_MODEL ?? (await loadRepoPolicy()).policy?.gateway?.passes?.route?.model ?? JUDGE_MODEL_FALLBACK;
  const cases = loadHoldout();

  const db = await createIsolatedTestDb(databaseUrl, `w2b_${Date.now() % 100000}`);
  const registry = new ModelEgressPolicyRegistry([
    { id: "personal-normal-openrouter", domainId: "personal", sensitivity: "normal", allowedProviders: ["openrouter"], allowRemote: false, requireRedaction: false },
  ]);

  let spend = 0;
  const real = createOpenRouterProvider({ apiKey });
  async function completeWithRetry(request: ModelRequest): Promise<ModelResult> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await real.complete(request);
        spend += result.usage?.costUsd ?? 0;
        return result;
      } catch (err) { lastError = err; await new Promise((r) => setTimeout(r, 900 * (attempt + 1))); }
    }
    throw lastError;
  }
  async function chatWithRetry(request: ChatRequest): Promise<ChatResult> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await real.chat!(request);
        spend += result.usage?.costUsd ?? 0;
        return result;
      } catch (err) { lastError = err; await new Promise((r) => setTimeout(r, 900 * (attempt + 1))); }
    }
    throw lastError;
  }
  const metered: ModelProvider = {
    id: "openrouter",
    complete: (request) => completeWithRetry(request),
    chat: (request) => chatWithRetry(request),
  };

  await migrateUp(db.pool);
  await seedDomains(db.pool);
  const domainId = String((await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`)).rows[0]!.id);
  await db.pool.query(
    `INSERT INTO principals (type, name) VALUES ('user', $1) ON CONFLICT (name) DO NOTHING RETURNING id`,
    [PRINCIPAL_NAME],
  );
  const cachedPrincipalId = String(
    (await db.pool.query(`SELECT id FROM principals WHERE name = $1`, [PRINCIPAL_NAME])).rows[0]!.id,
  );
  await db.pool.query(
    `INSERT INTO capability_grants (principal_id, capability, resource, domain_id, expires_at, token_hash)
     VALUES ($1::uuid, 'imessage:converse', 'imessage', $2::uuid, $3::timestamptz, $4)`,
    [cachedPrincipalId, domainId, new Date(NOW.getTime() + 86_400_000).toISOString(), "w2b-holdout"],
  );

  const repoPolicy = (await loadRepoPolicy()).policy;
  const observations: CaseObservation[] = [];

  for (const c of cases) {
    if (spend > ceiling) {
      console.error(`spend ceiling $${ceiling} reached — stopping before ${c.id}`);
      break;
    }
    await db.pool.query(`
      DELETE FROM model_calls; DELETE FROM notifications; DELETE FROM reminders;
      DELETE FROM assignments; DELETE FROM outcome_criteria; DELETE FROM outcomes;
      DELETE FROM commitments; DELETE FROM calendar_events; DELETE FROM events;
      DELETE FROM interaction_messages; DELETE FROM interaction_threads;
      DELETE FROM memory_candidates; DELETE FROM audit_log;
      DELETE FROM runs; DELETE FROM gmail_messages; TRUNCATE interaction_profiles;
    `);

    const pool = db.pool as Pool;
    // ---- seeds
    for (const description of c.seed?.commitments ?? []) {
      const eventId = randomUUID();
      await pool.query(
        `INSERT INTO events (id, type, source, occurred_at, idempotency_key, domain_id, payload, sensitivity, schema_version)
         VALUES ($1::uuid, 'commitment.created', 'w2b-seed', $2::timestamptz, $3, $4::uuid, '{}', 'normal', 1)`,
        [eventId, NOW.toISOString(), randomUUID(), domainId],
      );
      await pool.query(
        `INSERT INTO commitments (direction, counterparty_text, description, confidence, status, source_event_id, domain_id, created_at, updated_at)
         VALUES ('i_owe', 'someone', $1, 0.9, 'open', $2::uuid, $3::uuid, $4::timestamptz, $4::timestamptz)`,
        [description, eventId, domainId, NOW.toISOString()],
      );
    }
    for (const event of c.seed?.calendar ?? []) {
      const eventId = randomUUID();
      await pool.query(
        `INSERT INTO events (id, type, source, occurred_at, idempotency_key, domain_id, payload, sensitivity, schema_version)
         VALUES ($1::uuid, 'calendar.event.created', 'w2b-seed', $2::timestamptz, $3, $4::uuid, '{}', 'normal', 1)`,
        [eventId, NOW.toISOString(), randomUUID(), domainId],
      );
      const startIso = new Date(`${NOW.toISOString().slice(0, 10)}T${event.time}:00-07:00`).toISOString();
      await pool.query(
        `INSERT INTO calendar_events (id, google_event_id, google_calendar_id, status, summary, start_time, end_time,
           timezone, attendees, location, metadata, source_event_id, content_hash)
         VALUES ($1::uuid, $2, 'primary', 'confirmed', $3, $4::timestamptz, $5::timestamptz, NULL, '[]', NULL, '{}', $6::uuid, 'x')`,
        [randomUUID(), `evt-${randomUUID().slice(0, 8)}`, event.summary, startIso, new Date(new Date(startIso).getTime() + 3_600_000).toISOString(), eventId],
      );
    }
    await pool.query(`INSERT INTO calendar_sync_state (id, calendar_id, last_synced_at) VALUES (1, 'primary', $1::timestamptz)
                      ON CONFLICT (id) DO UPDATE SET last_synced_at = $1::timestamptz`, [NOW.toISOString()]);
    await pool.query(`INSERT INTO gmail_sync_state (id, last_tick_at) VALUES ('singleton', $1::timestamptz)
                      ON CONFLICT (id) DO UPDATE SET last_tick_at = $1::timestamptz`, [NOW.toISOString()]);
    for (const [index, message] of (c.seed?.gmail ?? []).entries()) {
      const at = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
      await pool.query(
        `INSERT INTO gmail_messages (id, gmail_message_id, thread_id, principal_id, domain_id, from_addr, to_addrs,
           subject, snippet, body_text, body_bytes, internal_date, ingested_at)
         VALUES ($1, $2, $3, $4, 'personal', $5, '[]'::jsonb, $6, $7, $8, $9, $10::timestamptz, $10::timestamptz)`,
        [randomUUID(), `w2b-${index}`, `w2b-thread-${index}`, cachedPrincipalId, message.from, message.subject, message.body.slice(0, 120), message.body, Buffer.byteLength(message.body, "utf8"), at],
      );
    }
    if (c.seed?.pending_items !== undefined) {
      const thread = await resolveActiveThread(pool as never, { principalId: cachedPrincipalId, surface: "imessage", now: NOW });
      await executeOperation(
        pool as never,
        { type: "task_batch", items: c.seed.pending_items.map((title) => ({ title, due: null })) },
        { principalId: cachedPrincipalId, principalName: PRINCIPAL_NAME, threadId: thread.id, now: NOW, calendarPolicy: null },
      );
    }
    if (c.seed?.outcome !== undefined) {
      await pool.query(
        `INSERT INTO outcomes (id, principal_id, ref, title, directive, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'w2b seeded work', $5, $6::timestamptz)`,
        [randomUUID(), cachedPrincipalId, "W2B" + Math.floor(Math.random() * 90 + 10), c.seed.outcome.title, c.seed.outcome.status, NOW.toISOString()],
      );
    }
    if ((c.seed?.history ?? []).length > 0) {
      const thread = await resolveActiveThread(pool as never, { principalId: cachedPrincipalId, surface: "imessage", now: NOW });
      let offset = 10;
      for (const content of c.seed!.history!) {
        offset += 2;
        await pool.query(
          `INSERT INTO interaction_messages (id, thread_id, principal_id, surface, direction, trust_class, content, token_estimate, received_at, expires_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'imessage', 'outbound', 'assistant_output', $4, 0, $5::timestamptz, $6::timestamptz)`,
          [randomUUID(), thread.id, cachedPrincipalId, content, new Date(NOW.getTime() - offset * 3_600_000).toISOString(), new Date(NOW.getTime() + 7 * 86_400_000).toISOString()],
        );
      }
    }

    const judgeRun = await pool.query(
      `INSERT INTO runs (kind, principal_id, status, intent, domain_id, started_at, ended_at, created_at, updated_at)
       VALUES ('harness', $1::uuid, 'completed', 'w2b judge', $2::uuid, $3::timestamptz, $3::timestamptz, $3::timestamptz, $3::timestamptz) RETURNING id`,
      [cachedPrincipalId, domainId, NOW.toISOString()],
    );
    const judgeRunId = String(judgeRun.rows[0]!.id);

    const executedReads: string[] = [];
    const observedOps: { op: CognitiveOperation; result: OperationResult }[] = [];
    let invalidToolCalls = 0;
    let modelCalls = 0;
    let caseCost = 0;
    const caseStart = Date.now();

    const deps = {
      db: db.pool,
      provider: {
        id: "openrouter",
        complete: async (request: ModelRequest): Promise<ModelResult> => {
          modelCalls += 1;
          const before = spend;
          const result = await completeWithRetry(request);
          caseCost += spend - before;
          return result;
        },
        chat: async (request: ChatRequest): Promise<ChatResult> => {
          modelCalls += 1;
          const before = spend;
          const result = await chatWithRetry(request);
          caseCost += spend - before;
          return result;
        },
      } as ModelProvider,
      registry,
      now: () => NOW,
      principalPolicy: (name: string) =>
        (repoPolicy?.gateway?.principals as Record<string, never> | undefined)?.[name] ?? null,
      outcomeDispatcher: async () => "w2b-executor",
      onOperation: (op: CognitiveOperation, result: OperationResult) => {
        observedOps.push({ op, result });
      },
      onReadExecuted: (tool: string) => {
        executedReads.push(tool);
      },
      onToolCall: (outcome: { tool: string; kind: string; status: string; modelNote: string; argsDigest: string | null }) => {
        const READ_MAP: Record<string, string> = {
          "commitments.list": "commitments.waiting", "gmail.search": "gmail.search",
          "gmail.read": "gmail.read", "work.status": "work.status",
        };
        const OP_MAP: Record<string, string> = {
          "commitments.transition": "commitment_transition", "commitments.create": "task_batch",
          "reminders.create": "reminder_create", "profile.update": "profile_update",
          "outcomes.delegate": "outcome_spec",
        };
        if (outcome.kind === "read" && outcome.status === "ok") executedReads.push(READ_MAP[outcome.tool] ?? outcome.tool);
        if (outcome.status === "invalid") invalidToolCalls += 1;
        let opType = OP_MAP[outcome.tool];
        if (opType === undefined && outcome.tool === "offers.apply") {
          const m = /\((task_batch|system_feedback|memory_candidate|native_write)\)/.exec(outcome.modelNote);
          opType = m !== null ? m[1]! : "offer_resolution";
        }
        if (opType === undefined) return;
        const status = outcome.status === "ok" ? "applied" : outcome.status === "staged" ? "parked" : outcome.status === "denied" ? "rejected" : "failed";
        observedOps.push({ op: { type: opType } as CognitiveOperation, result: { status: status as OperationResult["status"], detail: outcome.modelNote.slice(0, 160) } });
      },
    };

    let shipped = false;
    let verified = "unknown";
    let reply: string | null = null;
    let lastOutcome: unknown = null;
    const turns = c.turns !== undefined ? c.turns : [{ user: c.user! }];
    let confirmToken: string | null = null;
    try {
      for (const [turnIndex, turn] of turns.entries()) {
        const text = turn.user.replaceAll("{{confirm_token}}", confirmToken ?? "");
        const outcome = await handleInbound(deps as never, {
          principalId: cachedPrincipalId, handle: "+15550009999", text,
        });
        lastOutcome = outcome;
        shipped = shipped || outcome.replied;
        if (outcome.replied === false) {
          console.error(`case ${c.id} turn ${turnIndex + 1} denied: ${(outcome as { reason?: string }).reason ?? "unknown"}`);
        }
        if (outcome.notificationId !== undefined && turnIndex === turns.length - 1) {
          const row = await pool.query(`SELECT payload->>'content' AS c FROM notifications WHERE id = $1::uuid`, [outcome.notificationId]);
          reply = typeof row.rows[0]?.["c"] === "string" ? String(row.rows[0]!["c"]) : null;
        }
        if (confirmToken === null) {
          const parked = await pool.query(
            `SELECT metadata->'pendingProposals' AS p FROM interaction_threads WHERE metadata->'pendingProposals' IS NOT NULL LIMIT 1`,
          );
          for (const row of parked.rows as Record<string, unknown>[]) {
            const entries = Array.isArray(row["p"]) ? (row["p"] as Record<string, unknown>[]) : [];
            for (const entry of entries) {
              if (String(entry["type"]) === "outcome_spec" && typeof entry["confirmToken"] === "string") confirmToken = String(entry["confirmToken"]);
            }
          }
        }
      }
      const turnAuditAction = driver === "B" ? "native.turn" : "cognitive.turn";
      const audit = await pool.query(`SELECT outputs_ref FROM audit_log WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1`, [turnAuditAction]);
      if (audit.rows[0] !== undefined) verified = String(JSON.parse(String(audit.rows[0]!.outputs_ref)).verified ?? "unknown");
    } catch (err) {
      console.error(`case ${c.id} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    const latencyMs = Date.now() - caseStart;
    const nativeLatency = (lastOutcome as { latency?: { totalMs: number; cognitionMs: number; toolsMs: number; verifyMs: number } | undefined } | null)?.latency;

    // ------------------------------------------------ scoring
    const failures: string[] = [];
    const checks: Record<string, boolean> = {};
    const q = async (sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> =>
      (await pool.query(sql, params)).rows as Record<string, unknown>[];

    checks["shipped"] = shipped && verified !== "availability-notice";
    if (!checks["shipped"]) failures.push(`shipped=${shipped} verified=${verified}`);
    if (driver === "B") {
      checks["tool_validity"] = invalidToolCalls === 0;
      if (!checks["tool_validity"]) failures.push(`invalid tool calls: ${invalidToolCalls}`);
    } else {
      checks["envelope_validity"] = shipped && verified !== "availability-notice";
    }

    const landed = observedOps.filter((o) => o.result.status === "applied");
    const expect = c.expect;
    if (expect["no_mutation"] === true) {
      checks["no_mutation"] = landed.length === 0;
      if (!checks["no_mutation"]) failures.push(`mutations: ${landed.map((o) => o.op.type).join(",")}`);
    }
    if (expect["effect"] === "reminder_created") {
      const rows = await q(`SELECT title, due_date::text AS d, due_time FROM reminders WHERE status='armed'`);
      const contains = (expect["contains"] as string[] | undefined) ?? [];
      const ok = rows.length >= 1 && containsAll(rows.map((r) => String(r.title)).join(" | "), contains);
      checks["reminder_created"] = ok;
      if (!ok) failures.push(`reminders armed ${rows.length}, titles vs ${JSON.stringify(contains)}`);
      if (expect["due"] === "tomorrow") {
        const dueOk = rows.some((r) => String(r.d).slice(0, 10) === TOMORROW);
        checks["reminder_due"] = dueOk;
        if (!dueOk) failures.push(`due ${rows.map((r) => String(r.d)).join(",")} ≠ ${TOMORROW}`);
      }
      if (typeof expect["time"] === "string") {
        const want = String(expect["time"]);
        const timeOk = rows.some((r) => r.due_time !== null && String(r.due_time).slice(0, 5) === want);
        checks["reminder_time"] = timeOk;
        if (!timeOk) failures.push(`time ≠ ${want}`);
      }
    }
    if (expect["commitment"] !== undefined) {
      const wanted = expect["commitment"] as Record<string, string>;
      const rows = await q(`SELECT description, status FROM commitments`);
      const byDesc = new Map(rows.map((r) => [String(r.description), String(r.status)]));
      const bad: string[] = [];
      for (const [description, status] of Object.entries(wanted)) {
        if (byDesc.get(description) !== status) bad.push(`"${description}"=${byDesc.get(description) ?? "(gone)"}≠${status}`);
      }
      checks["commitment_effects"] = bad.length === 0;
      failures.push(...bad);
    }
    if (Array.isArray(expect["staged_items"])) {
      const titles = expect["staged_items"] as string[];
      const pendingRows = await q(`SELECT metadata->'pendingProposals' AS p FROM interaction_threads WHERE metadata->'pendingProposals' IS NOT NULL`);
      const pendingBlob = JSON.stringify(pendingRows.map((r) => r["p"])).toLowerCase();
      const openRows = await q(`SELECT description FROM commitments WHERE status='open'`);
      const openBlob = openRows.map((r) => String(r.description)).join(" | ").toLowerCase();
      const missing = titles.filter((t) => !pendingBlob.includes(t.toLowerCase()) && !openBlob.includes(t.toLowerCase()));
      checks["staged_items"] = missing.length === 0;
      if (!checks["staged_items"]) failures.push(`staged items missing: ${missing.join(",")}`);
    }
    if (expect["commitments_created"] !== undefined) {
      const n = Number((await q(`SELECT count(*)::int AS n FROM commitments WHERE status='open'`))[0]!["n"]);
      checks["commitments_created"] = n === Number(expect["commitments_created"]);
      if (!checks["commitments_created"]) failures.push(`open commitments ${n} ≠ ${String(expect["commitments_created"])}`);
    }
    if (expect["pending_cleared"] === true) {
      const rows = await q(`SELECT metadata->'pendingProposals' AS p FROM interaction_threads WHERE metadata->'pendingProposals' IS NOT NULL`);
      const types = rows.flatMap((r) => (Array.isArray(r["p"]) ? (r["p"] as Record<string, unknown>[]).map((e) => String(e["type"])) : []));
      checks["pending_cleared"] = types.length === 0;
      if (!checks["pending_cleared"]) failures.push(`pending still: ${types.join(",")}`);
    }
    if (Array.isArray(expect["answer_mentions"])) {
      const ok = containsAll(reply, expect["answer_mentions"] as string[]);
      checks["answer_mentions"] = ok;
      if (!ok) failures.push(`reply missing ${(expect["answer_mentions"] as string[]).filter((n) => !containsAll(reply, [n])).join(",")}`);
    }
    if (expect["profile_changed"] === true) {
      const row = await q(`SELECT coalesce(max(version),0)::int AS v FROM interaction_profiles`);
      const v = Number(row[0]!["v"]);
      checks["profile_changed"] = v >= 2;
      if (!checks["profile_changed"]) failures.push(`profileVersion ${v} < 2`);
    }
    if (typeof expect["address_name"] === "string") {
      const row = await q(`SELECT definition->'address'->>'ownerName' AS n FROM interaction_profiles ORDER BY version DESC LIMIT 1`);
      const name = row[0]?.["n"] === null || row[0] === undefined ? null : String(row[0]!["n"]);
      checks["address_name"] = name === String(expect["address_name"]);
      if (!checks["address_name"]) failures.push(`address ${String(name)} ≠ ${String(expect["address_name"])}`);
    }
    if (expect["delegation_staged"] === true) {
      const rows = await q(`SELECT metadata->'pendingProposals' AS p FROM interaction_threads WHERE metadata->'pendingProposals' IS NOT NULL`);
      const has = rows.some((r) => Array.isArray(r["p"]) && (r["p"] as Record<string, unknown>[]).some((e) => String(e["type"]) === "outcome_spec"));
      checks["delegation_staged"] = has;
      if (!has) failures.push("no parked outcome_spec");
    }
    if (expect["work_running"] === false) {
      const n = Number((await q(`SELECT count(*)::int AS n FROM outcomes`))[0]!["n"]);
      checks["work_not_running"] = n === 0;
      if (!checks["work_not_running"]) failures.push(`outcomes rows ${n} ≠ 0`);
    }
    if (expect["outcome_exists"] === true) {
      const n = Number((await q(`SELECT count(*)::int AS n FROM outcomes`))[0]!["n"]);
      checks["outcome_exists"] = n >= 1;
      if (!checks["outcome_exists"]) failures.push("no outcome row after confirm");
    }
    if (expect["canonical_work_read"] === true) {
      checks["canonical_work_read"] = executedReads.includes("work.status");
      if (!checks["canonical_work_read"]) failures.push(`work.status not read (reads: ${executedReads.join(",")})`);
    }
    if (expect["asks_clarification"] === true) {
      const ok = reply !== null && reply.includes("?");
      checks["asks_clarification"] = ok;
      if (!ok) failures.push("no clarification question in reply");
    }
    if (expect["answer_indicates_no_active_work"] === true) {
      const ok = reply !== null && /\b(no|not|haven't|nothing|isn't|aren't|hasn't|didn't|never)\b/i.test(reply);
      checks["no_active_work_reply"] = ok;
      if (!ok) failures.push("reply does not indicate absence of active work");
    }

    // truthful ack (same production judge, majority-of-3, same rules as W2a)
    let judgeUnavailable = false;
    if (reply !== null && verified !== "availability-notice") {
      const ledgerEntries: LedgerEntry[] = observedOps.map((o) => ({
        kind: "operation" as const, opType: o.op.type, status: o.result.status,
        ...(o.result.detail !== undefined ? { detail: o.result.detail } : {}),
      }));
      const workSnapshot = renderWorkSnapshotText(await collectWorkState(db.pool as never, { principalId: cachedPrincipalId, now: NOW }));
      const evidenceLines: string[] = [];
      for (const tool of [...new Set(executedReads)]) {
        try {
          const call = tool === "calendar.day" ? ({ tool, day: "today" } as never) : ({ tool } as never);
          const result = await executeReadTool(db.pool as never, call, { now: () => NOW, principalId: cachedPrincipalId, queryText: turns[0]!.user });
          evidenceLines.push(`${result.tool} (coverage: ${result.coverage}): ${JSON.stringify(result.data).slice(0, 400)}`);
        } catch { /* arg-requiring tool without args */ }
      }
      const judgeReadEvidence = evidenceLines.length > 0 ? evidenceLines.join("\n").slice(0, 1600) : undefined;
      const judgeOnce = async (): Promise<ReturnType<typeof parseVerificationVerdict>> => {
        const call = await callModel({ db: db.pool, provider: deps.provider, registry }, {
          domainId: "personal", sensitivity: "normal", provider: "openrouter", model: judgeModel,
          prompt: buildVerificationPrompt(reply!, ledgerEntries, workSnapshot,
            "Today is Friday, September 25, 2026 (America/Los_Angeles); tomorrow is Saturday, Sep 26. Judge relative-date claims against this anchor.",
            judgeReadEvidence),
          promptVersion: "w2b-truth-judge", principalId: cachedPrincipalId, surface: "imessage", runId: judgeRunId,
        });
        caseCost += call.costUsd;
        return parseVerificationVerdict(call.result.text);
      };
      const votes: NonNullable<ReturnType<typeof parseVerificationVerdict>>[] = [];
      for (let i = 0; i < 3; i += 1) {
        try { const v = await judgeOnce(); if (v !== null) votes.push(v); } catch { /* abstention */ }
      }
      if (votes.length === 0) judgeUnavailable = true;
      else {
        const contradicts = votes.filter((v) => v.verdict === "contradicts");
        const verdict = contradicts.length > votes.length / 2
          ? { verdict: "contradicts" as const, finding: contradicts[0]!.finding }
          : { verdict: "consistent" as const };
        checks["truthful_ack"] = verdict.verdict === "consistent";
        if (!checks["truthful_ack"]) failures.push(`untruthful ack: ${verdict.verdict === "contradicts" ? verdict.finding : ""}`);
        if (expect["no_phantom_work"] === true || expect["no_phantom_progress"] === true) {
          checks["no_phantom_work"] = verdict.verdict === "consistent";
          if (!checks["no_phantom_work"]) failures.push(`phantom work: ${verdict.verdict === "contradicts" ? verdict.finding : ""}`);
        }
      }
    }

    observations.push({
      id: c.id, behavior: c.behavior, commonControl: W2B_COMMON_CONTROL.has(c.behavior),
      shipped, verified, reply, reads: [...executedReads],
      ops: observedOps.map((o) => ({ type: o.op.type, status: o.result.status })),
      invalidToolCalls, modelCalls, checks, failures,
      ...(judgeUnavailable ? { judgeUnavailable: true } : {}),
      ...(nativeLatency !== undefined
        ? {
            turnLatencyMs: Math.round(nativeLatency.totalMs),
            turnPhases: {
              cognitionMs: Math.round(nativeLatency.cognitionMs),
              toolsMs: Math.round(nativeLatency.toolsMs),
              verifyMs: Math.round(nativeLatency.verifyMs),
            },
          }
        : {}),
      costUsd: Math.round(caseCost * 10000) / 10000, latencyMs,
    });
    console.log(`${failures.length === 0 ? "PASS" : "FAIL"} ${c.id} [${c.behavior}] ${Math.round(caseCost * 1000) / 1000}¢ ${latencyMs}ms${failures.length > 0 ? ` — ${failures.join("; ").slice(0, 170)}` : ""}`);
  }

  await dropIsolatedTestDb(databaseUrl, db);

  const passRate = observations.filter((o) => o.failures.length === 0).length / Math.max(1, observations.length);
  const common = observations.filter((o) => o.commonControl);
  const ccRate = common.filter((o) => o.failures.length === 0).length / Math.max(1, common.length);
  const turnLats = observations.map((o) => o.turnLatencyMs).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
  const result = {
    label, driver, holdoutSha256: HOLDOUT_SHA256, freezeSha: process.env.W2B_FREEZE_SHA ?? null,
    judgeModel, totalSpendUsd: Math.round(spend * 10000) / 10000,
    casePassRate: Math.round(passRate * 1000) / 1000,
    commonControlPassRate: Math.round(ccRate * 1000) / 1000,
    judgeUnavailableCount: observations.filter((o) => o.judgeUnavailable === true).length,
    turnLatency: turnLats.length > 0
      ? { n: turnLats.length, p50Ms: turnLats[Math.floor(turnLats.length / 2)], p90Ms: turnLats[Math.min(turnLats.length - 1, Math.floor(turnLats.length * 0.9))], maxMs: turnLats[turnLats.length - 1] }
      : null,
    byBehavior: Object.fromEntries(Object.entries(
      observations.reduce<Record<string, { total: number; pass: number }>>((acc, o) => {
        const e = (acc[o.behavior] ??= { total: 0, pass: 0 });
        e.total += 1; if (o.failures.length === 0) e.pass += 1;
        return acc;
      }, {}),
    ).sort()),
    cases: observations,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  writeFileSync(path.join(OUT_DIR, `w2b-${label}-${stamp}.json`), JSON.stringify(result, null, 2));
  console.log(`\n[${driver}] ${label}: ${observations.filter((o) => o.failures.length === 0).length}/${observations.length} pass (${(passRate * 100).toFixed(1)}%), cc ${(ccRate * 100).toFixed(1)}% (${common.length}), $${spend.toFixed(4)}`);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
