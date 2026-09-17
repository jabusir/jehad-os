// Notification queue service integration tests (E4). Needs PostgreSQL 16 —
// skipped unless TEST_DATABASE_URL is set (per-file isolated db). Covers the
// lifecycle: policy-driven creation status (auto-approve briefs, pending
// everything else), user approve/reject, FIFO claim lease with expiry sweep,
// delivered recording (window-enforced), listing filters, both producer
// hooks (brief enqueue; escalation threshold), and an audit row for EVERY
// transition.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { raiseEscalation } from "../escalations/service.js";
import {
  DEFAULT_NOTIFICATIONS_CONFIG,
  type NotificationsConfig,
} from "./config.js";
import {
  InvalidNotificationStatusError,
  NotificationExpiredError,
  NotificationInputError,
  NotificationNotFoundError,
  approveNotification,
  claimNextApprovedNotification,
  createNotification,
  enqueueBriefNotification,
  expireNotification,
  listNotifications,
  markDelivered,
  rejectNotification,
  type NotificationRow,
} from "./service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CONFIG: NotificationsConfig = {
  autoApproveKinds: ["brief"],
  escalationMinUrgency: "high",
  defaultTtlMinutes: 240,
};

const T0 = new Date("2026-09-17T12:00:00.000Z");
const now = (): Date => T0;

