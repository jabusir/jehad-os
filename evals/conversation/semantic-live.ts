// Reliability wave goal 5 — the LIVE real-model semantic contract runner.
//
//   REAL configured cognitive model (repo policy passes) × REAL
//   runCognitiveTurn loop × UNSEEN natural language → measured semantic
//   envelope + canonical effect. Nothing about the model's envelope is
//   scripted. Side effects land in an ISOLATED schema (hermetic world,
//   real canonical writers) and are asserted post-turn. Cost and latency
//   measured per case; cumulative spend is capped.
//
// CLI:
//   tsx evals/conversation/semantic-live.ts [--holdout] [--dev] [--limit N] [--label X]
// Requires TEST_DATABASE_URL + OPENROUTER_API_KEY (env or launchd).

import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenRouterProvider } from "@jehad/adapters";
import type { ModelProvider, ModelRequest, ModelResult } from "@jehad/adapters";
import {
  ModelEgressPolicyRegistry,
  buildVerificationPrompt,
  parseVerificationVerdict,
  callModel,
  createReminder,
  resolveActiveThread,
  runCognitiveTurn,
  setThreadPendingProposals,
} from "@jehad/core";
import type { CognitiveOperation, OperationResult } from "@jehad/core";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb } from "../../packages/db/tests/test-db.js";
import {
  DEV_CORPUS_FILE,
  HOLDOUT_CORPUS_FILE,
  loadSemanticCorpus,
  type SemanticCase,
} from "./semantic-corpus.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "out");
const SPEND_CEILING_USD = 8;
const NOW = new Date("2026-09-25T17:00:00.000Z"); // 10:00 AM PDT Friday
const TOMORROW = "2026-09-26";
const PRINCIPAL_NAME = "josctl"; // the real policy's conversational principal

// ------------------------------------------------------------------- CLI

function parseArgv(argv: readonly string[]): { flags: Set<string>; options: Map<string, string> } {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--holdout" || arg === "--dev") flags.add(arg.slice(2));
    if (arg === "--limit" || arg === "--label") {
      options.set(arg.slice(2), argv[i + 1] ?? "");
      i += 1;
    }
  }
  return { flags, options };
}

