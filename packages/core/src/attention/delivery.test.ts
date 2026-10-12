// Attention delivery tests (W1; ADR-0018 §1.1/§4, w1-contract "Delivery").
// Three suites:
//   1. enqueue (kind='attention' vocabulary + policy auto-approve +
//      TODAY_BASE_URL projection) — runs against the notifications queue
//      alone (migration 030), no attention kernel needed.
//   2. migration 030 up/down round-trip — CHECK vocabularies widen and
//      restore (009/016/019 precedent).
//   3. attempt/delivered stamps + retryEligibleUndelivered — GUARDED: needs
//      the attention kernel (./salience.ts, Lane B) and migration 029
//      (attention_items); skips until that lane merges, then runs against
//      the real kernel.
// Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDown, migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  loadNotificationsConfig,
  type NotificationsConfig,
} from "../notifications/config.js";
import {
  enqueueAttentionNotification,
  listNotifications,
} from "../notifications/service.js";
import type { AttentionItemRow } from "./types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const KERNEL_PRESENT =
  existsSync(fileURLToPath(new URL("./salience.ts", import.meta.url))) &&
  existsSync(fileURLToPath(new URL("./service.ts", import.meta.url)));

const NOW = new Date("2026-06-15T20:00:00.000Z"); // 13:00 PT — inside delivery hours

/** A tiny ratified-shaped policy fixture: attention on the approve list. */
const FIXTURE_YAML = `
version: 1
autonomy_ceiling:
  read: autonomous
  propose: autonomous
  write_canonical: gated
  external_side_effect: approval_required
  money_and_contracts: prohibited
notifications:
  autoApproveKinds: ["brief", "attention"]
  escalationMinUrgency: high
  defaultTtlMinutes: 240
`;

function itemStub(overrides: Partial<AttentionItemRow> = {}): AttentionItemRow {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    principalId: randomUUID(),
    sourceType: "outcome",
    sourceObjectId: randomUUID(),
    fingerprint: `outcome:${id}:ready`,
    kind: "outcome.ready",
    state: "open",
    level: "inbox",
    safetyClass: "none",
    title: "Chase the Acme quote — ready for your judgment",
    summary: "Keep track of the packaging quote.",
    whyItMatters: "Delegated work needs your decision to continue.",
    evidenceRefs: [],
    actions: [],
    occurrences: 1,
    changeFingerprint: null,
    firstRaisedAt: NOW,
    updatedAt: NOW,
    seenAt: null,
    snoozedUntil: null,
    snoozeCount: 0,
    resolvedAt: null,
    resolvedBy: null,
    resolutionReason: null,
    lastDeliveredAt: null,
    deliveryAttempts: 0,
    lastDeliveryAttemptAt: null,
    ...overrides,
  };
}

