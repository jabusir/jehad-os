// Gmail sync integration tests (GMAIL Lane G2 — plan §13.1–§13.4, §13.8,
// §13.10) against an isolated migrated database: bootstrap + cursor,
// incremental history walk + externalId idempotency, 404 re-bootstrap
// recovery, non-INBOX skip, flood-cap deferral, per-message failure skip,
// health snapshots, no-token clean skip, candidate landing for allowlist
// senders, and the content-free event scan. Needs PostgreSQL 16 — skipped
// unless TEST_DATABASE_URL is set.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  isHistoryExpired,
  normalizeGmailMessage,
  syncGmail,
  type GmailHistoryPage,
  type GmailMessage,
  type GmailMessageListPage,
  type GmailSyncPort,
} from "./sync.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-20T12:00:00.000Z");
const now = (): Date => NOW;

const POLICY = {
  enabled: true,
  pollCron: null,
  bootstrapDays: 30,
  extractSenders: ["billing@*", "*@stripe.com"],
  maxMessagesPerPoll: 50,
  maxCandidatesPerDay: 20,
  contentEnabled: false,
  contentRetentionDays: 7,
  contentMaxBodyBytes: 256 * 1024,
} as const;

/** The 404-expiry contract error (the G1 adapter's class, structurally). */
class GmailHistoryExpiredError extends Error {
  constructor() {
    super("gmail history expired (HTTP 404); full resync required");
    this.name = "GmailHistoryExpiredError";
  }
}

interface FakeGmail {
  readonly adapter: GmailSyncPort;
  readonly store: Map<string, GmailMessage>;
  readonly failedIds: Set<string>;
  hasToken: boolean;
  bootstrapPage: GmailMessageListPage;
  historyScript: GmailHistoryPage[];
  expireHistoryIds: number[];
  readonly bootstrapCalls: { newerThanDays: number; pageToken?: string }[];
  readonly historyCalls: { startHistoryId: number; pageToken?: string }[];
  readonly fetched: string[];
}

function fakeGmail(): FakeGmail {
  const store = new Map<string, GmailMessage>();
  const failedIds = new Set<string>();
  const bootstrapCalls: FakeGmail["bootstrapCalls"] = [];
  const historyCalls: FakeGmail["historyCalls"] = [];
  const fetched: string[] = [];
  const fake: FakeGmail = {
    store,
    failedIds,
    hasToken: true,
    bootstrapPage: { messages: [], nextPageToken: null, historyId: 0 },
    historyScript: [],
    expireHistoryIds: [],
    bootstrapCalls,
    historyCalls,
    fetched,
    adapter: {
      id: "adapter:gmail",
      async hasToken() {
        return fake.hasToken;
      },
      async listBootstrapMessages(opts) {
        bootstrapCalls.push({ newerThanDays: opts.newerThanDays, pageToken: opts.pageToken });
        return fake.bootstrapPage;
      },
      async listHistory(opts) {
        historyCalls.push({ startHistoryId: opts.startHistoryId, pageToken: opts.pageToken });
        if (fake.expireHistoryIds.includes(opts.startHistoryId)) {
          throw new GmailHistoryExpiredError();
        }
        const page = fake.historyScript.shift();
        if (page === undefined) throw new Error("scripted history exhausted");
        return page;
      },
      async getMessage(opts) {
        fetched.push(opts.id);
        if (failedIds.has(opts.id)) throw new Error("GmailApiError simulated");
        const message = store.get(opts.id);
        if (message === undefined) throw new Error(`no message ${opts.id}`);
        return message;
      },
    },
  };
  return fake;
}

function message(overrides: Partial<GmailMessage> & { id: string }): GmailMessage {
  return {
    threadId: `t-${overrides.id}`,
    labelIds: ["INBOX"],
    internalDate: String(Date.parse("2026-09-19T10:00:00.000Z")),
    sizeEstimate: 1234,
    from: "Billing <billing@acme.com>",
    to: ["Jehad <jehad@example.com>"],
    subject: "Your September invoice",
    snippet: "Your September invoice is ready",
    textPlain: null,
    attachments: [],
    ...overrides,
  };
}

const BILL_MAIL = () =>
  message({
    id: "bill1",
    threadId: "t-bill-1",
    from: "Acme Billing <billing@acme.com>",
    subject: "Invoice #42",
    textPlain: "Please pay $120.00 by September 30.",
  });