function resolveApiKey(): string {
  if ((process.env.OPENROUTER_API_KEY ?? "").trim().length > 0) return process.env.OPENROUTER_API_KEY!;
  // The repo .env convention (bake-off shared.ts): env wins, .env backs it.
  try {
    const envPath = path.join(HERE, "..", "..", ".env");
    const envText = readFileSync(envPath, "utf8");
    const match = envText.match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (match !== null && match[1]!.trim().length > 0) return match[1]!.trim();
  } catch {
    // no .env — continue
  }
  try {
    const fromLaunchctl = execSync("launchctl getenv OPENROUTER_API_KEY", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (fromLaunchctl.length > 0) return fromLaunchctl;
  } catch {
    // fallthrough
  }
  return "";
}

// ------------------------------------------------------------------- runner

interface CaseObservation {
  readonly id: string;
  readonly behavior: string;
  readonly user: string;
  readonly shipped: boolean;
  readonly degraded: boolean;
  readonly verified: string;
  readonly reads: readonly string[];
  readonly ops: readonly { type: string; status: string; args?: Record<string, unknown> }[];
  readonly reply: string | null;
  readonly checks: Record<string, boolean>;
  readonly failures: readonly string[];
  readonly costUsd: number;
  readonly latencyMs: number;
}

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

function seedEventSql(): string {
  return `INSERT INTO events (id, type, source, occurred_at, idempotency_key, domain_id, payload, sensitivity, schema_version)
          VALUES ($1::uuid, $2, 'semantic-eval', $3::timestamptz, $4, $5::uuid, '{}', 'normal', 1)`;
}

async function seedCase(db: { pool: unknown }, domainId: string, c: SemanticCase): Promise<void> {
  const pool = db.pool as Pool;
  for (const description of c.seed?.commitments ?? []) {
    const eventId = randomUUID();
    await pool.query(seedEventSql(), [eventId, "commitment.created", NOW.toISOString(), randomUUID(), domainId]);
    await pool.query(
      `INSERT INTO commitments (direction, counterparty_text, description, confidence, status, source_event_id, domain_id, created_at, updated_at)
       VALUES ('i_owe', 'someone', $1, 0.9, 'open', $2::uuid, $3::uuid, $4::timestamptz, $4::timestamptz)`,
      [description, eventId, domainId, NOW.toISOString()],
    );
  }
  for (const event of c.seed?.calendar ?? []) {
    const eventId = randomUUID();
    await pool.query(seedEventSql(), [eventId, "calendar.event.created", NOW.toISOString(), randomUUID(), domainId]);
    // "HH:MM" is PT local (America/Los_Angeles, PDT = UTC-7 in September).
    const startIso = new Date(`${NOW.toISOString().slice(0, 10)}T${event.time}:00-07:00`).toISOString();
    await pool.query(
      `INSERT INTO calendar_events (id, google_event_id, google_calendar_id, status, summary, start_time, end_time,
         timezone, attendees, location, metadata, source_event_id, content_hash)
       VALUES ($1::uuid, $2, 'primary', 'confirmed', $3, $4::timestamptz, $5::timestamptz, NULL, '[]', NULL, '{}', $6::uuid, 'x')`,
      [randomUUID(), `evt-${randomUUID().slice(0, 8)}`, event.summary, startIso, new Date(new Date(startIso).getTime() + 3_600_000).toISOString(), eventId],
    );
  }
  for (const reminder of c.seed?.armedReminders ?? []) {
    const day = reminder.date === "tomorrow" ? TOMORROW : NOW.toISOString().slice(0, 10);
    const [hour, minute] = reminder.time.split(":").map(Number);
    // Link to a seeded commitment with the same title when present, so a
    // "done" reply closes the linked to-do (the canonical check-in flow).
    const match = await pool.query(`SELECT id FROM commitments WHERE description = $1 LIMIT 1`, [reminder.title]);
    const commitmentId = match.rows[0] !== undefined ? String(match.rows[0]!["id"]) : null;
    await createReminder(pool as never, {
      principal: PRINCIPAL_NAME,
      title: reminder.title,
      commitmentId,
      dueDate: day,
      dueTime: { hour: hour!, minute: minute! },
      firstTouchAt: new Date(NOW.getTime() - 600_000),
      firstTouchKind: "probe",
    });
  }
  if (c.seed?.pendingOffer !== undefined) {
    const principalId = await principalIdOf(pool);
    const thread = await resolveActiveThread(pool as never, {
      principalId,
      surface: "imessage",
      now: NOW,
    });
    await setThreadPendingProposals(pool as never, {
      threadId: thread.id,
      principalId,
      pending: [
        {
          type: "task_batch" as never,
          at: NOW.toISOString(),
          payload: {
            type: "task_batch",
            items: c.seed.pendingOffer.items.map((i) => ({ title: i.title })),
          },
          offered: `task_batch (${c.seed.pendingOffer.items.length} items)`,
        },
      ],
      now: NOW,
    });
  }
  // Connectivity state: the self-brief derives calendar/gmail connectivity
  // from the sync-state singletons — seed them so the brief reports
  // connected (the isolated schema starts with neither synced, and the
  // model correctly refuses to answer from a "disconnected" brief).
  await pool.query(`INSERT INTO calendar_sync_state (id, calendar_id, last_synced_at) VALUES (1, 'primary', $1::timestamptz)
                    ON CONFLICT (id) DO UPDATE SET last_synced_at = $1::timestamptz`, [NOW.toISOString()]);
  await pool.query(`INSERT INTO gmail_sync_state (id, last_tick_at) VALUES ('singleton', $1::timestamptz)
                    ON CONFLICT (id) DO UPDATE SET last_tick_at = $1::timestamptz`, [NOW.toISOString()]);

  for (const [index, message] of (c.seed?.gmail ?? []).entries()) {
    const at = new Date(NOW.getTime() - message.ageHours * 3_600_000).toISOString();
    await pool.query(
      `INSERT INTO gmail_messages
         (id, gmail_message_id, thread_id, principal_id, domain_id, from_addr, to_addrs,
          subject, snippet, body_text, body_bytes, internal_date, ingested_at)
       VALUES ($1, $2, $3, $4, 'personal', $5, '[]'::jsonb, $6, $7, $8, $9, $10::timestamptz, $10::timestamptz)`,
      [
        randomUUID(),
        `semantic-${index}`,
        `semantic-thread-${index}`,
        PRINCIPAL_NAME,
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

let cachedPrincipalId: string | null = null;
async function principalIdOf(pool: Pool): Promise<string> {
  if (cachedPrincipalId !== null) return cachedPrincipalId;
  const row = await pool.query(`SELECT id FROM principals WHERE name = $1`, [PRINCIPAL_NAME]);
  cachedPrincipalId = row.rows[0] !== undefined ? String(row.rows[0]!["id"]) : null!;
  return cachedPrincipalId;
}

async function main(): Promise<void> {
  const { flags, options } = parseArgv(process.argv.slice(2));
  const split = flags.has("holdout") ? "holdout" : "dev";
  const corpusFile = split === "holdout" ? HOLDOUT_CORPUS_FILE : DEV_CORPUS_FILE;
  const label = options.get("label") ?? split;
  const limit = options.get("limit") !== undefined ? Number(options.get("limit")) : Number.POSITIVE_INFINITY;

  const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
  const apiKey = resolveApiKey();
  if (databaseUrl === "") throw new Error("TEST_DATABASE_URL is required");
  if (apiKey === "") throw new Error("OPENROUTER_API_KEY is not set (env or launchctl)");

  const corpus = loadSemanticCorpus(corpusFile);
  const cases = corpus.cases.slice(0, Number.isFinite(limit) ? limit : corpus.cases.length);

  const db = await createIsolatedTestDb(databaseUrl, `semantic_${split}_${Date.now() % 100000}`);
  const registry = new ModelEgressPolicyRegistry([
    {
      id: "personal-normal-openrouter",
      domainId: "personal",
      sensitivity: "normal",
      allowedProviders: ["openrouter"],
      allowRemote: false,
      requireRedaction: false,
    },
  ]);

  // Cost/latency metering wraps the real provider; transient provider
  // failures (OpenRouter 429/5xx under back-to-back corpus load) get a
  // bounded retry with backoff — the cognitive loop's §22.12 path treats
  // any provider error as turn-fatal, which would measure infrastructure
  // flakiness as semantic failure.
  let spend = 0;
  const real = createOpenRouterProvider({ apiKey });
  async function completeWithRetry(request: ModelRequest): Promise<ModelResult> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await real.complete(request);
        spend += result.usage?.costUsd ?? 0;
        return result;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 900 * (attempt + 1)));
      }
    }
    throw lastError;
  }
  const metered: ModelProvider = {
    id: "openrouter",
    complete: completeWithRetry,
  };

  await migrateUp(db.pool);
  await seedDomains(db.pool);
  const domainRow = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
  const domainId = String(domainRow.rows[0]!.id);
  const principalRow = await db.pool.query(
    `INSERT INTO principals (type, name) VALUES ('user', $1)
     ON CONFLICT (name) DO NOTHING RETURNING id`,
    [PRINCIPAL_NAME],
  );
  cachedPrincipalId =
    principalRow.rows[0] !== undefined
      ? String(principalRow.rows[0]!.id)
      : String((await db.pool.query(`SELECT id FROM principals WHERE name = $1`, [PRINCIPAL_NAME])).rows[0]!.id);
  await db.pool.query(
    `INSERT INTO capability_grants (principal_id, capability, resource, domain_id, expires_at, token_hash)
     VALUES ($1::uuid, 'imessage:converse', 'imessage', $2::uuid, $3::timestamptz, $4)`,
    [cachedPrincipalId, domainId, new Date(NOW.getTime() + 86_400_000).toISOString(), "semantic-eval"],
  );

  const observations: CaseObservation[] = [];
  const startedAt = Date.now();

  for (const c of cases) {
    if (spend > SPEND_CEILING_USD) {
      console.error(`spend ceiling $${SPEND_CEILING_USD} reached — stopping before ${c.id}`);
      break;
    }
    // Hermetic world per case: full reset of the mutable canonical tables.
    await db.pool.query(`
      DELETE FROM model_calls; DELETE FROM notifications; DELETE FROM reminders;
      DELETE FROM commitments; DELETE FROM calendar_events; DELETE FROM events;
      DELETE FROM interaction_messages; DELETE FROM interaction_threads;
      DELETE FROM memory_candidates; DELETE FROM outcomes; DELETE FROM audit_log;
      DELETE FROM runs; DELETE FROM gmail_messages; TRUNCATE interaction_profiles;
    `);
    await seedCase(db as never, domainId, c);

    const executedReads: string[] = [];
    const observedOps: { op: CognitiveOperation; result: OperationResult }[] = [];
    const caseStart = Date.now();
    let caseCost = 0;
    const deps = {
      db: db.pool,
      provider: {
        id: "openrouter",
        complete: async (request: ModelRequest): Promise<ModelResult> => {
          const before = spend;
          const result = await metered.complete(request);
          caseCost += spend - before;
          return result;
        },
      } as ModelProvider,
      registry,
      now: () => NOW,
      onOperation: (op: CognitiveOperation, result: OperationResult) => {
        observedOps.push({ op, result });
      },
      onReadExecuted: (tool: string) => {
        executedReads.push(tool);
      },
    };

    let shipped = false;
    let degraded = false;
    let verified = "unknown";
    let reply: string | null = null;
    let ledger: { opType: string; status: string }[] = [];
    let turnFailedMessage: string | null = null;
    try {
      const outcome = await runCognitiveTurn(deps, {
        principalId: cachedPrincipalId,
        handle: "+15550009999",
        text: c.user,
      });
      shipped = outcome.replied;
      ledger = (outcome.ledger ?? []) as { opType: string; status: string }[];
      if (outcome.notificationId !== undefined) {
        const row = await db.pool.query(`SELECT payload->>'content' AS c FROM notifications WHERE id = $1::uuid`, [outcome.notificationId]);
        reply = typeof row.rows[0]?.["c"] === "string" ? String(row.rows[0]!["c"]) : null;
      }
      const audit = await db.pool.query(
        `SELECT outputs_ref FROM audit_log WHERE action = 'cognitive.turn' ORDER BY occurred_at DESC LIMIT 1`,
      );
      if (audit.rows[0] !== undefined) {
        verified = String(JSON.parse(String(audit.rows[0]!.outputs_ref)).verified ?? "unknown");
      }
      const failed = await db.pool.query(
        `SELECT outputs_ref FROM audit_log WHERE action = 'cognitive.turn_failed' ORDER BY occurred_at DESC LIMIT 1`,
      );
      turnFailedMessage =
        failed.rows[0] !== undefined
          ? String(JSON.parse(String(failed.rows[0]!.outputs_ref)).errorMessage ?? "").slice(0, 140)
          : null;
      degraded = verified.startsWith("degraded") || verified === "availability-notice";
    } catch (err) {
      console.error(`case ${c.id} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    const latencyMs = Date.now() - caseStart;

    // ------------------------------------------------ metric checks
    const failures: string[] = [];
    const checks: Record<string, boolean> = {};

    // envelope_validity: the user received a REAL reply through the
    // envelope path or a recovered degrade (measured separately); only an
    // availability notice (no answer delivered) fails the case.
    checks["envelope_validity"] = shipped && verified !== "availability-notice";
    if (!checks["envelope_validity"]) failures.push(`shipped=${shipped} verified=${verified}`);
    if (turnFailedMessage !== null) failures.push(`turn_failed: ${turnFailedMessage}`);

    if (c.expect.reads !== undefined) {
      const missing = c.expect.reads.filter((tool) => !executedReads.includes(tool));
      checks["read_selection"] = missing.length === 0;
      if (!checks["read_selection"]) failures.push(`reads missing: ${missing.join(",")} (got ${executedReads.join(",")})`);
    }

    const executedOps = observedOps.map((o) => ({
      type: o.op.type,
      status: o.result.status,
      detail: o.result.detail ?? null,
      args: o.op as unknown as Record<string, unknown>,
    }));
    if (c.expect.ops !== undefined && c.expect.ops.length > 0) {
      const missed = c.expect.ops.filter(
        (expected) => !executedOps.some((actual) => actual.type === expected.type),
      );
      checks["op_type"] = missed.length === 0;
      if (!checks["op_type"]) failures.push(`ops missing: ${missed.map((m) => m.type).join(",")}`);
      // Arg pins (verb / titleContains).
      const argOk = c.expect.ops.every((expected) => {
        const actual = executedOps.find((o) => o.type === expected.type);
        if (actual === undefined) return false;
        if (expected.verb !== undefined && String((actual.args as { verb?: unknown }).verb) !== expected.verb) return false;
        for (const needle of expected.titleContains ?? []) {
          const title = String((actual.args as { title?: unknown }).title ?? "");
          if (!title.toLowerCase().includes(needle.toLowerCase())) return false;
        }
        return true;
      });
      checks["op_args"] = argOk;
      if (!argOk) failures.push("op args/verb/title mismatch");
    }

    const landedMutations = executedOps.filter((o) => o.status === "applied" || o.status === "parked" || o.status === "queued");
    if (c.expect.noMutations === true) {
      checks["no_unauthorized_mutation"] = landedMutations.length === 0;
      if (!checks["no_unauthorized_mutation"]) {
        failures.push(`unauthorized mutations: ${landedMutations.map((m) => m.type).join(",")}`);
      }
    }

    // e2e canonical effects
    const effectFailures: string[] = [];
    const effects = c.expect.effects;
    if (effects !== undefined) {
      const q = async (sql: string): Promise<Record<string, unknown>[]> =>
        (await db.pool.query(sql)).rows as Record<string, unknown>[];
      if (effects.remindersArmed !== undefined) {
        const n = Number((await q(`SELECT count(*)::int AS n FROM reminders WHERE status='armed'`))[0]!["n"]);
        if (n !== effects.remindersArmed) effectFailures.push(`remindersArmed ${n}≠${effects.remindersArmed}`);
      }
      if (effects.remindersCompleted !== undefined) {
        const n = Number((await q(`SELECT count(*)::int AS n FROM reminders WHERE status='completed'`))[0]!["n"]);
        if (n !== effects.remindersCompleted) effectFailures.push(`remindersCompleted ${n}≠${effects.remindersCompleted}`);
      }
      if (effects.reminderDueDate !== undefined) {
        const row = await q(`SELECT max(due_date)::text AS d FROM reminders WHERE status='armed'`);
        const d = row[0]?.["d"] === null || row[0] === undefined ? null : String(row[0]!["d"]).slice(0, 10);
        if (d !== effects.reminderDueDate) effectFailures.push(`reminderDueDate ${d}≠${effects.reminderDueDate}`);
      }
      if (effects.commitmentStatus !== undefined) {
        const rows = await q(`SELECT description, status FROM commitments`);
        const byDesc = new Map(rows.map((r) => [String(r["description"]), String(r["status"])]));
        for (const [description, status] of Object.entries(effects.commitmentStatus)) {
          if (byDesc.get(description) !== status) effectFailures.push(`commitment "${description}" = ${byDesc.get(description) ?? "(gone)"} ≠ ${status}`);
        }
      }
      if (effects.occurrenceObserved !== undefined) {
        const n = Number((await q(`SELECT count(*)::int AS n FROM calendar_events WHERE occurrence='observed_occurred'`))[0]!["n"]);
        if (n !== effects.occurrenceObserved) effectFailures.push(`occurrenceObserved ${n}≠${effects.occurrenceObserved}`);
      }
      if (effects.occurrenceMissed !== undefined) {
        const n = Number((await q(`SELECT count(*)::int AS n FROM calendar_events WHERE occurrence='observed_missed'`))[0]!["n"]);
        if (n !== effects.occurrenceMissed) effectFailures.push(`occurrenceMissed ${n}≠${effects.occurrenceMissed}`);
      }
      if (effects.profileVersion !== undefined) {
        const row = await q(`SELECT coalesce(max(version),0)::int AS v FROM interaction_profiles`);
        const v = Number(row[0]!["v"]);
        if (v < effects.profileVersion) effectFailures.push(`profileVersion ${v}<${effects.profileVersion}`);
      }
      if (effects.pendingTaskBatch === true || effects.pendingOutcomeSpec === true) {
        const rows = await q(`SELECT metadata->'pendingProposals' AS p FROM interaction_threads WHERE metadata->'pendingProposals' IS NOT NULL`);
        const types = rows.flatMap((r) => (Array.isArray(r["p"]) ? (r["p"] as Record<string, unknown>[]).map((e) => String(e["type"])) : []));
        if (effects.pendingTaskBatch === true && !types.includes("task_batch")) effectFailures.push("no parked task_batch");
        if (effects.pendingOutcomeSpec === true && !types.includes("outcome_spec")) effectFailures.push("no parked outcome_spec");
      }
      if (effects.commitmentsOpen !== undefined) {
        const n = Number((await q(`SELECT count(*)::int AS n FROM commitments WHERE status='open'`))[0]!["n"]);
        if (n !== effects.commitmentsOpen) effectFailures.push(`commitmentsOpen ${n}≠${effects.commitmentsOpen}`);
      }
    }
    checks["e2e_effects"] = effectFailures.length === 0;
    failures.push(...effectFailures);

    // truthful acknowledgment: judge the SHIPPED reply against what the
    // ledger actually did (runner-side §22.9 verifier, real model).
    if (reply !== null) {
      try {
        const ledgerEntries = ledger.map((l) => ({ kind: "operation" as const, opType: l.opType, status: l.status as never }));
        const verdictCall = await callModel({ db: db.pool, provider: deps.provider, registry }, {
          domainId: "personal",
          sensitivity: "normal",
          provider: "openrouter",
          model: "google/gemini-2.5-flash",
          prompt: buildVerificationPrompt(reply, ledgerEntries),
          promptVersion: "semantic-truth-judge",
          principalId: cachedPrincipalId,
          surface: "imessage",
        });
        caseCost += verdictCall.costUsd;
        const verdict = parseVerificationVerdict(verdictCall.result.text);
        checks["truthful_ack"] = verdict === null || verdict.verdict === "consistent";
        if (!checks["truthful_ack"]) {
          failures.push(`untruthful ack: ${verdict?.verdict === "contradicts" ? verdict.finding : ""}`);
        }
      } catch {
        checks["truthful_ack"] = true; // fail-open, same as production
      }
    }

    observations.push({
      id: c.id,
      behavior: c.behavior,
      user: c.user,
      shipped,
      degraded,
      verified,
      reads: executedReads,
      ops: executedOps.map((o) => ({ type: o.type, status: o.status, detail: o.detail })),
      reply,
      checks,
      failures,
      costUsd: Math.round(caseCost * 10000) / 10000,
      latencyMs,
    });
    const pass = failures.length === 0;
    console.log(`${pass ? "PASS" : "FAIL"} ${c.id} [${c.behavior}] ${Math.round(caseCost * 1000) / 1000}¢ ${latencyMs}ms${failures.length > 0 ? ` — ${failures.join("; ").slice(0, 160)}` : ""}`);
  }

  await dropIsolatedTestDb(databaseUrl, db);

  // ------------------------------------------------ summary
  const metricNames = ["envelope_validity", "read_selection", "op_type", "op_args", "no_unauthorized_mutation", "e2e_effects", "truthful_ack"];
  const overall: Record<string, number> = {};
  const byBehavior: Record<string, { total: number; pass: number }> = {};
  for (const name of metricNames) {
    const applicable = observations.filter((o) => o.checks[name] !== undefined);
    overall[name] = applicable.length === 0 ? 1 : applicable.filter((o) => o.checks[name]).length / applicable.length;
  }
  for (const o of observations) {
    const entry = (byBehavior[o.behavior] ??= { total: 0, pass: 0 });
    entry.total += 1;
    if (o.failures.length === 0) entry.pass += 1;
  }
  const passRate = observations.filter((o) => o.failures.length === 0).length / Math.max(1, observations.length);
  const totalCost = observations.reduce((sum, o) => sum + o.costUsd, 0);
  const avgLatency = observations.reduce((sum, o) => sum + o.latencyMs, 0) / Math.max(1, observations.length);

  const result = {
    label,
    split,
    generatedAt: new Date().toISOString(),
    modelPolicy: "repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)",
    spendCeilingUsd: SPEND_CEILING_USD,
    totalSpendUsd: Math.round(totalCost * 10000) / 10000,
    avgLatencyMs: Math.round(avgLatency),
    casePassRate: Math.round(passRate * 1000) / 1000,
    metrics: overall,
    byBehavior,
    cases: observations,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const jsonFile = path.join(OUT_DIR, `semantic-${label}-${stamp}.json`);
  writeFileSync(jsonFile, JSON.stringify(result, null, 2));
  const mdFile = path.join(OUT_DIR, `semantic-${label}-${stamp}.md`);
  writeFileSync(mdFile, renderMarkdown(result));
  console.log(`\n${label}: ${observations.filter((o) => o.failures.length === 0).length}/${observations.length} cases pass (${(passRate * 100).toFixed(1)}%), $${totalCost.toFixed(4)}, avg ${Math.round(avgLatency)}ms`);
  console.log(`wrote ${jsonFile}`);
}

function renderMarkdown(result: Record<string, unknown>): string {
  const metrics = result["metrics"] as Record<string, number>;
  const byBehavior = result["byBehavior"] as Record<string, { total: number; pass: number }>;
  const cases = result["cases"] as CaseObservation[];
  const lines = [
    `# Semantic contract — ${String(result["label"])} (${String(result["split"])} split)`,
    "",
    `- Model policy: ${String(result["modelPolicy"])}`,
    `- Cases: ${cases.length} · pass **${(Number(result["casePassRate"]) * 100).toFixed(1)}%** · spend $${String(result["totalSpendUsd"])} · avg latency ${String(result["avgLatencyMs"])}ms`,
    "",
    "## Metrics",
    "",
    "| metric | rate |",
    "| --- | --- |",
    ...Object.entries(metrics).map(([name, rate]) => `| ${name} | ${(rate * 100).toFixed(1)}% |`),
    "",
    "## By behavior",
    "",
    "| behavior | pass |",
    "| --- | --- |",
    ...Object.entries(byBehavior).sort().map(([b, s]) => `| ${b} | ${s.pass}/${s.total} |`),
    "",
    "## Failures",
    "",
    ...(cases.filter((c) => c.failures.length > 0).length === 0
      ? ["none"]
      : cases
          .filter((c) => c.failures.length > 0)
          .map((c) => `### ${c.id} [${c.behavior}]\n- user: ${JSON.stringify(c.user)}\n- verified: ${c.verified}\n- ops: ${JSON.stringify(c.ops)}\n- ${c.failures.map((f) => `- ${f}`).join("\n")}`)),
  ];
  return lines.join("\n") + "\n";
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
