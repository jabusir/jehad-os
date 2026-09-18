// Dogfooding feedback service integration tests (E3-B). Needs PostgreSQL 16 —
// skipped unless TEST_DATABASE_URL is set (per-file isolated db). Covers:
// record + validation vocabulary, the 24h idempotent re-tap dedupe window,
// distinct verdicts recorded separately, listing (since/limit/order), the
// correlation helpers (events/notifications joins, orphans), the DB-level
// verdict CHECK, and append-only-ness (no mutation surface + corrections are
// new rows, originals intact).

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  DEFAULT_FEEDBACK_CREATED_BY,
  FEEDBACK_DEDUPE_WINDOW_MS,
  FeedbackInputError,
  listFeedback,
  listFeedbackForEvents,
  listFeedbackForNotifications,
  recordFeedback,
} from "./service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const T0 = new Date("2026-09-15T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)("feedback service (integration)", () => {
  let db: IsolatedDb;
  let domainId: string;
  let principalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "e3bfeedback");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    domainId = String(domain.rows[0]!.id);
    const principal = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
      [`owner-${randomUUID().slice(0, 8)}`],
    );
    principalId = String(principal.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  function record(
    itemType: "notification" | "attention_item" | "review_item" | "brief_section" | "event",
    itemId: string,
    verdict: "useful" | "noise" | "missed" | "incorrect" | "interruptive",
    opts: { note?: string; createdBy?: string; at?: Date } = {},
  ) {
    return recordFeedback(
      db.pool,
      { itemType, itemId, verdict, note: opts.note, createdBy: opts.createdBy },
      { now: () => opts.at ?? T0 },
    );
  }

  it("records a verdict with defaults and provenance", async () => {
    const { feedback, deduped } = await record("notification", "n1", "useful", { note: "good catch" });
    expect(deduped).toBe(false);
    expect(feedback.itemType).toBe("notification");
    expect(feedback.itemId).toBe("n1");
    expect(feedback.verdict).toBe("useful");
    expect(feedback.note).toBe("good catch");
    expect(feedback.createdBy).toBe(DEFAULT_FEEDBACK_CREATED_BY);
    expect(feedback.createdAt).toBe(T0.toISOString());

    const withPrincipal = await record("event", "e1", "missed", { createdBy: principalId });
    expect(withPrincipal.feedback.createdBy).toBe(principalId);
  });

  it("dedupes an exact re-tap inside 24h (idempotent), records again after", async () => {
    await record("notification", "n2", "noise");
    const reTap = await record("notification", "n2", "noise", { at: new Date(T0.getTime() + 23 * HOUR) });
    expect(reTap.deduped).toBe(true);
    expect(reTap.feedback.createdAt).toBe(T0.toISOString()); // the ORIGINAL row

    // past the window the same triple is a new append, original intact
    const late = await record("notification", "n2", "noise", {
      at: new Date(T0.getTime() + FEEDBACK_DEDUPE_WINDOW_MS + HOUR),
    });
    expect(late.deduped).toBe(false);
    const rows = await listFeedback(db.pool, { limit: 100 });
    const n2noise = rows.filter((r) => r.itemId === "n2" && r.verdict === "noise");
    expect(n2noise).toHaveLength(2);
    expect(n2noise.map((r) => r.createdAt)).toEqual([
      new Date(T0.getTime() + FEEDBACK_DEDUPE_WINDOW_MS + HOUR).toISOString(),
      T0.toISOString(),
    ]); // newest first
  });

  it("records distinct verdicts on the same item separately", async () => {
    await record("notification", "n3", "useful");
    const other = await record("notification", "n3", "interruptive", { at: new Date(T0.getTime() + HOUR) });
    expect(other.deduped).toBe(false);
    const rows = await listFeedback(db.pool, { limit: 100 });
    expect(rows.filter((r) => r.itemId === "n3")).toHaveLength(2);
  });

  it("rejects invalid vocabulary, empty ids, and bad notes", async () => {
    await expect(record("calendar", "x", "useful")).rejects.toBeInstanceOf(FeedbackInputError);
    await expect(record("notification", "x", "meh")).rejects.toBeInstanceOf(FeedbackInputError);
    await expect(record("notification", "", "useful")).rejects.toBeInstanceOf(FeedbackInputError);
    await expect(record("notification", "x", "useful", { note: "n".repeat(2001) })).rejects.toBeInstanceOf(
      FeedbackInputError,
    );
    await expect(record("notification", "x", "useful", { createdBy: "" })).rejects.toBeInstanceOf(
      FeedbackInputError,
    );
  });

  it("the DB CHECK rejects vocabulary escapes (raw insert)", async () => {
    await expect(
      db.pool.query(
        "INSERT INTO feedback (item_type, item_id, verdict) VALUES ('notification', 'x', 'amazing')",
      ),
    ).rejects.toThrow();
    await expect(
      db.pool.query(
        "INSERT INTO feedback (item_type, item_id, verdict) VALUES ('shoe', 'x', 'useful')",
      ),
    ).rejects.toThrow();
  });

  it("listFeedback filters by since and bounds limit", async () => {
    const day3 = new Date("2026-09-17T09:00:00.000Z");
    await record("brief_section", "b1", "missed", { at: day3 });
    const since = await listFeedback(db.pool, { since: "2026-09-17T00:00:00.000Z" });
    expect(since.map((r) => r.itemId)).toEqual(["b1"]);
    expect((await listFeedback(db.pool, { limit: 1 })).length).toBe(1);
    await expect(listFeedback(db.pool, { limit: 0 })).rejects.toBeInstanceOf(FeedbackInputError);
    await expect(listFeedback(db.pool, { since: "not-a-date" })).rejects.toBeInstanceOf(FeedbackInputError);
  });

  it("correlates event verdicts to events by id; orphans surface as null", async () => {
    const eventId = randomUUID();
    await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, idempotency_key, domain_id, payload, sensitivity, schema_version)
       VALUES ($1::uuid, 'commitment.created', 'internal', $2::timestamptz, $3, $4::uuid, '{}', 'normal', 1)`,
      [eventId, T0.toISOString(), randomUUID(), domainId],
    );
    await record("event", eventId, "incorrect");
    await record("event", randomUUID(), "useful", { at: new Date(T0.getTime() + HOUR) }); // orphan

    const rows = await listFeedbackForEvents(db.pool, {});
    const matched = rows.find((r) => r.feedback.itemId === eventId)!;
    expect(matched.event).toEqual({
      id: eventId,
      type: "commitment.created",
      occurredAt: T0.toISOString(),
    });
    const orphan = rows.find((r) => r.feedback.itemId !== eventId)!;
    expect(orphan.event).toBeNull();
  });

  it("correlates notification verdicts to notifications by id", async () => {
    const inserted = await db.pool.query<{ id: string }>(
      `INSERT INTO notifications (kind, title, payload, source_type, status, created_by, expires_at)
       VALUES ('brief', 'Morning brief', '{}', 'brief', 'delivered', $1::uuid, now() + interval '1 hour')
       RETURNING id`,
      [principalId],
    );
    const notificationId = String(inserted.rows[0]!.id);
    await record("notification", notificationId, "useful");

    const rows = await listFeedbackForNotifications(db.pool, {});
    const matched = rows.find((r) => r.feedback.itemId === notificationId)!;
    expect(matched.notification).toMatchObject({ id: notificationId, kind: "brief", status: "delivered" });
  });

  it("is append-only: no mutation surface in the service source", async () => {
    const source = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "service.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE)\b/);
    expect(source).toMatch(/INSERT INTO feedback/); // writes are inserts only
  });
});
