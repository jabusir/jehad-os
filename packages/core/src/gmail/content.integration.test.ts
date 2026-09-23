// Gmail content ingestion integration tests (ADR-0016 / roadmap §19 GC0)
// against an isolated migrated database: persist + idempotency + refresh,
// truncation, disabled/empty classes, principal isolation (deny/empty),
// retention sweeping (pinned rows survive), the no-leak scan (bodies never
// in audit_log/events), and the widened health CHECK (content dim admitted,
// bogus dims still rejected). Needs PostgreSQL 16 — skipped unless
// TEST_DATABASE_URL is set.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  DEFAULT_GMAIL_CONTENT_POLICY,
  getGmailMessageContent,
  listGmailThreadContent,
  persistGmailContent,
  searchGmailContent,
  sweepGmailContentRetention,
  type NormalizedGmailContent,
} from "./content.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-22T12:00:00.000Z");
const ACTOR = "system:gmail-sync";
const MARKER = "SIRIUS-SECRET-BODY-7Q"; // no-leak scan sentinel

function content(overrides: Partial<NormalizedGmailContent> & { id: string }): NormalizedGmailContent {
  return {
    threadId: `thr-${overrides.id}`,
    from: "quotes@acme.com",
    to: ["jehad@example.com"],
    subject: "Packaging quote",
    snippet: "quote snippet",
    textPlain: `${MARKER}: $1.20/unit at 5000 MOQ, valid 3 weeks.`,
    internalDate: "2026-09-22T02:14:00.000Z",
    attachments: [],
    ...overrides,
  };
}

const ENABLED = { ...DEFAULT_GMAIL_CONTENT_POLICY, enabled: true };