describe.skipIf(!TEST_DATABASE_URL)("gmail sync (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "g2gmail");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function gmailEventCount(): Promise<number> {
    const result = await db.pool.query(
      `SELECT count(*)::int AS n FROM events WHERE source = 'adapter:gmail' AND type = 'gmail.message.received'`,
    );
    return result.rows[0].n as number;
  }

  async function state(): Promise<{ cursor: number | null; health: Record<string, string>; lastTick: Date | null }> {
    const result = await db.pool.query(
      `SELECT cursor_history_id, health, last_tick_at FROM gmail_sync_state WHERE id = 'singleton'`,
    );
    const row = result.rows[0];
    return {
      cursor:
        row?.cursor_history_id === null || row?.cursor_history_id === undefined
          ? null
          : Number(row.cursor_history_id),
      health: (row?.health ?? {}) as Record<string, string>,
      lastTick: row?.last_tick_at ?? null,
    };
  }

  /** Pins the singleton cursor so each test owns its starting mode. */
  async function setCursor(cursorHistoryId: number | null): Promise<void> {
    await db.pool.query(
      `INSERT INTO gmail_sync_state (id, cursor_history_id, health, last_tick_at)
       VALUES ('singleton', $1, '{}'::jsonb, $2::timestamptz)
       ON CONFLICT (id) DO UPDATE SET cursor_history_id = $1, updated_at = now()`,
      [cursorHistoryId, NOW.toISOString()],
    );
  }

  it("bootstrap: empty cursor → window list → one event per message; cursor = newest historyId (§13.1)", async () => {    await setCursor(null);
    const fake = fakeGmail();
    fake.store.set("m1", message({ id: "m1" }));
    fake.store.set("m2", message({ id: "m2", from: "Sam <sam@other.org>" }));
    fake.store.set("m3", message({ id: "m3", labelIds: ["Category_Promos", "INBOX"] }));
    fake.bootstrapPage = {
      messages: [{ id: "m1", threadId: "t-m1" }, { id: "m2", threadId: "t-m2" }, { id: "m3", threadId: "t-m3" }],
      nextPageToken: null,
      historyId: 7000,
    };

    const report = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });

    expect(report.status).toBe("ok");
    expect(report.mode).toBe("bootstrap");
    expect(report.emitted).toBe(3);
    expect(fake.bootstrapCalls).toEqual([{ newerThanDays: 30, pageToken: undefined }]);
    expect(await gmailEventCount()).toBe(3);

    const events = await db.pool.query(
      `SELECT idempotency_key, payload FROM events WHERE source = 'adapter:gmail'`,
    );
    expect(events.rows.length).toBe(3);
    expect(new Set(events.rows.map((r) => r.idempotency_key)).size).toBe(3);
    // §4 content-free payload shape.
    const p1 = events.rows.find((r) => r.payload.messageId === "m1")!.payload;
    expect(p1).toMatchObject({
      messageId: "m1",
      threadRef: "t-m1",
      fromDomain: "acme.com",
      toDomains: ["example.com"],
      labelIds: ["INBOX"],
      sizeClass: "small",
    });
    expect(typeof p1.senderSha256).toBe("string");
    expect(p1.senderSha256).toHaveLength(64);
    expect(p1.receivedAt).toBe("2026-09-19T10:00:00.000Z");

    const s = await state();
    expect(s.cursor).toBe(7000);
    expect(s.health).toEqual({
      process: "healthy",
      credential: "healthy",
      cursor: "healthy",
      decode: "healthy",
      quota: "healthy",
      content: "healthy",
    });
    expect(s.lastTick?.toISOString()).toBe(NOW.toISOString());
  });

  it("bootstrap replay: identical window → deduped refs skip free, zero duplicate events (§13.1 dedupe)", async () => {
    await setCursor(null);
    const before = await gmailEventCount();
    const fake = fakeGmail();
    // m1/m2/m3 already ingested by the first bootstrap test — the replay
    // window is fully known, so NOTHING is refetched (bounded-work rule).
    fake.bootstrapPage = {
      messages: [{ id: "m1", threadId: "t-m1" }, { id: "m2", threadId: "t-m2" }, { id: "m3", threadId: "t-m3" }],
      nextPageToken: null,
      historyId: 7000,
    };
    const report = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });
    expect(report.deduped).toBe(0);
    expect(report.emitted).toBe(0);
    expect(fake.fetched).toEqual([]); // known refs skip without getMessage
    expect(await gmailEventCount()).toBe(before);
    expect((await state()).cursor).toBe(7000);
  });

  it("incremental: new message → exactly one event; cursor advances (§13.2)", async () => {
    await setCursor(7000);
    const before = await gmailEventCount();
    const fake = fakeGmail();
    fake.store.set("m4", message({ id: "m4" }));
    fake.historyScript = [
      {
        records: [{ id: 7001, messagesAdded: [{ id: "m4", threadId: "t-m4", labelIds: ["INBOX"] }] }],
        nextPageToken: null,
        historyId: 7001,
      },
    ];
    const report = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });

    expect(report.mode).toBe("incremental");
    expect(fake.historyCalls).toEqual([{ startHistoryId: 7000, pageToken: undefined }]);
    expect(report.emitted).toBe(1);
    expect(await gmailEventCount()).toBe(before + 1);
    expect((await state()).cursor).toBe(7001);
  });

  it("redelivered history record → zero duplicates (idempotency key)", async () => {
    await setCursor(7000);
    const before = await gmailEventCount();
    const fake = fakeGmail();
    fake.store.set("m4", message({ id: "m4" }));
    fake.historyScript = [
      {
        records: [{ id: 7001, messagesAdded: [{ id: "m4", threadId: "t-m4", labelIds: ["INBOX"] }] }],
        nextPageToken: null,
        historyId: 7001,
      },
    ];
    const report = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });
    expect(report.emitted).toBe(0);
    expect(report.deduped).toBe(1);
    expect(await gmailEventCount()).toBe(before);
  });

  it("non-INBOX messageAdded skips without a fetch or event (§3.8)", async () => {
    await setCursor(7001);
    const before = await gmailEventCount();
    const fake = fakeGmail();
    fake.store.set("m-spam", message({ id: "m-spam", labelIds: ["SPAM"] }));
    fake.historyScript = [
      {
        records: [
          {
            id: 7002,
            messagesAdded: [
              { id: "m-spam", threadId: "t-m-spam", labelIds: ["SPAM"] },
              { id: "m5", threadId: "t-m5", labelIds: ["INBOX"] },
            ],
          },
        ],
        nextPageToken: null,
        historyId: 7002,
      },
    ];
    fake.store.set("m5", message({ id: "m5" }));
    const report = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });

    expect(report.nonInboxSkipped).toBe(1);
    expect(report.emitted).toBe(1);
    expect(fake.fetched).toEqual(["m5"]); // the SPAM ref never reached getMessage
    expect(await gmailEventCount()).toBe(before + 1);
    expect((await state()).cursor).toBe(7002);
  });

  it("flood cap: excess deferred to next tick; cursor held back (§9.3/§13.10)", async () => {
    await setCursor(8000);
    const capped = { ...POLICY, maxMessagesPerPoll: 2 };
    const fake = fakeGmail();
    for (const id of ["c1", "c2", "c3"]) fake.store.set(id, message({ id }));
    fake.historyScript = [
      {
        records: [
          { id: 8001, messagesAdded: [{ id: "c1", threadId: "t-c1", labelIds: ["INBOX"] }] },
          {
            id: 8002,
            messagesAdded: [
              { id: "c2", threadId: "t-c2", labelIds: ["INBOX"] },
              { id: "c3", threadId: "t-c3", labelIds: ["INBOX"] },
            ],
          },
        ],
        nextPageToken: null,
        historyId: 8003,
      },
    ];
    const report = await syncGmail(db.pool, fake.adapter, { now, policy: capped });

    expect(report.emitted).toBe(2);
    expect(report.capped).toBe(true);
    expect(report.deferred).toBe(1);
    expect(report.health.quota).toBe("degraded");
    // Cursor passed 8001 only — 8002 was not fully processed.
    expect((await state()).cursor).toBe(8001);

    // Next tick resumes from 8001 and drains the remainder.
    fake.historyScript = [
      {
        records: [
          {
            id: 8002,
            messagesAdded: [
              { id: "c2", threadId: "t-c2", labelIds: ["INBOX"] },
              { id: "c3", threadId: "t-c3", labelIds: ["INBOX"] },
            ],
          },
        ],
        nextPageToken: null,
        historyId: 8003,
      },
    ];
    const second = await syncGmail(db.pool, fake.adapter, { now, policy: capped });
    expect(fake.historyCalls.at(-1)).toEqual({ startHistoryId: 8001, pageToken: undefined });
    // Record 8002 redelivers c2 (dedupe) + c3 (new) — exactly-once overall.
    expect(second.emitted).toBe(1);
    expect(second.deduped).toBe(1);
    expect(second.capped).toBe(false);
    expect((await state()).cursor).toBe(8003);
    expect((await state()).health.quota).toBe("healthy");
  });

  it("per-message failure → skip + audit + count; tick completes; cursor advances (§3.6)", async () => {
    await setCursor(8999);
    const before = await gmailEventCount();
    const fake = fakeGmail();
    fake.failedIds.add("poison");
    fake.store.set("poison", message({ id: "poison" }));
    fake.store.set("good", message({ id: "good" }));
    fake.historyScript = [
      {
        records: [
          { id: 9001, messagesAdded: [{ id: "poison", threadId: "t-poison", labelIds: ["INBOX"] }] },
          { id: 9002, messagesAdded: [{ id: "good", threadId: "t-good", labelIds: ["INBOX"] }] },
        ],
        nextPageToken: null,
        historyId: 9002,
      },
    ];
    const report = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });

    expect(report.failed).toBe(1);
    expect(report.emitted).toBe(1);
    expect(report.health.decode).toBe("degraded");
    expect(report.health.process).toBe("degraded");
    expect(await gmailEventCount()).toBe(before + 1);
    expect((await state()).cursor).toBe(9002);

    const audits = await db.pool.query(
      `SELECT outputs_ref FROM audit_log WHERE action = 'gmail.sync.message-skipped'`,
    );
    const skipped = audits.rows
      .map((r) => JSON.parse(r.outputs_ref as string))
      .find((o) => o.messageId === "poison");
    expect(skipped).toMatchObject({ messageId: "poison", reason: "fetch-failed", error: "Error" });
  });

  it("404 expired historyId → cursor cleared → re-bootstrap with idempotent re-emit (§13.3)", async () => {
    await setCursor(9002);
    const before = await gmailEventCount();
    const fake = fakeGmail();
    fake.store.set("m1", message({ id: "m1" }));
    fake.store.set("m4", message({ id: "m4" }));
    fake.store.set("m9", message({ id: "m9" }));
    // Bootstrap window: m1/m4 already emitted long ago (dedupes) + m9 new.
    fake.bootstrapPage = {
      messages: [{ id: "m1", threadId: "t-m1" }, { id: "m4", threadId: "t-m4" }, { id: "m9", threadId: "t-m9" }],
      nextPageToken: null,
      historyId: 9100,
    };
    fake.expireHistoryIds = [9002];

    const report = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });

    expect(report.fullResync).toBe(true);
    expect(report.mode).toBe("bootstrap");
    expect(report.emitted).toBe(1); // m9 only — m1/m4 known, skipped free
    expect(report.deduped).toBe(0);
    expect(fake.fetched).toEqual(["m9"]); // known refs never refetched
    expect(await gmailEventCount()).toBe(before + 1);
    expect((await state()).cursor).toBe(9100);

    const expired = await db.pool.query(
      `SELECT outputs_ref FROM audit_log WHERE action = 'gmail.sync.expired'`,
    );
    expect(expired.rows).toHaveLength(1);
  });

  it("no token → clean skip: status no-token, credential failed, cursor untouched, tick stamped (§13.10)", async () => {
    const cursorBefore = (await state()).cursor;
    const fake = fakeGmail();
    fake.hasToken = false;
    const report = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });

    expect(report.status).toBe("no-token");
    expect(report.emitted).toBe(0);
    expect(report.health).toMatchObject({ process: "healthy", credential: "failed" });
    expect((await state()).cursor).toBe(cursorBefore);
    expect((await state()).health.credential).toBe("failed");
    expect((await state()).lastTick?.toISOString()).toBe(NOW.toISOString());
  });

  it("policy disabled → kill switch skip, no adapter calls, no state write (§9.4)", async () => {
    const fake = fakeGmail();
    const report = await syncGmail(db.pool, fake.adapter, {
      now,
      policy: { ...POLICY, enabled: false },
    });
    expect(report.status).toBe("disabled");
    expect(fake.bootstrapCalls).toHaveLength(0);
    expect(fake.historyCalls).toHaveLength(0);
  });

  it("extraction: allowlist billing mail lands a commitment candidate (in_review, externally_sourced, force-review gate) + memory.proposed (§13.6)", async () => {
    await setCursor(9100);
    const fake = fakeGmail();
    fake.store.set("bill1", BILL_MAIL());
    fake.historyScript = [
      {
        records: [{ id: 10001, messagesAdded: [{ id: "bill1", threadId: "t-bill-1", labelIds: ["INBOX"] }] }],
        nextPageToken: null,
        historyId: 10001,
      },
    ];
    const report = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });

    expect(report.messages[0]).toMatchObject({ messageId: "bill1", candidates: 1 });

    const rows = await db.pool.query(
      `SELECT id, proposed_class, assertion_kind, status, payload, provenance, gate_result
         FROM memory_candidates WHERE payload->'metadata'->>'messageId' = 'bill1'`,
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(row.proposed_class).toBe("commitment");
    expect(row.assertion_kind).toBe("externally_sourced");
    expect(row.status).toBe("in_review");
    const gate = row.gate_result as { reason: string; forceReview: { source: string } };
    expect(gate.reason).toBe("force_review_source");
    expect(gate.forceReview.source).toBe("adapter:gmail");
    expect(row.payload.amount).toEqual({ cents: 12000, currency: "USD" });
    expect(row.payload.dueDate).toBe("2026-09-30");
    expect(row.payload.counterpartyText).toBe("acme.com");
    expect(row.payload.subject).toBe("Invoice #42");
    expect(row.payload.description).not.toContain("Please pay");
    expect(row.provenance.promptVersion).toBe("gmail-extract-v1");
    expect(row.provenance.model).toBeNull();

    const proposed = await db.pool.query(
      `SELECT payload FROM events WHERE type = 'memory.proposed'
         AND payload->>'candidateId' = $1`,
      [String(row.id)],
    );
    expect(proposed.rows).toHaveLength(1);
    expect(proposed.rows[0].payload.sourceEventId).toBeDefined();
    // §7.3: memory.proposed carries refs/typed fields only — no subject.
    expect(JSON.stringify(proposed.rows[0].payload)).not.toContain("Invoice #42");
  });

  it("redelivered bill mail → deterministic id no-op (zero new candidates)", async () => {
    await setCursor(10001);
    const before = await db.pool.query(`SELECT count(*)::int AS n FROM memory_candidates
      WHERE payload->'metadata'->>'gmailSource' = 'adapter:gmail'`);
    const fake = fakeGmail();
    fake.store.set("bill1", BILL_MAIL());
    fake.historyScript = [
      {
        records: [{ id: 10001, messagesAdded: [{ id: "bill1", threadId: "t-bill-1", labelIds: ["INBOX"] }] }],
        nextPageToken: null,
        historyId: 10001,
      },
    ];
    const report = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });
    expect(report.messages[0]!.candidates).toBe(0);
    const after = await db.pool.query(`SELECT count(*)::int AS n FROM memory_candidates
      WHERE payload->'metadata'->>'gmailSource' = 'adapter:gmail'`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("72h triple dedupe: same (sender, amount, dueDate) from a different message → noop (§6.6)", async () => {
    await setCursor(10001);
    const before = await db.pool.query(`SELECT count(*)::int AS n FROM memory_candidates
      WHERE payload->'metadata'->>'gmailSource' = 'adapter:gmail'`);
    const fake = fakeGmail();
    fake.store.set(
      "bill2",
      message({
        id: "bill2",
        from: "billing@acme.com",
        subject: "Reminder: Invoice #42",
        textPlain: "Amount due $120.00 by September 30.",
      }),
    );
    fake.historyScript = [
      {
        records: [{ id: 10002, messagesAdded: [{ id: "bill2", threadId: "t-bill-2", labelIds: ["INBOX"] }] }],
        nextPageToken: null,
        historyId: 10002,
      },
    ];
    const report = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });
    expect(report.messages[0]!.candidates).toBe(0); // same triple within 72h
    const after = await db.pool.query(`SELECT count(*)::int AS n FROM memory_candidates
      WHERE payload->'metadata'->>'gmailSource' = 'adapter:gmail'`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("candidate daily cap: maxCandidatesPerDay=1 → second new bill lands nothing, audited (§6.6/§13.10)", async () => {
    await setCursor(11000);
    // Order-robust cap: current today-count + 1 → the first new bill lands,
    // the second hits the cap.
    const currentRows = await db.pool.query(`SELECT count(*)::int AS n FROM memory_candidates
      WHERE payload->'metadata'->>'gmailSource' = 'adapter:gmail'`);
    const cappedPolicy = { ...POLICY, maxCandidatesPerDay: (currentRows.rows[0].n as number) + 1 };
    const fake = fakeGmail();
    fake.store.set(
      "cap1",
      message({ id: "cap1", from: "billing@cap.com", subject: "Bill", textPlain: "amount due $10 by Oct 1" }),
    );
    fake.store.set(
      "cap2",
      message({ id: "cap2", from: "billing@other.com", subject: "Bill", textPlain: "amount due $20 by Oct 2" }),
    );
    fake.historyScript = [
      {
        records: [
          { id: 11001, messagesAdded: [{ id: "cap1", threadId: "t-cap1", labelIds: ["INBOX"] }] },
          { id: 11002, messagesAdded: [{ id: "cap2", threadId: "t-cap2", labelIds: ["INBOX"] }] },
        ],
        nextPageToken: null,
        historyId: 11002,
      },
    ];
    const report = await syncGmail(db.pool, fake.adapter, { now, policy: cappedPolicy });
    expect(report.messages.find((m) => m.messageId === "cap1")!.candidates).toBe(1);
    expect(report.messages.find((m) => m.messageId === "cap2")!.candidates).toBe(0);
    const audits = await db.pool.query(`SELECT outputs_ref FROM audit_log WHERE action = 'gmail.extract.capped'`);
    expect(audits.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("non-allowlist sender → metadata event only, zero candidates (§13.6)", async () => {
    await setCursor(12000);
    const fake = fakeGmail();
    fake.store.set(
      "news1",
      message({ id: "news1", from: "news@random.org", subject: "due by Sep 25", textPlain: "amount due $99" }),
    );
    fake.historyScript = [
      {
        records: [{ id: 12001, messagesAdded: [{ id: "news1", threadId: "t-news1", labelIds: ["INBOX"] }] }],
        nextPageToken: null,
        historyId: 12001,
      },
    ];
    const report = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });
    expect(report.emitted).toBe(1);
    expect(report.messages[0]!.candidates).toBe(0);
    const rows = await db.pool.query(`SELECT count(*)::int AS n FROM memory_candidates
      WHERE payload->'metadata'->>'messageId' = 'news1'`);
    expect(rows.rows[0].n).toBe(0);
  });

  it("sensitivity scan: no subject/body/full address in any gmail event payload (§13.8)", async () => {
    const events = await db.pool.query(`SELECT payload FROM events WHERE source = 'adapter:gmail'`);
    expect(events.rows.length).toBeGreaterThan(0);
    for (const row of events.rows) {
      const serialized = JSON.stringify(row.payload);
      expect(serialized).not.toContain("Invoice #42");
      expect(serialized).not.toContain("Please pay");
      expect(serialized).not.toContain("billing@acme.com");
      expect(serialized).not.toContain("jehad@example.com");
      expect(serialized).not.toContain("subject");
    }
  });

  it("isHistoryExpired recognizes the structural contract (name or code)", () => {
    const named = new GmailHistoryExpiredError();
    expect(isHistoryExpired(named)).toBe(true);
    const coded = Object.assign(new Error("x"), { code: "GMAIL_HISTORY_EXPIRED" });
    expect(isHistoryExpired(coded)).toBe(true);
    expect(isHistoryExpired(new Error("other"))).toBe(false);
    expect(isHistoryExpired("string")).toBe(false);
  });

  it("normalizeGmailMessage: display names stripped, domains bounded+deduped, sizes classed", () => {
    const normalized = normalizeGmailMessage(
      message({
        id: "n1",
        from: "Weird <NEWS@Example.ORG>",
        to: ["A <a@one.com>", "b@one.com", "B <b@two.com>", "c@three.com", "d@four.com", "e@five.com", "f@six.com"],
        sizeEstimate: 60_000,
      }),
    );
    expect(normalized.from).toBe("news@example.org");
    expect(normalized.fromDomain).toBe("example.org");
    expect(normalized.toDomains).toEqual(["one.com", "two.com", "three.com", "four.com", "five.com"]);
    expect(normalized.sizeClass).toBe("medium");
    expect(normalized.senderSha256).toHaveLength(64);
  });

  it("bootstrap flood cap: budget counts FETCHED refs; deduped refs skip free; converges across ticks", async () => {
    // Isolated cursor view: clear state first (this test owns its world).
    await db.pool.query(`DELETE FROM gmail_sync_state`);
    const capped = { ...POLICY, maxMessagesPerPoll: 2 };
    const fake = fakeGmail();
    for (const id of ["b1", "b2", "b3"]) fake.store.set(id, message({ id }));
    fake.bootstrapPage = {
      messages: [{ id: "b1", threadId: "t-b1" }, { id: "b2", threadId: "t-b2" }, { id: "b3", threadId: "t-b3" }],
      nextPageToken: null,
      historyId: 5000,
    };
    const first = await syncGmail(db.pool, fake.adapter, { now, policy: capped });
    expect(first.emitted).toBe(2);
    expect(first.capped).toBe(true);
    expect(fake.fetched).toEqual(["b1", "b2"]); // budget = fetched refs, not accepts
    expect((await state()).cursor).toBeNull(); // not yet bootstrapped
    expect((await state()).health.cursor).toBe("degraded");

    // Second tick: b1/b2 are known → skipped FREE (no refetch); the budget
    // applies to the next unknown batch — b3 completes the drain.
    const second = await syncGmail(db.pool, fake.adapter, { now, policy: capped });
    expect(second.emitted).toBe(1);
    expect(second.deduped).toBe(0);
    expect(second.capped).toBe(false);
    expect(fake.fetched).toEqual(["b1", "b2", "b3"]);
    expect((await state()).cursor).toBe(5000);
    expect((await state()).health.cursor).toBe("healthy");
  });

  it("fully-deduped re-bootstrap is ONE cheap bounded pass: no refetches, cursor lands (GC0 dogfood finding)", async () => {
    // The degenerate case that motivated the fix: every ref already has an
    // accepted event (e.g. forced cursor clear after the window was
    // ingested). The old cap (new accepts) never tripped → unbounded drain.
    await db.pool.query(`DELETE FROM gmail_sync_state`);
    const capped = { ...POLICY, maxMessagesPerPoll: 2 };
    const fake = fakeGmail();
    for (const id of ["d1", "d2", "d3", "d4", "d5"]) fake.store.set(id, message({ id }));
    fake.bootstrapPage = {
      messages: ["d1", "d2", "d3", "d4", "d5"].map((id) => ({ id, threadId: `t-${id}` })),
      nextPageToken: null,
      historyId: 5100,
    };
    // Seed the events so every ref is known BEFORE the bootstrap tick.
    const seeded = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });
    expect(seeded.emitted).toBe(5);
    fake.fetched.length = 0;

    await db.pool.query(`UPDATE gmail_sync_state SET cursor_history_id = NULL WHERE id = 'singleton'`);
    const drained = await syncGmail(db.pool, fake.adapter, { now, policy: capped });
    expect(drained.emitted).toBe(0);
    expect(drained.capped).toBe(false); // nothing needed fetching
    expect(fake.fetched).toEqual([]);   // deduped refs skipped without a single getMessage
    expect((await state()).cursor).toBe(5100); // cursor lands — bootstrap DONE
    expect((await state()).health.cursor).toBe("healthy");
  });

  it("mixed re-bootstrap: at most K fetched refs per tick; cursor lands only on full drain (regression: unbounded deduped drain)", async () => {
    await db.pool.query(`DELETE FROM gmail_sync_state`);
    const capped = { ...POLICY, maxMessagesPerPoll: 3 };
    const fake = fakeGmail();
    for (const id of ["k1", "k2", "k3", "u1", "u2", "u3", "u4", "u5", "u6"]) {
      fake.store.set(id, message({ id }));
    }
    // Seeding tick sees ONLY the k-window: k1..k3 become known; u-refs are
    // not yet listed (the mailbox "grows" them for the capped ticks below).
    fake.bootstrapPage = {
      messages: ["k1", "k2", "k3"].map((id) => ({ id, threadId: `t-${id}` })),
      nextPageToken: null,
      historyId: 5100,
    };
    const seeded = await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });
    expect(seeded.emitted).toBe(3);
    fake.fetched.length = 0;
    await db.pool.query(`UPDATE gmail_sync_state SET cursor_history_id = NULL WHERE id = 'singleton'`);

    // The re-listed window now includes 6 unknown refs beyond the known 3.
    fake.bootstrapPage = {
      messages: ["k1", "k2", "k3", "u1", "u2", "u3", "u4", "u5", "u6"].map((id) => ({ id, threadId: `t-${id}` })),
      nextPageToken: null,
      historyId: 5200,
    };

    const tick1 = await syncGmail(db.pool, fake.adapter, { now, policy: capped });
    expect(tick1.capped).toBe(true);
    expect(fake.fetched).toEqual(["u1", "u2", "u3"]); // K budget on unknowns only
    expect((await state()).cursor).toBeNull();

    const tick2 = await syncGmail(db.pool, fake.adapter, { now, policy: capped });
    // u4..u6 are the last 3 unknowns — the budget hits K exactly at the end
    // of the page, so the drain COMPLETES this tick (cap is checked before
    // fetching; a full page drain at exactly K is completion, not a cap).
    expect(tick2.capped).toBe(false);
    expect(fake.fetched).toEqual(["u1", "u2", "u3", "u4", "u5", "u6"]); // resumed past known, nothing refetched
    expect((await state()).cursor).toBe(5200);
  });

  it("GC0 content lane: contentEnabled tick persists source records; disabled tick does not (ADR-0016)", async () => {
    await setCursor(null);
    const fake = fakeGmail();
    fake.store.set("gc1", message({
      id: "gc1",
      threadId: "t-gc1",
      from: "Acme Quotes <quotes@acme.com>",
      subject: "Packaging quote",
      snippet: "quote snippet",
      textPlain: "GC0-SYNC-MARKER: $1.20/unit at 5000 MOQ",
      attachments: [{ filename: "quote.pdf", mimeType: "application/pdf", size: 51234, attachmentId: "att-1" }],
    }));
    fake.bootstrapPage = { messages: [{ id: "gc1", threadId: "t-gc1" }], nextPageToken: null, historyId: 7100 };

    const contentPolicy = { ...POLICY, contentEnabled: true };
    const report = await syncGmail(db.pool, fake.adapter, { now, policy: contentPolicy });
    expect(report.status).toBe("ok");
    expect(report.health.content).toBe("healthy");

    const rows = await db.pool.query(`SELECT gmail_message_id, body_text, attachments, source_trust_class FROM gmail_messages`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.gmail_message_id).toBe("gc1");
    expect(rows.rows[0]!.body_text).toContain("GC0-SYNC-MARKER");
    expect(rows.rows[0]!.source_trust_class).toBe("untrusted_external");
    expect(rows.rows[0]!.attachments).toEqual([
      { filename: "quote.pdf", mimeType: "application/pdf", size: 51234, attachmentId: "att-1" },
    ]);

    // The observation event payload stays content-free (no body/snippet/subject).
    const events = await db.pool.query(
      `SELECT payload FROM events WHERE payload->>'messageId' = 'gc1'`,
    );
    expect(JSON.stringify(events.rows[0]!.payload)).not.toContain("GC0-SYNC-MARKER");
    expect(JSON.stringify(events.rows[0]!.payload)).not.toContain("quote snippet");

    // Disabled class: reset cursor, change the message, re-run → no new rows
    // from the disabled tick (and the prior row is untouched by re-ingest).
    await setCursor(null);
    fake.store.set("gc2", message({ id: "gc2", threadId: "t-gc2", textPlain: "c2 body" }));
    fake.bootstrapPage = { messages: [{ id: "gc2", threadId: "t-gc2" }], nextPageToken: null, historyId: 7200 };
    await syncGmail(db.pool, fake.adapter, { now, policy: POLICY });
    const after = await db.pool.query(`SELECT count(*)::int AS n FROM gmail_messages WHERE gmail_message_id = 'gc2'`);
    expect(after.rows[0]!.n).toBe(0);
  });

});