describe.skipIf(!TEST_DATABASE_URL)("notification service (integration)", () => {
  let db: IsolatedDb;
  let userPrincipalId: string;
  let harnessPrincipalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "e4notif");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
      [`owner-${randomUUID().slice(0, 8)}`],
    );
    userPrincipalId = String(user.rows[0].id);
    const harness = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('harness', $1) RETURNING id",
      [`openclaw-${randomUUID().slice(0, 8)}`],
    );
    harnessPrincipalId = String(harness.rows[0].id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  function create(
    overrides: Partial<Parameters<typeof createNotification>[1]> = {},
    opts: Partial<Parameters<typeof createNotification>[2]> = {},
  ): Promise<NotificationRow> {
    return createNotification(
      db.pool,
      {
        kind: "escalation",
        title: "Test notification",
        payload: { text: "hello" },
        sourceType: "run",
        createdBy: userPrincipalId,
        ...overrides,
      },
      { config: CONFIG, now, ...opts },
    );
  }

  async function auditActions(): Promise<string[]> {
    const rows = await db.pool.query(
      "SELECT action FROM audit_log WHERE action LIKE 'notification.%' ORDER BY created_at, id",
    );
    return rows.rows.map((row) => String(row.action));
  }

  /** Claims until the queue is empty — makes null-claim assertions isolated. */
  async function drainQueue(): Promise<void> {
    while (
      (await claimNextApprovedNotification(db.pool, { claimedBy: harnessPrincipalId, now })) !==
      null
    ) {
      // keep draining
    }
  }

  it("briefs auto-approve per policy; escalations/custom land pending", async () => {
    const brief = await create({ kind: "brief", sourceType: "brief", title: "Morning brief" });
    expect(brief.status).toBe("approved");
    expect(brief.approvedAt).toBe(T0.toISOString());
    expect(brief.approvedBy).toBeNull(); // the approval is policy, not a principal

    const escalation = await create({ kind: "escalation", sourceType: "escalation" });
    expect(escalation.status).toBe("pending");
    expect(escalation.approvedAt).toBeNull();

    const custom = await create({ kind: "custom", sourceType: "run" });
    expect(custom.status).toBe("pending");

    const audits = await auditActions();
    expect(audits.filter((a) => a === "notification.created")).toHaveLength(3);
    const flags = await db.pool.query(
      `SELECT outputs_ref::jsonb->>'notificationId' AS id, outputs_ref::jsonb->>'autoApproved' AS auto
       FROM audit_log WHERE action = 'notification.created'`,
    );
    const autoByKind = new Map(
      flags.rows.map((r) => [String(r.id), String(r.auto)] as const),
    );
    expect(autoByKind.get(brief.id)).toBe("true");
    expect(autoByKind.get(escalation.id)).toBe("false");
    expect(autoByKind.get(custom.id)).toBe("false");
  });

  it("stamps expires_at from the configured TTL and rejects malformed input", async () => {
    const notification = await create({ kind: "custom", sourceType: "run" });
    expect(new Date(notification.expiresAt).getTime()).toBe(
      T0.getTime() + CONFIG.defaultTtlMinutes * 60_000,
    );
    await expect(create({ kind: "bogus" as never })).rejects.toBeInstanceOf(NotificationInputError);
    await expect(create({ title: "" })).rejects.toBeInstanceOf(NotificationInputError);
    await expect(create({ payload: ["array"] as never })).rejects.toBeInstanceOf(
      NotificationInputError,
    );
    await expect(create({ createdBy: "not-a-uuid" })).rejects.toBeInstanceOf(
      NotificationInputError,
    );
  });

  it("user approve: pending → approved (audited); repeat → 409 error; unknown → 404", async () => {
    const pending = await create({ kind: "custom", sourceType: "run" });
    const approved = await approveNotification(db.pool, pending.id, {
      approvedBy: userPrincipalId,
      actor: "user:owner",
      now,
    });
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe(userPrincipalId);
    await expect(
      approveNotification(db.pool, pending.id, { approvedBy: userPrincipalId, actor: "user:owner", now }),
    ).rejects.toBeInstanceOf(InvalidNotificationStatusError);
    await expect(
      approveNotification(db.pool, randomUUID(), { approvedBy: userPrincipalId, now }),
    ).rejects.toBeInstanceOf(NotificationNotFoundError);
    expect(await auditActions()).toContain("notification.approved");
  });

  it("user reject: pending → rejected (audited); a rejected row is never claimable", async () => {
    await drainQueue();
    const pending = await create({ kind: "custom", sourceType: "run" });
    const rejected = await rejectNotification(db.pool, pending.id, { actor: "user:owner", now });
    expect(rejected.status).toBe("rejected");
    expect(
      await claimNextApprovedNotification(db.pool, { claimedBy: harnessPrincipalId, now }),
    ).toBeNull();
    expect(await auditActions()).toContain("notification.rejected");
  });

  it("claim is FIFO over approved+unclaimed rows and stamps a lease, not a transition", async () => {
    await drainQueue();
    const first = await create(
      { kind: "brief", sourceType: "brief", title: "first" },
      { now: () => new Date(T0.getTime() + 1_000) },
    );
    const second = await create(
      { kind: "brief", sourceType: "brief", title: "second" },
      { now: () => new Date(T0.getTime() + 2_000) },
    );
    const claimed = await claimNextApprovedNotification(db.pool, {
      claimedBy: harnessPrincipalId,
      actor: "harness:openclaw",
      now,
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(first.id);
    expect(claimed!.title).toBe("first");
    expect(claimed!.payload).toEqual({ text: "hello" });

    const row = (
      await db.pool.query("SELECT status, claimed_by FROM notifications WHERE id = $1::uuid", [first.id])
    ).rows[0];
    expect(row.status).toBe("approved"); // lease, not transition
    expect(String(row.claimed_by)).toBe(harnessPrincipalId);

    // The claim lease excludes the row from later claims.
    const next = await claimNextApprovedNotification(db.pool, {
      claimedBy: harnessPrincipalId,
      now,
    });
    expect(next!.id).toBe(second.id);
    expect(await auditActions()).toContain("notification.claimed");
  });

  it("pending rows are never claimable — delivery sits behind review", async () => {
    await drainQueue();
    await create({ kind: "custom", sourceType: "run" }); // pending
    expect(
      await claimNextApprovedNotification(db.pool, { claimedBy: harnessPrincipalId, now }),
    ).toBeNull();
  });

  it("expired rows are swept (audited), never claimable, never deliverable", async () => {
    await drainQueue();
    const stale = await create(
      { kind: "brief", sourceType: "brief" },
      { config: { ...CONFIG, defaultTtlMinutes: -1 }, now: () => new Date(T0.getTime() - 60_000) },
    );
    // created "an hour ago" with a TTL in the past → already past expires_at.
    expect(
      await claimNextApprovedNotification(db.pool, { claimedBy: harnessPrincipalId, now }),
    ).toBeNull();
    const row = (
      await db.pool.query("SELECT status FROM notifications WHERE id = $1::uuid", [stale.id])
    ).rows[0];
    expect(row.status).toBe("expired");

    // An approved row past its window cannot be delivered — it expires instead.
    const late = await create(
      { kind: "brief", sourceType: "brief", title: "late" },
      { config: { ...CONFIG, defaultTtlMinutes: 60 }, now: () => new Date(T0.getTime() - 2 * 60 * 60_000) },
    );
    await expect(
      markDelivered(db.pool, late.id, {
        deliveredBy: harnessPrincipalId,
        now, // now is past the window created two hours ago with a 60m TTL
      }),
    ).rejects.toBeInstanceOf(NotificationExpiredError);
    const expiredRow = (
      await db.pool.query("SELECT status FROM notifications WHERE id = $1::uuid", [late.id])
    ).rows[0];
    expect(expiredRow.status).toBe("expired");
    expect(await auditActions()).toContain("notification.expired");
  });

  it("markDelivered records the harness principal; wrong-state → status error; unknown → 404", async () => {
    const approved = await create({ kind: "brief", sourceType: "brief" });
    const delivered = await markDelivered(db.pool, approved.id, {
      deliveredBy: harnessPrincipalId,
      actor: "harness:openclaw",
      now,
    });
    expect(delivered.status).toBe("delivered");
    expect(delivered.deliveredBy).toBe(harnessPrincipalId);
    expect(delivered.deliveredAt).toBe(T0.toISOString());

    await expect(
      markDelivered(db.pool, approved.id, { deliveredBy: harnessPrincipalId, now }),
    ).rejects.toBeInstanceOf(InvalidNotificationStatusError);
    await expect(
      markDelivered(db.pool, randomUUID(), { deliveredBy: harnessPrincipalId, now }),
    ).rejects.toBeInstanceOf(NotificationNotFoundError);
    expect(await auditActions()).toContain("notification.delivered");
  });

  it("explicit expireNotification and listing filters", async () => {
    const pending = await create({ kind: "custom", sourceType: "run", title: "to expire" });
    const expired = await expireNotification(db.pool, pending.id, { actor: "user:owner", now });
    expect(expired.status).toBe("expired");
    await expect(
      expireNotification(db.pool, pending.id, { now }),
    ).rejects.toBeInstanceOf(InvalidNotificationStatusError);

    const brief = await create({ kind: "brief", sourceType: "brief", title: "listed brief" });
    const byStatus = await listNotifications(db.pool, { status: "approved" });
    expect(byStatus.map((n) => n.id)).toContain(brief.id);
    expect(byStatus.every((n) => n.status === "approved")).toBe(true);
    const byKind = await listNotifications(db.pool, { kind: "brief" });
    expect(byKind.every((n) => n.kind === "brief")).toBe(true);
    await expect(listNotifications(db.pool, { limit: 0 })).rejects.toBeInstanceOf(
      NotificationInputError,
    );
  });

  it("producer hook: enqueueBriefNotification auto-approves under the service principal", async () => {
    const notification = await enqueueBriefNotification(db.pool, {
      title: "Morning brief",
      content: "MORNING BRIEF — 2026-09-17",
      artifactId: randomUUID(),
      now,
    });
    expect(notification.kind).toBe("brief");
    expect(notification.status).toBe("approved");
    expect(notification.payload).toEqual({
      artifactId: notification.sourceId,
      content: "MORNING BRIEF — 2026-09-17",
    });
    const creator = (
      await db.pool.query(
        "SELECT p.type, p.name FROM principals p WHERE p.id = $1::uuid",
        [notification.createdBy],
      )
    ).rows[0];
    expect(creator).toMatchObject({ type: "service", name: "service/briefs" });
  });

  it("producer hook: raiseEscalation enqueues a pending escalation notification at/above the threshold only", async () => {
    const makeRun = async (): Promise<{ runId: string; principalId: string }> => {
      const principal = await db.pool.query(
        "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
        [`owner-${randomUUID().slice(0, 8)}`],
      );
      const run = await db.pool.query(
        `INSERT INTO runs (kind, principal_id, status, domain_id)
         SELECT 'workflow', $1, 'blocked', d.id FROM domains d WHERE d.key = 'personal'
         RETURNING id`,
        [principal.rows[0].id],
      );
      return { runId: String(run.rows[0].id), principalId: String(principal.rows[0].id) };
    };

    const highRun = await makeRun();
    await raiseEscalation(db.pool, {
      runId: highRun.runId,
      reason: "approval_required",
      urgency: "high",
      consequenceOfWaiting: "deploy stays blocked",
      estHumanMinutes: 15,
    }, { now, notifications: CONFIG });

    const row = (
      await db.pool.query(
        "SELECT * FROM notifications WHERE source_type = 'escalation' AND source_id IN (SELECT id::text FROM escalations WHERE run_id = $1::uuid)",
        [highRun.runId],
      )
    ).rows[0];
    expect(row).toBeDefined();
    expect(row.status).toBe("pending"); // escalation delivery always behind review
    expect(row.created_by).toBe(highRun.principalId); // run's principal = provenance
    expect(row.payload).toMatchObject({ runId: highRun.runId, urgency: "high" });

    const lowRun = await makeRun();
    await raiseEscalation(db.pool, {
      runId: lowRun.runId,
      reason: "approval_required",
      urgency: "low",
    }, { now, notifications: CONFIG });
    const lowCount = await db.pool.query(
      "SELECT count(*)::int AS n FROM notifications WHERE source_type = 'escalation' AND source_id IN (SELECT id::text FROM escalations WHERE run_id = $1::uuid)",
      [lowRun.runId],
    );
    expect(lowCount.rows[0].n).toBe(0); // below threshold → no notification

    const disabled = await makeRun();
    await raiseEscalation(db.pool, {
      runId: disabled.runId,
      reason: "system_failure",
      urgency: "blocker",
    }, { now, notifications: false });
    const disabledCount = await db.pool.query(
      "SELECT count(*)::int AS n FROM notifications WHERE source_type = 'escalation' AND source_id IN (SELECT id::text FROM escalations WHERE run_id = $1::uuid)",
      [disabled.runId],
    );
    expect(disabledCount.rows[0].n).toBe(0); // hook can be switched off entirely
  });

  it("defaults match the shipped policy.yaml (repo-root section)", async () => {
    // The repo-root policy.yaml is the artifact under test for defaults.
    const { loadNotificationsConfig } = await import("./config.js");
    const config = await loadNotificationsConfig();
    expect(config).toEqual(DEFAULT_NOTIFICATIONS_CONFIG);
    expect(config.autoApproveKinds).toEqual(["brief"]);
  });
});