describe.skipIf(!TEST_DATABASE_URL)("attention notification enqueue (W1 kind widening)", () => {
  let db: IsolatedDb;
  let fixturePath: string;
  let fixtureConfig: NotificationsConfig;
  const prevTodayBase = process.env["TODAY_BASE_URL"];

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w1attnq");
    await migrateUp(db.pool); // …030: the attention notification vocabulary
    await seedDomains(db.pool);
    await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'enqueue-owner') ON CONFLICT DO NOTHING`,
    );
    const dir = await mkdtemp(path.join(tmpdir(), "attention-policy-"));
    fixturePath = path.join(dir, "policy.yaml");
    await writeFile(fixturePath, FIXTURE_YAML, "utf8");
    fixtureConfig = await loadNotificationsConfig(fixturePath);
  });

  afterAll(async () => {
    if (prevTodayBase === undefined) delete process.env["TODAY_BASE_URL"];
    else process.env["TODAY_BASE_URL"] = prevTodayBase;
    await rm(path.dirname(fixturePath), { recursive: true, force: true });
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("policy fixture puts attention on the auto-approve list", () => {
    expect(fixtureConfig.autoApproveKinds).toContain("attention");
  });

  it("lands an approved kind=attention row with the contract payload (no TODAY_BASE_URL)", async () => {
    delete process.env["TODAY_BASE_URL"];
    const item = itemStub();
    const notification = await enqueueAttentionNotification(
      { query: (sql, params) => db.pool.query(sql, params as unknown[]) },
      { item, now: NOW, config: fixtureConfig },
    );
    expect(notification.kind).toBe("attention");
    expect(notification.sourceType).toBe("attention");
    expect(notification.sourceId).toBe(item.id);
    expect(notification.title).toBe(item.title);
    expect(notification.status).toBe("approved"); // policy list includes attention
    expect(notification.payload["content"]).toBe(item.summary);
    expect(notification.payload["whyItMatters"]).toBe(item.whyItMatters);
    expect(notification.payload["todayUrl"]).toBeUndefined();
    // created_by is the resolved service/attention principal (provenance).
    const createdBy = await db.pool.query(`SELECT type, name FROM principals WHERE id = $1::uuid`, [
      notification.createdBy,
    ]);
    expect(createdBy.rows[0]).toMatchObject({ type: "service", name: "service/attention" });
  });

  it("adds payload.todayUrl only when TODAY_BASE_URL is deployed", async () => {
    process.env["TODAY_BASE_URL"] = "https://jehad.example.ts.net";
    const item = itemStub();
    const notification = await enqueueAttentionNotification(
      { query: (sql, params) => db.pool.query(sql, params as unknown[]) },
      { item, now: NOW, config: fixtureConfig },
    );
    expect(notification.payload["todayUrl"]).toBe(
      `https://jehad.example.ts.net/ui#item-${item.id}`,
    );
  });

  it("lands pending when attention is NOT on the config's approve list", async () => {
    const pendingConfig: NotificationsConfig = {
      ...fixtureConfig,
      autoApproveKinds: ["brief"],
    };
    const item = itemStub();
    const notification = await enqueueAttentionNotification(
      { query: (sql, params) => db.pool.query(sql, params as unknown[]) },
      { item, now: NOW, config: pendingConfig },
    );
    expect(notification.status).toBe("pending");
    const listed = await listNotifications({ query: (sql, params) => db.pool.query(sql, params as unknown[]) }, { kind: "attention" });
    expect(listed.length).toBeGreaterThanOrEqual(3);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("migration 030: attention kind/source_type CHECK round-trip", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w1attmig");
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function constraintDefs(): Promise<{ kind: string; sourceType: string }> {
    const result = await db.pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'notifications'::regclass AND conname LIKE 'notifications_%_check'`,
    );
    const kind = String(
      result.rows.find((r) => r.conname === "notifications_kind_check")?.def ?? "",
    );
    const sourceType = String(
      result.rows.find((r) => r.conname === "notifications_source_type_check")?.def ?? "",
    );
    return { kind, sourceType };
  }

  it("up widens both CHECKs with 'attention'; down restores the 019 vocabularies; re-up widens again", async () => {
    await migrateUp(db.pool);
    const widened = await constraintDefs();
    expect(widened.kind).toContain("'attention'");
    expect(widened.sourceType).toContain("'attention'");
    // The widened vocabulary admits an attention row end to end.
    const principal = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('service', 'service/attention') RETURNING id`,
    );
    const insert = await db.pool.query(
      `INSERT INTO notifications (kind, title, payload, status, source_type, source_id, created_by, expires_at, created_at, updated_at)
       VALUES ('attention', 't', '{}'::jsonb, 'pending', 'attention', NULL, $1::uuid, now() + interval '1 hour', now(), now())
       RETURNING id`,
      [String(principal.rows[0]!.id)],
    );
    expect(insert.rows).toHaveLength(1);

    const rolled = await migrateDown(db.pool, { to: "029_attention_items" });
    expect(rolled).toEqual(["030_attention_kind"]);
    const narrowed = await constraintDefs();
    expect(narrowed.kind).not.toContain("'attention'");
    expect(narrowed.kind).toContain("'grant-reminder'"); // 019 vocabulary restored
    expect(narrowed.sourceType).not.toContain("'attention'");
    expect(narrowed.sourceType).toContain("'calibration'");

    await migrateUp(db.pool);
    const reWidened = await constraintDefs();
    expect(reWidened.kind).toContain("'attention'");
    expect(reWidened.sourceType).toContain("'attention'");
  });
});

