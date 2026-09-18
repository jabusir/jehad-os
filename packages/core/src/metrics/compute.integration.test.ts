// Metrics rollup integration tests (M6D, plan §14): human_blocked_ms derived
// from human_waits (multi-wait runs sum both waits), percentile math on known
// fixtures, window filtering, empty-window zeros, weekly rollup window.
// Needs PostgreSQL 16; skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { recordFeedback } from "../feedback/service.js";
import { computeMetrics, computeWeeklyRollup, percentile, type MetricsReport } from "./compute.js";
import { renderMetricsText } from "./render.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Fixed UTC fixture days — deterministic window math.
const DAY1 = "2026-09-15";
const DAY2 = "2026-09-16";
const DAY3 = "2026-09-17";
const at = (day: string, time: string): string => `${day}T${time}Z`;

describe("percentile (nearest-rank, pure)", () => {
  it("computes known ranks on 1..10", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 90)).toBe(9);
    expect(percentile(sorted, 99)).toBe(10);
  });

  it("single value and empty input", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([], 99)).toBe(0);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("metrics rollup (integration)", () => {
  let db: IsolatedDb;
  let principalId: string;
  const runIds: Record<string, string> = {};

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "m6dmetrics");
    await migrateUp(db.pool);
    await seedDomains(db.pool);

    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    const domainId = String(domain.rows[0]!.id);
    const principal = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id`,
      [`owner-${randomUUID().slice(0, 8)}`],
    );
    principalId = String(principal.rows[0]!.id);

    async function insertRun(
      key: string,
      status: string,
      startedAt: string,
      endedAt: string | null,
    ): Promise<string> {
      const inserted = await db.pool.query(
        `INSERT INTO runs (kind, principal_id, status, domain_id, started_at, ended_at)
         VALUES ('workflow', $1::uuid, $2, $3::uuid, $4::timestamptz, $5::timestamptz)
         RETURNING id`,
        [principalId, status, domainId, startedAt, endedAt],
      );
      const id = String(inserted.rows[0]!.id);
      runIds[key] = id;
      return id;
    }

    async function insertEscalation(
      runKey: string,
      reason: string,
      status: string,
      updatedAt: string,
    ): Promise<string> {
      const inserted = await db.pool.query(
        `INSERT INTO escalations (run_id, reason, status, updated_at)
         VALUES ($1::uuid, $2, $3, $4::timestamptz)
         RETURNING id`,
        [runIds[runKey]!, reason, status, updatedAt],
      );
      return String(inserted.rows[0]!.id);
    }

    async function insertWait(opts: {
      runKey: string;
      startedAt: string;
      resolvedAt: string | null;
      reason?: string | null;
      escalationId?: string | null;
    }): Promise<void> {
      await db.pool.query(
        `INSERT INTO human_waits (run_id, escalation_id, started_at, resolved_at, reason)
         VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, $5)`,
        [runIds[opts.runKey]!, opts.escalationId ?? null, opts.startedAt, opts.resolvedAt, opts.reason ?? null],
      );
    }

    // -- runs: mixed statuses ------------------------------------------------
    await insertRun("r1", "completed", at(DAY1, "09:00:00"), at(DAY1, "12:00:00"));
    await insertRun("r2", "completed", at(DAY1, "09:30:00"), at(DAY2, "12:00:00"));
    await insertRun("r3", "failed", at(DAY2, "08:00:00"), at(DAY2, "13:00:00"));
    await insertRun("r4", "cancelled", at(DAY2, "08:30:00"), at(DAY3, "12:00:00"));
    await insertRun("r5", "blocked", at(DAY2, "09:00:00"), null);
    await insertRun("r6", "completed", at(DAY3, "09:00:00"), at(DAY3, "13:00:00"));

    // -- escalations backing waits (reason via escalation_id, COALESCE path) --
    const e1 = await insertEscalation("r6", "approval_required", "pending", at(DAY1, "09:05:00"));
    const e1b = await insertEscalation("r6", "approval_required", "pending", at(DAY1, "09:06:00"));
    const e2 = await insertEscalation("r1", "approval_required", "pending", at(DAY1, "09:07:00"));

    // -- human_waits: 11 resolved + 1 open, spanning 3 distinct UTC days -----
    // approval_required durations (s): 60, 90, 120, 150, 240, 300, 600, 900, 1800
    await insertWait({ runKey: "r1", startedAt: at(DAY1, "10:00:00"), resolvedAt: at(DAY1, "10:01:00"), escalationId: e2 });
    await insertWait({ runKey: "r2", startedAt: at(DAY1, "10:00:00"), resolvedAt: at(DAY1, "10:01:30"), reason: "approval_required" });
    await insertWait({ runKey: "r3", startedAt: at(DAY1, "11:00:00"), resolvedAt: at(DAY1, "11:02:00"), reason: "approval_required" });
    await insertWait({ runKey: "r2", startedAt: at(DAY2, "10:00:00"), resolvedAt: at(DAY2, "10:15:00"), reason: "approval_required" });
    await insertWait({ runKey: "r4", startedAt: at(DAY2, "11:00:00"), resolvedAt: at(DAY2, "11:02:30"), reason: "approval_required" });
    await insertWait({ runKey: "r4", startedAt: at(DAY2, "12:00:00"), resolvedAt: at(DAY2, "12:30:00"), reason: "approval_required" });
    await insertWait({ runKey: "r3", startedAt: at(DAY2, "14:00:00"), resolvedAt: at(DAY2, "14:20:00"), reason: null, escalationId: null }); // → 'unknown' bucket, 1200s
    await insertWait({ runKey: "r6", startedAt: at(DAY3, "10:00:00"), resolvedAt: at(DAY3, "10:05:00"), escalationId: e1 });
    await insertWait({ runKey: "r6", startedAt: at(DAY3, "11:00:00"), resolvedAt: at(DAY3, "11:10:00"), escalationId: e1b });
    await insertWait({ runKey: "r3", startedAt: at(DAY3, "12:00:00"), resolvedAt: at(DAY3, "12:04:00"), reason: "approval_required" });
    await insertWait({ runKey: "r2", startedAt: at(DAY3, "13:00:00"), resolvedAt: at(DAY3, "13:00:30"), reason: "missing_credentials" });
    await insertWait({ runKey: "r5", startedAt: at(DAY3, "09:30:00"), resolvedAt: null, reason: "approval_required" }); // open

    // -- escalations for the false-escalation metric --------------------------
    const x1 = await insertEscalation("r1", "ambiguous_requirements", "resolved", at(DAY3, "14:00:00"));
    const x2 = await insertEscalation("r1", "missing_credentials", "resolved", at(DAY3, "14:30:00"));
    await insertEscalation("r2", "system_failure", "resolved", at(DAY3, "15:00:00"));
    await insertEscalation("r3", "architecture_decision", "pending", at(DAY3, "15:30:00"));

    async function insertEvent(payload: Record<string, unknown>, runKey: string): Promise<void> {
      await db.pool.query(
        `INSERT INTO events (id, type, source, occurred_at, idempotency_key, domain_id, payload, sensitivity, schema_version, run_id)
         VALUES ($1::uuid, 'escalation.resolved', 'internal', $2::timestamptz, $3, $4::uuid, $5::jsonb, 'normal', 1, $6::uuid)`,
        [
          randomUUID(),
          at(DAY3, "14:31:00"),
          randomUUID(),
          domainId,
          JSON.stringify(payload),
          runIds[runKey]!,
        ],
      );
    }

    await insertEvent({ escalationId: x1, resolution: "resolved" }, "r1");
    await insertEvent({ escalationId: x2, resolution: "not_needed" }, "r1");

    // -- model_calls ----------------------------------------------------------
    async function insertModelCall(
      runKey: string,
      provider: string,
      model: string,
      costUsd: string,
      createdAt: string,
    ): Promise<void> {
      await db.pool.query(
        `INSERT INTO model_calls (run_id, provider, model, in_tokens, out_tokens, cost_usd, latency_ms, result_status, created_at)
         VALUES ($1::uuid, $2, $3, 1000, 500, $4::numeric, 1200, 'ok', $5::timestamptz)`,
        [runIds[runKey]!, provider, model, costUsd, createdAt],
      );
    }

    await insertModelCall("r1", "openrouter", "anthropic/claude-3.5-sonnet", "0.01", at(DAY1, "10:30:00"));
    await insertModelCall("r1", "openrouter", "anthropic/claude-3.5-sonnet", "0.02", at(DAY2, "10:30:00"));
    await insertModelCall("r2", "openrouter", "openai/gpt-4o", "0.005", at(DAY2, "11:30:00"));
    await insertModelCall("r6", "openrouter", "openai/gpt-4o", "0.0075", at(DAY3, "10:30:00"));
    await insertModelCall("r3", "ollama", "llama3", "0", at(DAY2, "12:30:00"));

    // -- outbox failures -------------------------------------------------------
    async function insertFailedOutbox(lastError: string, updatedAt: string): Promise<void> {
      const eventId = randomUUID();
      await db.pool.query(
        `INSERT INTO events (id, type, source, occurred_at, idempotency_key, domain_id, payload, sensitivity, schema_version)
         VALUES ($1::uuid, 'capture.recorded', 'cli.capture', $2::timestamptz, $3, $4::uuid, '{}', 'normal', 1)`,
        [eventId, updatedAt, randomUUID(), domainId],
      );
      await db.pool.query(
        `INSERT INTO outbox (event_id, status, attempts, last_error, updated_at)
         VALUES ($1::uuid, 'failed', 3, $2, $3::timestamptz)`,
        [eventId, lastError, updatedAt],
      );
    }

    await insertFailedOutbox("ECONNREFUSED 127.0.0.1:5432\n    at fetch (node:internal)", at(DAY3, "16:00:00"));
    await insertFailedOutbox("ECONNREFUSED 127.0.0.1:5432\n    at fetch (node:internal)", at(DAY3, "16:10:00"));
    await insertFailedOutbox("timeout after 30000ms", at(DAY3, "16:30:00"));

    // -- action attempts (via an intent on r1) ---------------------------------
    const intent = await db.pool.query(
      `INSERT INTO action_intents (run_id, capability, resource, domain_id, status)
       VALUES ($1::uuid, 'message.send', 'example:test', $2::uuid, 'approved') RETURNING id`,
      [runIds.r1!, domainId],
    );
    const intentId = String(intent.rows[0]!.id);
    await db.pool.query(
      `INSERT INTO action_attempts (intent_id, provider, started_at, finished_at, outcome, error)
       VALUES ($1::uuid, 'fake', $2::timestamptz, $3::timestamptz, 'failed', 'provider returned 500')`,
      [intentId, at(DAY3, "17:00:00"), at(DAY3, "17:00:02")],
    );
    await db.pool.query(
      `INSERT INTO action_attempts (intent_id, provider, started_at, outcome)
       VALUES ($1::uuid, 'fake', $2::timestamptz, 'unknown')`,
      [intentId, at(DAY3, "17:30:00")],
    );
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  let allTime: MetricsReport;

  it("derives human_blocked_ms from human_waits: total, reasons, percentiles", async () => {
    allTime = await computeMetrics(db.pool, { now: () => new Date(at(DAY3, "18:00:00")) });
    const hb = allTime.humanBlocked;

    // total = 4260s (approval) + 30s (missing_credentials) + 1200s (unknown)
    expect(hb.totalMs).toBe(5490 * 1000);
    expect(hb.openWaits).toBe(1);

    const approval = hb.byReason.find((r) => r.reason === "approval_required")!;
    expect(approval).toBeDefined();
    expect(approval.waits).toBe(9);
    expect(approval.totalMs).toBe(4260 * 1000);
    // nearest-rank on sorted [60,90,120,150,240,300,600,900,1800]s
    expect(approval.percentiles).toEqual({ p50: 240_000, p90: 1_800_000, p99: 1_800_000 });

    const missing = hb.byReason.find((r) => r.reason === "missing_credentials")!;
    expect(missing.waits).toBe(1);
    expect(missing.percentiles).toEqual({ p50: 30_000, p90: 30_000, p99: 30_000 });

    const unknown = hb.byReason.find((r) => r.reason === "unknown")!;
    expect(unknown.waits).toBe(1);
    expect(unknown.percentiles.p50).toBe(1_200_000);
  });

  it("multi-wait runs sum BOTH waits (r6: 300s + 600s; r4: 150s + 1800s)", async () => {
    const perRun = allTime.humanBlocked.perRun;
    const r6 = perRun.find((r) => r.runId === runIds.r6!)!;
    expect(r6.waits).toBe(2);
    expect(r6.totalMs).toBe(900 * 1000);
    const r4 = perRun.find((r) => r.runId === runIds.r4!)!;
    expect(r4.waits).toBe(2);
    expect(r4.totalMs).toBe(1950 * 1000);
    // descending by blocked time
    expect(perRun[0]!.runId).toBe(runIds.r4!);
  });

  it("interruptions_per_day = (resolved waits + interruptive verdicts) / distinct UTC days", async () => {
    expect(allTime.interruptions).toEqual({
      resolvedWaits: 11,
      interruptiveVerdicts: 0, // no feedback seeded in this suite
      total: 11,
      distinctDays: 3,
      perDay: 11 / 3,
    });
  });

  it("autonomous_completion_rate excludes cancelled from ended runs", async () => {
    expect(allTime.autonomousCompletion).toEqual({
      completedRuns: 3,
      endedRuns: 4,
      cancelledExcluded: 1,
      rate: 0.75,
    });
  });

  it("false_escalation_rate counts not_needed resolutions / resolved", async () => {
    expect(allTime.falseEscalation).toEqual({ resolved: 3, notNeeded: 1, rate: 1 / 3 });
    expect(allTime.signalQuality).toBeNull(); // no feedback seeded here — guarded null
  });

  it("model cost: total, by provider/model, top runs", async () => {
    expect(allTime.modelCost.totalUsd).toBeCloseTo(0.0425, 10);
    expect(allTime.modelCost.calls).toBe(5);
    expect(allTime.modelCost.byProviderModel).toEqual([
      { provider: "openrouter", model: "anthropic/claude-3.5-sonnet", calls: 2, costUsd: 0.03 },
      { provider: "openrouter", model: "openai/gpt-4o", calls: 2, costUsd: 0.0125 },
      { provider: "ollama", model: "llama3", calls: 1, costUsd: 0 },
    ]);
    expect(allTime.modelCost.topRuns.map((r) => r.runId)).toEqual([
      runIds.r1!,
      runIds.r6!,
      runIds.r2!,
      runIds.r3!,
    ]);
    expect(allTime.modelCost.topRuns[0]!.costUsd).toBeCloseTo(0.03, 10);
  });

  it("workflow status snapshot groups all runs by status", async () => {
    expect(allTime.workflowStatus.statuses).toEqual([
      { status: "blocked", runs: 1 },
      { status: "cancelled", runs: 1 },
      { status: "completed", runs: 3 },
      { status: "failed", runs: 1 },
    ]);
  });

  it("failure reasons: sanitized outbox signatures + attempt counts", async () => {
    expect(allTime.failures.outboxErrors).toEqual([
      { signature: "ECONNREFUSED 127.0.0.1:5432", count: 2 },
      { signature: "timeout after 30000ms", count: 1 },
    ]);
    expect(allTime.failures.actionAttempts).toEqual({ failed: 1, unknown: 1 });
  });

  it("window filter (since day2) rescopes every metric", async () => {
    const report = await computeMetrics(db.pool, {
      since: `${DAY2}T00:00:00Z`,
      now: () => new Date(at(DAY3, "18:00:00")),
    });
    // approval waits in window: 900, 150, 1800 (day2) + 300, 600, 240 (day3)
    const approval = report.humanBlocked.byReason.find((r) => r.reason === "approval_required")!;
    expect(approval.waits).toBe(6);
    expect(approval.totalMs).toBe(3990 * 1000);
    expect(approval.percentiles).toEqual({ p50: 300_000, p90: 1_800_000, p99: 1_800_000 });
    // resolved waits in window: 6 approval + 1 unknown (day2) + 1
    // missing_credentials (day3) = 8 across 2 days
    expect(report.interruptions.resolvedWaits).toBe(8);
    expect(report.interruptions.interruptiveVerdicts).toBe(0);
    expect(report.interruptions.total).toBe(8);
    expect(report.interruptions.distinctDays).toBe(2);
    // ended runs in window: r2, r3, r4, r6 → completed r2+r6, cancelled r4
    expect(report.autonomousCompletion).toEqual({
      completedRuns: 2,
      endedRuns: 3,
      cancelledExcluded: 1,
      rate: 2 / 3,
    });
    expect(report.modelCost.calls).toBe(4); // day1 call excluded
  });

  it("empty window → zeros, not crashes (snapshot stays current)", async () => {
    const report = await computeMetrics(db.pool, {
      since: "2027-01-01T00:00:00Z",
      now: () => new Date(at(DAY3, "18:00:00")),
    });
    expect(report.humanBlocked.totalMs).toBe(0);
    expect(report.humanBlocked.byReason).toEqual([]);
    expect(report.humanBlocked.perRun).toEqual([]);
    expect(report.interruptions).toEqual({
      resolvedWaits: 0,
      interruptiveVerdicts: 0,
      total: 0,
      distinctDays: 0,
      perDay: 0,
    });
    // guarded: zero feedback → signalQuality is null, not zeros
    expect(report.signalQuality).toBeNull();
    expect(report.autonomousCompletion).toEqual({
      completedRuns: 0,
      endedRuns: 0,
      cancelledExcluded: 0,
      rate: 0,
    });
    expect(report.falseEscalation).toEqual({ resolved: 0, notNeeded: 0, rate: 0 });
    expect(report.modelCost.totalUsd).toBe(0);
    expect(report.modelCost.byProviderModel).toEqual([]);
    expect(report.failures.outboxErrors).toEqual([]);
    expect(report.workflowStatus.statuses.length).toBe(4); // snapshot is unwindowed
  });

  it("computeWeeklyRollup windows to the last 7 days", async () => {
    const report = await computeWeeklyRollup(db.pool, { now: () => new Date(at(DAY3, "18:00:00")) });
    expect(report.window.since).toBe("2026-09-10T18:00:00.000Z");
    expect(report.humanBlocked.totalMs).toBe(allTime.humanBlocked.totalMs);
    expect(report.autonomousCompletion.rate).toBe(0.75);
  });

  it("rejects an unparseable since", async () => {
    await expect(computeMetrics(db.pool, { since: "not-a-date" })).rejects.toThrow(/invalid since/);
  });

  it("renders the full fixture set without crashing", () => {
    const text = renderMetricsText(allTime);
    expect(text).toContain("human blocked time (derived from human_waits — plan §14)");
    expect(text).toContain("approval_required");
    expect(text).toContain("ECONNREFUSED 127.0.0.1:5432");
    expect(text).not.toMatch(/ +\n/); // no trailing whitespace
  });
});

describe.skipIf(!TEST_DATABASE_URL)("signal quality from feedback (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "e3bsignal");
    await migrateUp(db.pool);
    // Seed via the service itself (dogfoods the append-only write path). The
    // dedupe re-tap proves deduped taps don't inflate the metrics.
    const seed: readonly [itemType: string, itemId: string, verdict: string, at: string][] = [
      ["notification", "n1", "useful", at(DAY1, "10:00:00")],
      ["notification", "n1", "useful", at(DAY1, "18:00:00")], // idempotent re-tap
      ["notification", "n1", "noise", at(DAY3, "09:30:00")], // distinct verdict, same item
      ["notification", "n2", "noise", at(DAY1, "11:00:00")],
      ["notification", "n3", "noise", at(DAY2, "10:00:00")],
      ["notification", "n4", "interruptive", at(DAY3, "10:00:00")],
      ["attention_item", "a1", "useful", at(DAY2, "11:00:00")],
      ["review_item", "r1", "incorrect", at(DAY2, "12:00:00")],
      ["brief_section", "b1", "missed", at(DAY3, "09:00:00")],
      ["event", "e1", "interruptive", at(DAY1, "12:00:00")],
    ];
    for (const [itemType, itemId, verdict, atTime] of seed) {
      await recordFeedback(
        db.pool,
        { itemType: itemType as "notification", itemId, verdict: verdict as "useful" },
        { now: () => new Date(atTime) },
      );
    }
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("no feedback at all → signalQuality null (unmeasured, not zero)", async () => {
    // this db HAS feedback; a window after all of it proves the guard
    const report = await computeMetrics(db.pool, {
      since: "2027-01-01T00:00:00Z",
      now: () => new Date("2027-01-02T00:00:00Z"),
    });
    expect(report.signalQuality).toBeNull();
  });

  it("counts + per-verdict rates + per-item_type breakdown on seeded feedback", async () => {
    const report = await computeMetrics(db.pool, { now: () => new Date(at(DAY3, "18:00:00")) });
    const sq = report.signalQuality!;
    expect(sq).not.toBeNull();
    // useful: n1, a1 = 2 · noise: n1-noise, n2, n3 = 3 · missed: b1 ·
    // incorrect: r1 · interruptive: e1, n4 = 2 → total 9 (re-tap deduped)
    expect(sq.total).toBe(9);
    expect(sq.counts).toEqual({ useful: 2, noise: 3, missed: 1, incorrect: 1, interruptive: 2 });
    expect(sq.rates).toEqual({
      useful: 2 / 9,
      noise: 3 / 9,
      missed: 1 / 9,
      incorrect: 1 / 9,
      interruptive: 2 / 9,
    });
    // false attention: noise 3 / (noise 3 + useful 2) on notification/attention
    expect(sq.falseAttentionRate).toBeCloseTo(3 / 5, 10);
    expect(sq.byItemType).toEqual([
      { itemType: "notification", total: 5, counts: { useful: 1, noise: 3, missed: 0, incorrect: 0, interruptive: 1 } },
      { itemType: "attention_item", total: 1, counts: { useful: 1, noise: 0, missed: 0, incorrect: 0, interruptive: 0 } },
      { itemType: "brief_section", total: 1, counts: { useful: 0, noise: 0, missed: 1, incorrect: 0, interruptive: 0 } },
      { itemType: "event", total: 1, counts: { useful: 0, noise: 0, missed: 0, incorrect: 0, interruptive: 1 } },
      { itemType: "review_item", total: 1, counts: { useful: 0, noise: 0, missed: 0, incorrect: 1, interruptive: 0 } },
    ]);
  });

  it("falseAttentionRate is null without noise/useful verdicts on notification/attention items", async () => {
    await recordFeedback(
      db.pool,
      { itemType: "review_item", itemId: "r2", verdict: "incorrect" },
      { now: () => new Date(at(DAY3, "17:00:00")) },
    );
    const report = await computeMetrics(db.pool, {
      since: `${DAY3}T16:00:00Z`,
      now: () => new Date(at(DAY3, "18:00:00")),
    });
    // in-window feedback exists (r2) but none of it is noise/useful on the
    // attention-shaped item types → denominator 0 → null, not 0
    expect(report.signalQuality!.total).toBe(1);
    expect(report.signalQuality!.falseAttentionRate).toBeNull();
  });

  it("interruptions also count interruptive verdicts, days span both sources", async () => {
    const report = await computeMetrics(db.pool, { now: () => new Date(at(DAY3, "18:00:00")) });
    expect(report.interruptions.resolvedWaits).toBe(0); // no human_waits seeded here
    expect(report.interruptions.interruptiveVerdicts).toBe(2);
    expect(report.interruptions.total).toBe(2);
    // interruptive verdict days: day1 (e1), day3 (n4)
    expect(report.interruptions.distinctDays).toBe(2);
    expect(report.interruptions.perDay).toBeCloseTo(1, 10);
  });

  it("window filter rescopes signal quality (since day2)", async () => {
    const report = await computeMetrics(db.pool, {
      since: `${DAY2}T00:00:00Z`,
      now: () => new Date(at(DAY3, "18:00:00")),
    });
    const sq = report.signalQuality!;
    // in-window: n3 noise, n1-noise, n4 interruptive, a1 useful, r1 incorrect,
    // b1 missed, r2 incorrect (seeded by the previous test) → 7 rows;
    // falseAttention = 2 / (2 + 1)
    expect(sq.total).toBe(7);
    expect(sq.counts).toEqual({ useful: 1, noise: 2, missed: 1, incorrect: 2, interruptive: 1 });
    expect(sq.falseAttentionRate).toBeCloseTo(2 / 3, 10);
    expect(report.interruptions.interruptiveVerdicts).toBe(1); // only n4 (day3)
  });

  it("renders the signal-quality section", () => {
    const text = renderMetricsText(
      computeMetricsReportFixture({ resolvedWaits: 0, interruptiveVerdicts: 2, total: 2, distinctDays: 2, perDay: 1 }),
    );
    expect(text).toContain("signal quality (dogfooding feedback");
    expect(text).toContain("false attention rate: 60.0%");
    expect(text).not.toMatch(/ +\n/);
  });
});

/** Minimal MetricsReport with empty sections + injected interruptions. */
function computeMetricsReportFixture(
  interruptions: MetricsReport["interruptions"],
): MetricsReport {
  return {
    window: { since: null, generatedAt: at(DAY3, "18:00:00") },
    humanBlocked: { totalMs: 0, openWaits: 0, byReason: [], perRun: [] },
    interruptions,
    autonomousCompletion: { completedRuns: 0, endedRuns: 0, cancelledExcluded: 0, rate: 0 },
    falseEscalation: { resolved: 0, notNeeded: 0, rate: 0 },
    modelCost: { totalUsd: 0, calls: 0, byProviderModel: [], topRuns: [] },
    workflowStatus: { statuses: [] },
    failures: { actionAttempts: { failed: 0, unknown: 0 }, outboxErrors: [] },
    signalQuality: {
      total: 9,
      counts: { useful: 2, noise: 3, missed: 1, incorrect: 1, interruptive: 2 },
      rates: { useful: 2 / 9, noise: 3 / 9, missed: 1 / 9, incorrect: 1 / 9, interruptive: 2 / 9 },
      byItemType: [{ itemType: "notification", total: 5, counts: { useful: 1, noise: 3, missed: 0, incorrect: 0, interruptive: 1 } }],
      falseAttentionRate: 3 / 5,
    },
  };
}
