import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { collectSystemState, renderSystemStateText, SYSTEM_STATE_LIMITATIONS } from "./system-state.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-21T12:00:00.000Z");
const now = (): Date => NOW;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe.skipIf(!TEST_DATABASE_URL)("system.state (integration)", () => {
  let db: IsolatedDb;
  let principalA: string;
  let principalB: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w7sysstate");
    await migrateUp(db.pool);
    await seedDomains(db.pool);

    const mkPrincipal = async (name: string): Promise<string> => {
      const inserted = await db.pool.query(
        `INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id`,
        [name],
      );
      return String(inserted.rows[0]!.id);
    };
    principalA = await mkPrincipal(`w7-jehad-${randomUUID().slice(0, 8)}`);
    principalB = await mkPrincipal(`w7-yusra-${randomUUID().slice(0, 8)}`);

    const domainId = String(
      (
        await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`)
      ).rows[0]!.id,
    );

    const mkRun = async (principalId: string): Promise<string> =>
      String(
        (
          await db.pool.query(
            `INSERT INTO runs (kind, principal_id, status, domain_id)
             VALUES ('workflow', $1::uuid, 'running', $2::uuid) RETURNING id`,
            [principalId, domainId],
          )
        ).rows[0]!.id,
      );
    const runA1 = await mkRun(principalA);
    const runB = await mkRun(principalB);

    const mkGrant = async (args: {
      principalId: string;
      capability: string;
      expiresAt: Date;
      revokedAt?: Date;
    }): Promise<void> => {
      await db.pool.query(
        `INSERT INTO capability_grants
           (principal_id, capability, resource, domain_id, expires_at, revoked_at, token_hash)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5::timestamptz, $6::timestamptz, $7)`,
        [
          args.principalId,
          args.capability,
          `resource-${randomUUID().slice(0, 8)}`,
          domainId,
          args.expiresAt.toISOString(),
          args.revokedAt === undefined ? null : args.revokedAt.toISOString(),
          `th-${randomUUID()}`,
        ],
      );
    };
    await mkGrant({ principalId: principalA, capability: "calendar:read", expiresAt: new Date(NOW.getTime() + 7 * DAY) });
    await mkGrant({ principalId: principalA, capability: "imessage:ingest", expiresAt: new Date(NOW.getTime() + 5 * DAY) });
    await mkGrant({ principalId: principalA, capability: "read:state-summary", expiresAt: new Date(NOW.getTime() + 7 * DAY) });
    await mkGrant({ principalId: principalA, capability: "calendar:read", expiresAt: new Date(NOW.getTime() - DAY) });
    await mkGrant({
      principalId: principalA,
      capability: "imessage:ingest",
      expiresAt: new Date(NOW.getTime() + 5 * DAY),
      revokedAt: new Date(NOW.getTime() - HOUR),
    });
    await mkGrant({ principalId: principalB, capability: "send_channel:imessage", expiresAt: new Date(NOW.getTime() + 7 * DAY) });

    const mkCall = async (args: {
      runId: string;
      provider: string;
      model: string;
      costUsd: string;
      createdAt: Date;
    }): Promise<void> => {
      await db.pool.query(
        `INSERT INTO model_calls
           (run_id, provider, model, in_tokens, out_tokens, cost_usd, latency_ms, result_status, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, 10, 10, $4, 100, 'ok', $5::timestamptz, $5::timestamptz)`,
        [args.runId, args.provider, args.model, args.costUsd, args.createdAt.toISOString()],
      );
    };
    await mkCall({ runId: runA1, provider: "openai", model: "openai/gpt-4.1-mini", costUsd: "0.02", createdAt: new Date(NOW.getTime() - 2 * DAY) });
    await mkCall({ runId: runA1, provider: "openai", model: "openai/gpt-4.1-mini", costUsd: "0.03", createdAt: new Date(NOW.getTime() - 1 * DAY) });
    await mkCall({ runId: runA1, provider: "openai", model: "openai/gpt-4o-mini", costUsd: "0.04", createdAt: new Date(NOW.getTime() - 1 * DAY) });
    await mkCall({ runId: runA1, provider: "google", model: "google/gemini-3.8-flash", costUsd: "0.01", createdAt: new Date("2026-09-01T00:00:00.000Z") });
    await mkCall({ runId: runA1, provider: "anthropic", model: "anthropic/claude-sonnet-4.5", costUsd: "0.001", createdAt: new Date(NOW.getTime() - 3 * DAY) });
    await mkCall({ runId: runA1, provider: "openai", model: "openai/gpt-4.1-mini", costUsd: "5.00", createdAt: new Date("2026-08-31T23:59:59.999Z") });
    await mkCall({ runId: runB, provider: "openai", model: "openai/gpt-4.1-mini", costUsd: "9.99", createdAt: new Date(NOW.getTime() - 1 * DAY) });

    const mkFeedback = async (args: {
      itemType: string;
      verdict: string;
      createdBy: string;
      createdAt: Date;
      sourceAttribution: string | null;
    }): Promise<void> => {
      await db.pool.query(
        `INSERT INTO feedback
           (item_type, item_id, verdict, note, created_by, created_at, source_attribution)
         VALUES ($1, $2, $3, NULL, $4, $5::timestamptz, $6)`,
        [
          args.itemType,
          `item-${randomUUID().slice(0, 8)}`,
          args.verdict,
          args.createdBy,
          args.createdAt.toISOString(),
          args.sourceAttribution,
        ],
      );
    };
    await mkFeedback({ itemType: "calibration", verdict: "missed", createdBy: principalA, createdAt: new Date(NOW.getTime() - 1 * DAY), sourceAttribution: "source_not_connected" });
    await mkFeedback({ itemType: "calibration", verdict: "missed", createdBy: principalA, createdAt: new Date(NOW.getTime() - 2 * DAY), sourceAttribution: "source_not_connected" });
    await mkFeedback({ itemType: "calibration", verdict: "missed", createdBy: principalA, createdAt: new Date(NOW.getTime() - 5 * DAY), sourceAttribution: "unknown" });
    await mkFeedback({ itemType: "calibration", verdict: "missed", createdBy: principalA, createdAt: new Date(NOW.getTime() - 31 * DAY), sourceAttribution: "source_not_connected" });
    await mkFeedback({ itemType: "calibration", verdict: "noise", createdBy: principalA, createdAt: new Date(NOW.getTime() - 1 * DAY), sourceAttribution: "source_not_connected" });
    await mkFeedback({ itemType: "event", verdict: "missed", createdBy: principalA, createdAt: new Date(NOW.getTime() - 1 * DAY), sourceAttribution: "source_not_connected" });
    await mkFeedback({ itemType: "calibration", verdict: "missed", createdBy: principalB, createdAt: new Date(NOW.getTime() - 1 * DAY), sourceAttribution: "source_not_connected" });

    await db.pool.query(
      `INSERT INTO calendar_sync_state (id, calendar_id, sync_token, last_synced_at, last_page_count)
       VALUES (1, 'w7-cal', NULL, $1::timestamptz, 0)`,
      [new Date(NOW.getTime() - 7 * HOUR).toISOString()],
    );
    await db.pool.query(
      `INSERT INTO gmail_sync_state (id, cursor_history_id, health, last_tick_at)
       VALUES ('singleton', NULL, '{}'::jsonb, $1::timestamptz)`,
      [new Date(NOW.getTime() - 30 * 60_000).toISOString()],
    );
    await db.pool.query(
      `INSERT INTO imessage_sensor_state
         (singleton, cursor_rowid, db_generation, schema_fingerprint,
          health_process, health_database, health_decoder, health_cursor, health_shadow, updated_at)
       VALUES (true, 42, NULL, NULL, 'healthy', 'healthy', 'healthy', 'healthy', 'healthy', $1::timestamptz)`,
      [new Date(NOW.getTime() - 2 * HOUR).toISOString()],
    );
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("golden render: full world, deterministic labeled sections", async () => {
    const data = await collectSystemState(db.pool, {
      principalId: principalA,
      now,
      policyReads: ["calendar", "commitments", "gmail"],
      actionsEnabled: true,
      env: { JEHAD_GIT_SHA: "abc123def", JEHAD_DEPLOYED_AT: "2026-09-21T08:00:00Z" },
    });
    expect(renderSystemStateText(data)).toBe(
      [
        "System state",
        "",
        "SOURCES",
        "- calendar: synced 7h ago (stale)",
        "- gmail: synced under 1h ago",
        "- imessage: synced 2h ago",
        "",
        "CAPABILITIES",
        "- reads: calendar, commitments, gmail",
        "- grants: 3 active — calendar:read, imessage:ingest, read:state-summary",
        "- actions: enabled",
        "",
        "VERSION",
        "- git: abc123def",
        `- node: ${process.version}`,
        "- deployed: 2026-09-21T08:00:00.000Z",
        "",
        "COST THIS MONTH",
        "- total: $0.10 across 5 calls (scoped to this principal's runs)",
        "- openai/gpt-4.1-mini: 2 calls, $0.05",
        "- openai/gpt-4o-mini: 1 call, $0.04",
        "- google/gemini-3.8-flash: 1 call, $0.01",
        "",
        "COVERAGE GAPS",
        "- 3 calibration misses in the last 30 days:",
        "- source_not_connected ×2",
        "- unknown ×1",
        "",
        "LIMITS",
        ...SYSTEM_STATE_LIMITATIONS.map((l) => `- ${l}`),
        "",
      ].join("\n"),
    );
  });

  it("principal scoping: another principal's grants, costs, and misses never appear", async () => {
    const dataA = await collectSystemState(db.pool, { principalId: principalA, now });
    const serializedA = JSON.stringify(dataA);
    const textA = renderSystemStateText(dataA);
    expect(serializedA).not.toContain("send_channel:imessage");
    expect(textA).not.toContain("send_channel:imessage");
    expect(textA).not.toContain("9.99");
    expect(dataA.coverageGaps).toEqual([
      { source: "source_not_connected", missCount: 2 },
      { source: "unknown", missCount: 1 },
    ]);

    const dataB = await collectSystemState(db.pool, { principalId: principalB, now });
    expect(dataB.capabilities.grants).toEqual({
      count: 1,
      capabilityNames: ["send_channel:imessage"],
    });
    expect(dataB.cost.callsMonthToDate).toBe(1);
    expect(dataB.cost.monthToDateUsd).toBeCloseTo(9.99, 10);
    expect(dataB.cost.byModelTop3).toEqual([
      { model: "openai/gpt-4.1-mini", calls: 1, usd: 9.99 },
    ]);
    expect(dataB.coverageGaps).toEqual([
      { source: "source_not_connected", missCount: 1 },
    ]);
    const textB = renderSystemStateText(dataB);
    expect(textB).toContain("send_channel:imessage");
    expect(textB).not.toContain("read:state-summary");
  });

  it("grants: expired and revoked rows are excluded from count and names", async () => {
    const data = await collectSystemState(db.pool, { principalId: principalA, now });
    expect(data.capabilities.grants.count).toBe(3);
    expect(data.capabilities.grants.capabilityNames).toEqual([
      "calendar:read",
      "imessage:ingest",
      "read:state-summary",
    ]);
  });

  it("cost: current UTC month window, top-3 cap, principal scoping via runs join", async () => {
    const data = await collectSystemState(db.pool, { principalId: principalA, now });
    expect(data.cost.callsMonthToDate).toBe(5);
    expect(data.cost.monthToDateUsd).toBeCloseTo(0.101, 10);
    expect(data.cost.byModelTop3).toEqual([
      { model: "openai/gpt-4.1-mini", calls: 2, usd: 0.05 },
      { model: "openai/gpt-4o-mini", calls: 1, usd: 0.04 },
      { model: "google/gemini-3.8-flash", calls: 1, usd: 0.01 },
    ]);
    expect(data.cost.byModelTop3.map((m) => m.model)).not.toContain(
      "anthropic/claude-sonnet-4.5",
    );
    const text = renderSystemStateText(data);
    expect(text).not.toContain("5.00");
    expect(text).not.toContain("claude");
  });

  it("staleness boundaries reuse W1's 6h threshold (strictly-greater is stale)", async () => {
    await db.pool.query(`UPDATE calendar_sync_state SET last_synced_at = $1::timestamptz`, [
      new Date(NOW.getTime() - 6 * HOUR).toISOString(),
    ]);
    const exact = await collectSystemState(db.pool, { principalId: principalA, now });
    expect(exact.sources[0]).toMatchObject({ source: "calendar", connected: true, stale: false });

    await db.pool.query(`UPDATE calendar_sync_state SET last_synced_at = $1::timestamptz`, [
      new Date(NOW.getTime() - (6 * HOUR + 60_000)).toISOString(),
    ]);
    const over = await collectSystemState(db.pool, { principalId: principalA, now });
    expect(over.sources[0]).toMatchObject({ source: "calendar", connected: true, stale: true });
    expect(renderSystemStateText(over)).toContain("- calendar: synced 6h ago (stale)");

    await db.pool.query(`UPDATE calendar_sync_state SET last_synced_at = NULL`);
    const never = await collectSystemState(db.pool, { principalId: principalA, now });
    expect(never.sources[0]).toMatchObject({ source: "calendar", connected: false, stale: true });
    expect(renderSystemStateText(never)).toContain("- calendar: not connected");

    await db.pool.query(`UPDATE calendar_sync_state SET last_synced_at = $1::timestamptz`, [
      new Date(NOW.getTime() - 7 * HOUR).toISOString(),
    ]);
  });

  it("read-only pin: row counts of every read table (and audit_log) are unchanged", async () => {
    const tables = [
      "capability_grants",
      "calendar_sync_state",
      "gmail_sync_state",
      "imessage_sensor_state",
      "model_calls",
      "feedback",
      "runs",
      "events",
      "audit_log",
    ];
    const countsBefore = new Map<string, number>();
    for (const table of tables) {
      const result = await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      countsBefore.set(table, Number(result.rows[0]!.n));
    }
    await collectSystemState(db.pool, { principalId: principalA, now });
    await collectSystemState(db.pool, {
      principalId: principalB,
      now,
      policyReads: [],
      actionsEnabled: false,
      env: {},
    });
    for (const table of tables) {
      const result = await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(Number(result.rows[0]!.n), table).toBe(countsBefore.get(table));
    }
  });
});