describe.skipIf(!TEST_DATABASE_URL || !KERNEL_PRESENT)(
  "attention delivery stamps + retryEligibleUndelivered (W1)",
  () => {
    let db: IsolatedDb;
    let principalId: string;
    let delivery: typeof import("./delivery.js");
    let fixturePath: string;
    let fixtureConfig: NotificationsConfig;

    beforeAll(async () => {
      db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w1attdel");
      await migrateUp(db.pool);
      await seedDomains(db.pool);
      const row = await db.pool.query(
        `INSERT INTO principals (type, name) VALUES ('user', 'delivery-owner') RETURNING id`,
      );
      principalId = String(row.rows[0]!.id);
      delivery = await import("./delivery.js");
      const dir = await mkdtemp(path.join(tmpdir(), "attention-delivery-"));
      fixturePath = path.join(dir, "policy.yaml");
      await writeFile(fixturePath, FIXTURE_YAML, "utf8");
      fixtureConfig = await loadNotificationsConfig(fixturePath);
    });

    afterAll(async () => {
      await rm(path.dirname(fixturePath), { recursive: true, force: true });
      await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
    });

    const exec = { query: (sql: string, params: readonly unknown[] = []) => db.pool.query(sql, params as unknown[]) };

    async function insertItem(overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO attention_items
           (id, principal_id, source_type, source_object_id, fingerprint, kind, state, level,
            safety_class, title, summary, why_it_matters, first_raised_at, updated_at,
            snoozed_until, last_delivered_at, delivery_attempts)
         VALUES ($1::uuid, $2::uuid, 'outcome', $3, $4, 'outcome.ready', $5, $6, 'none', $7, $8, NULL,
                 $9::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12)`,
        [
          id,
          principalId,
          overrides["source_object_id"] ?? randomUUID(),
          `outcome:${id}:ready`,
          overrides["state"] ?? "open",
          overrides["level"] ?? "inbox",
          overrides["title"] ?? "t",
          overrides["summary"] ?? "s",
          overrides["first_raised_at"] ?? NOW,
          overrides["snoozed_until"] ?? null,
          overrides["last_delivered_at"] ?? null,
          overrides["delivery_attempts"] ?? 0,
        ],
      );
      return id;
    }

    async function itemRow(id: string): Promise<Record<string, unknown>> {
      const result = await db.pool.query(`SELECT * FROM attention_items WHERE id = $1::uuid`, [id]);
      return result.rows[0] as Record<string, unknown>;
    }

    it("markDeliveryAttempted increments attempts and stamps the attempt time", async () => {
      const id = await insertItem();
      const then = new Date("2026-06-15T20:00:00.000Z");
      const later = new Date("2026-06-15T20:05:00.000Z");
      await delivery.markDeliveryAttempted(exec, id, then);
      await delivery.markDeliveryAttempted(exec, id, later);
      const row = await itemRow(id);
      expect(Number(row["delivery_attempts"])).toBe(2);
      expect((row["last_delivery_attempt_at"] as Date).toISOString()).toBe(later.toISOString());
      // Projection stamp only — item state and updated_at untouched.
      expect(row["state"]).toBe("open");
      expect((row["updated_at"] as Date).toISOString()).toBe(NOW.toISOString());
    });

    it("stampAttentionDelivered is success-only, monotonic, and idempotent", async () => {
      const id = await insertItem();
      const early = new Date("2026-06-15T20:00:00.000Z");
      const later = new Date("2026-06-15T20:10:00.000Z");
      expect(await delivery.stampAttentionDelivered(exec, id, later)).toBe(true);
      expect(((await itemRow(id))["last_delivered_at"] as Date).toISOString()).toBe(later.toISOString());
      // Idempotent: same stamp again is a no-op; a LATE earlier report never
      // moves the stamp backward.
      expect(await delivery.stampAttentionDelivered(exec, id, later)).toBe(false);
      expect(await delivery.stampAttentionDelivered(exec, id, early)).toBe(false);
      expect(((await itemRow(id))["last_delivered_at"] as Date).toISOString()).toBe(later.toISOString());
    });

    it("retryEligibleUndelivered enqueues only eligible items and skips snoozed/digest/in-flight", async () => {
      // Fresh slate: earlier tests in this describe leave open items behind.
      await db.pool.query("DELETE FROM notifications WHERE kind = 'attention'");
      await db.pool.query("DELETE FROM attention_items");
      const eligible = await insertItem({ title: "eligible-open" });
      const eligibleSeen = await insertItem({ state: "seen", title: "eligible-seen" });
      const snoozed = await insertItem({
        state: "snoozed",
        snoozed_until: new Date(NOW.getTime() + 3_600_000),
        title: "snoozed",
      });
      const digest = await insertItem({ level: "digest", title: "digest" });
      const inFlight = await insertItem({ title: "in-flight" });
      // The in-flight fake: a pending attention notification for that item.
      await db.pool.query(
        `INSERT INTO notifications (kind, title, payload, status, source_type, source_id, created_by, expires_at, created_at, updated_at)
         VALUES ('attention', 'pending push', '{}'::jsonb, 'pending', 'attention', $1::uuid, $2::uuid, $3::timestamptz, $3::timestamptz, $3::timestamptz)`,
        [inFlight, principalId, new Date(NOW.getTime() + 3_600_000).toISOString()],
      );

      const config = { cooldownMinutes: 60, notifications: fixtureConfig };
      const count = await delivery.retryEligibleUndelivered(exec, { now: NOW, config });
      expect(count).toBe(2); // eligible + eligibleSeen only

      for (const id of [eligible, eligibleSeen]) {
        const row = await itemRow(id);
        expect(Number(row["delivery_attempts"])).toBe(1);
        expect(row["last_delivery_attempt_at"]).not.toBeNull();
        const pushed = await db.pool.query(
          `SELECT status FROM notifications WHERE kind = 'attention' AND source_id = $1`,
          [id],
        );
        expect(pushed.rows).toHaveLength(1);
        expect(String(pushed.rows[0]!["status"])).toBe("approved");
      }
      for (const id of [snoozed, digest]) {
        const pushed = await db.pool.query(
          `SELECT 1 FROM notifications WHERE kind = 'attention' AND source_id = $1`,
          [id],
        );
        expect(pushed.rows).toHaveLength(0);
      }
      // inFlight keeps EXACTLY its pre-existing fixture row — no second push.
      const inFlightRows = await db.pool.query(
        `SELECT status FROM notifications WHERE kind = 'attention' AND source_id = $1`,
        [inFlight],
      );
      expect(inFlightRows.rows).toHaveLength(1);
      expect(String(inFlightRows.rows[0]!["status"])).toBe("pending");

      // Idempotent re-run: the two just-enqueued rows are now in-flight.
      expect(await delivery.retryEligibleUndelivered(exec, { now: NOW, config })).toBe(0);
    });

    it("retry defers inside quiet hours (22:00–07:00 PT) without dropping the item", async () => {
      await db.pool.query("DELETE FROM notifications WHERE kind = 'attention'");
      await db.pool.query("DELETE FROM attention_items");
      const late = await insertItem({ title: "quiet-hours-item" });
      // 2026-06-16T06:30:00Z == 23:30 PT (PDT, UTC-7) — inside quiet hours.
      const count = await delivery.retryEligibleUndelivered(exec, {
        now: new Date("2026-06-16T06:30:00.000Z"),
        config: { cooldownMinutes: 60, notifications: fixtureConfig },
      });
      expect(count).toBe(0);
      const pushed = await db.pool.query(
        `SELECT 1 FROM notifications WHERE kind = 'attention' AND source_id = $1`,
        [late],
      );
      expect(pushed.rows).toHaveLength(0);
      // The item is untouched — still open, never delivered, picks up on a
      // later in-window pass.
      const row = await itemRow(late);
      expect(row["state"]).toBe("open");
      expect(row["last_delivered_at"]).toBeNull();
    });
  },
);