describe.skipIf(TEST_DATABASE_URL === undefined)("gmail content (GC0, ADR-0016)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "gmailcontent");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  function q(sql: string, params: readonly unknown[] = []): { rows: Array<Record<string, unknown>> } {
    return db.pool.query(sql, params) as unknown as { rows: Array<Record<string, unknown>> };
  }

  // The service seam: SqlExecutor (query(sql, params)) over the pool.
  const exec = {
    query: (sql: string, params: readonly unknown[] = []) => db.pool.query(sql, params as unknown[]),
  };

  it("persists a source record: untrusted label, body, sha, provenance; audit carries ids only", async () => {
    const result = await persistGmailContent(exec, content({ id: "m1" }), {
      policy: ENABLED,
      observedHistoryId: 7001,
      now: NOW,
      actor: ACTOR,
    });
    expect(result.status).toBe("stored");

    const record = await getGmailMessageContent(exec, "josctl", "m1");
    expect(record).not.toBeNull();
    expect(record!.sourceTrustClass).toBe("untrusted_external");
    expect(record!.bodyText).toContain(MARKER);
    expect(record!.fromAddr).toBe("quotes@acme.com");
    expect(record!.internalDate).toBe("2026-09-22T02:14:00.000Z");
    expect(record!.ingestedAt).toBe(NOW.toISOString());

    // No-leak: the persisted-content audit line carries sha/bytes/ids —
    // never the body text.
    const audits = await q(
      `SELECT outputs_ref FROM audit_log WHERE action = 'gmail.content.persisted'`,
    );
    expect(audits.rows.length).toBe(1);
    expect(audits.rows[0]!.outputs_ref).not.toContain(MARKER);
  });

  it("is idempotent (same sha → unchanged) and refreshes on content change", async () => {
    const again = await persistGmailContent(exec, content({ id: "m1" }), {
      policy: ENABLED,
      observedHistoryId: 7001,
      now: NOW,
      actor: ACTOR,
    });
    expect(again.status).toBe("unchanged");

    const revised = await persistGmailContent(exec, content({ id: "m1", textPlain: `${MARKER} rev2` }), {
      policy: ENABLED,
      observedHistoryId: 7002,
      now: NOW,
      actor: ACTOR,
    });
    expect(revised.status).toBe("stored");
    expect((await getGmailMessageContent(exec, "josctl", "m1"))!.bodyText).toContain("rev2");
  });

  it("an empty/disabled body class never creates a row (honest absence)", async () => {
    expect(
      (await persistGmailContent(exec, content({ id: "m2", textPlain: null }), {
        policy: ENABLED, observedHistoryId: null, now: NOW, actor: ACTOR,
      })).status,
    ).toBe("empty");
    expect(
      (await persistGmailContent(exec, content({ id: "m3" }), {
        policy: { ...ENABLED, enabled: false }, observedHistoryId: null, now: NOW, actor: ACTOR,
      })).status,
    ).toBe("empty");
    expect(await getGmailMessageContent(exec, "josctl", "m2")).toBeNull();
    expect(await getGmailMessageContent(exec, "josctl", "m3")).toBeNull();
  });

  it("truncates bodies to the byte cap without splitting a code point", async () => {
    const tricky = "é".repeat(200_000); // 2 bytes/char — cap mid-code-point
    await persistGmailContent(exec, content({ id: "m4", textPlain: tricky }), {
      policy: { ...ENABLED, maxBodyBytes: 1000 },
      observedHistoryId: null,
      now: NOW,
      actor: ACTOR,
    });
    const record = await getGmailMessageContent(exec, "josctl", "m4");
    expect(record!.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(record!.bodyText!, "utf8")).toBeLessThanOrEqual(1000);
    expect(record!.bodyText!.endsWith("é")).toBe(true); // no mojibake tail
  });

  it("principal isolation: foreign principal / unknown id → null and empty sets", async () => {
    await persistGmailContent(exec, content({ id: "m1", threadId: "thr-iso" }), {
      policy: ENABLED, observedHistoryId: null, now: NOW, actor: ACTOR,
    });
    expect(await getGmailMessageContent(exec, "yusra", "m1")).toBeNull();
    expect(await getGmailMessageContent(exec, "josctl", "foreign-msg-id")).toBeNull();
    expect(await listGmailThreadContent(exec, "yusra", "thr-iso")).toEqual([]);
    expect(await searchGmailContent(exec, "yusra", { fromContains: "acme.com" })).toEqual([]);
    // The owner still sees the row (control, not over-blocking).
    expect((await searchGmailContent(exec, "josctl", { fromContains: "acme.com" })).length).toBeGreaterThan(0);
  });

  it("retention sweep deletes past-window unpinned rows only (pinned survives)", async () => {
    await persistGmailContent(exec, content({ id: "old-1", threadId: "thr-old" }), {
      policy: ENABLED, observedHistoryId: null,
      now: new Date(NOW.getTime() - 30 * 86_400_000), actor: ACTOR,
    });
    await persistGmailContent(exec, content({ id: "new-1", threadId: "thr-new" }), {
      policy: ENABLED, observedHistoryId: null, now: NOW, actor: ACTOR,
    });
    await q(`UPDATE gmail_messages SET pinned = true WHERE gmail_message_id = 'old-1'`);

    const deleted = await sweepGmailContentRetention(exec, {
      retentionDays: 14, now: NOW, actor: ACTOR,
    });
    // old-1 pinned survives; other aged rows (from prior tests) may also
    // delete — assert the invariants, not the raw count.
    expect(await getGmailMessageContent(exec, "josctl", "old-1")).not.toBeNull();
    expect(await getGmailMessageContent(exec, "josctl", "new-1")).not.toBeNull();

    // Unpin → now the sweep takes it (and only the audit count records it).
    await q(`UPDATE gmail_messages SET pinned = false WHERE gmail_message_id = 'old-1'`);
    const deleted2 = await sweepGmailContentRetention(exec, {
      retentionDays: 14, now: NOW, actor: ACTOR,
    });
    expect(deleted2).toBeGreaterThanOrEqual(1);
    expect(await getGmailMessageContent(exec, "josctl", "old-1")).toBeNull();
    expect(deleted).toBeGreaterThanOrEqual(0);
  });

  it("no-leak scan: bodies appear in NO audit_log.outputs_ref and NO events.payload", async () => {
    await persistGmailContent(exec, content({ id: "leak-check" }), {
      policy: ENABLED, observedHistoryId: null, now: NOW, actor: ACTOR,
    });
    for (const [table, column] of [
      ["audit_log", "outputs_ref"],
      ["audit_log", "inputs_ref"],
      ["events", "payload"],
    ] as const) {
      const hits = await q(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${column}::text LIKE $1`,
        [`%${MARKER}%`],
      );
      expect(hits.rows[0]!.n, `${table}.${column} leaked body content`).toBe(0);
    }
  });

  it("the widened health CHECK admits the content dim and still rejects bogus dims", async () => {
    // Ensure the singleton row exists (nothing else created it in this suite).
    await q(
      `INSERT INTO gmail_sync_state (id, cursor_history_id, health, last_tick_at)
       VALUES ('singleton', 7000, '{}'::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET health = '{}'::jsonb`,
    );
    await q(
      `UPDATE gmail_sync_state SET health = $1::jsonb WHERE id = 'singleton'`,
      [JSON.stringify({ process: "healthy", credential: "healthy", cursor: "healthy", decode: "healthy", quota: "healthy", content: "degraded" })],
    );
    await expect(
      q(
        `UPDATE gmail_sync_state SET health = $1::jsonb WHERE id = 'singleton'`,
        [JSON.stringify({ process: "healthy", content: "degraded", psychic: "healthy" })],
      ),
    ).rejects.toThrow(/health/);
    // Restore a valid five-dim snapshot (subset containment still passes).
    await q(
      `UPDATE gmail_sync_state SET health = $1::jsonb WHERE id = 'singleton'`,
      [JSON.stringify({ process: "healthy", credential: "healthy", cursor: "healthy", decode: "healthy", quota: "healthy" })],
    );
  });
});
