// Reply conjunction rule tests (gateway §4 — the ONE reply auto-approval
// rule, day one). Needs PostgreSQL 16 for the owner-principal lookup and
// createNotification wiring; skipped unless TEST_DATABASE_URL is set.
// Covers: every conjunction leg failing routes to the approval queue, all
// legs passing approves at creation, the autoApproveKinds-never-contains-
// reply guard (config projection + createNotification ignoring the list),
// and the audit trail of the rule decision.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import {
  DEFAULT_NOTIFICATIONS_CONFIG,
  notificationsConfigFromPolicyV1,
  type NotificationsConfig,
} from "./config.js";
import {
  createNotification,
  evaluateReplyApproval,
  type CreateNotificationInput,
  type NotificationServiceOptions,
} from "./service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const T0 = new Date("2026-09-18T12:00:00.000Z");
const OWNER_TARGET = "+15550001111"; // A–C: the fixed EDGE_IMESSAGE_TARGET

/** A config that ILLEGALLY lists reply — the service must ignore it for replies. */
const REPLY_LISTED_CONFIG: NotificationsConfig = {
  ...DEFAULT_NOTIFICATIONS_CONFIG,
  autoApproveKinds: ["brief", "reply"],
};

describe.skipIf(!TEST_DATABASE_URL)("reply conjunction rule (integration)", () => {
  let db: IsolatedDb;
  let userPrincipalId: string; // owner (paired-owner stand-in for A–C)
  let harnessPrincipalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igbreply");
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

  afterEach(async () => {
    await db.pool.query("DELETE FROM notifications WHERE kind = 'reply'");
  });

  function replyInput(
    overrides: Partial<CreateNotificationInput> = {},
  ): CreateNotificationInput {
    return {
      kind: "reply",
      title: "Re: ping",
      payload: { content: "pong", recipient: OWNER_TARGET },
      sourceType: "run",
      sourceId: randomUUID(),
      createdBy: harnessPrincipalId,
      surface: "imessage",
      requestingPrincipalId: userPrincipalId,
      conversationPrincipalId: userPrincipalId,
      thirdPartyRecipient: false,
      ...overrides,
    };
  }

  async function createReply(
    overrides: Partial<CreateNotificationInput> = {},
    opts: Partial<NotificationServiceOptions> = {},
  ) {
    return createNotification(db.pool, replyInput(overrides), {
      config: DEFAULT_NOTIFICATIONS_CONFIG,
      now: () => T0,
      replyVerifiedRecipient: OWNER_TARGET,
      ...opts,
    });
  }

  /** The decision over exactly the stored row (post-create). */
  function decisionFor(
    notification: Awaited<ReturnType<typeof createReply>>,
    verifiedOwnerRecipient: string | null = OWNER_TARGET,
  ) {
    return evaluateReplyApproval(
      db.pool,
      {
        kind: notification.kind,
        surface: notification.surface,
        requestingPrincipalId: notification.requestingPrincipalId,
        conversationPrincipalId: notification.conversationPrincipalId,
        thirdPartyRecipient: notification.thirdPartyRecipient,
        payload: notification.payload,
      },
      { verifiedOwnerRecipient },
    );
  }

  it("all legs pass → approved at creation (approved_by stays null: policy, not a principal)", async () => {
    const reply = await createReply();
    expect(reply.status).toBe("approved");
    expect(reply.approvedAt).toBe(T0.toISOString());
    expect(reply.approvedBy).toBeNull();
    expect(reply.surface).toBe("imessage");
    expect(reply.requestingPrincipalId).toBe(userPrincipalId);
    expect(reply.conversationPrincipalId).toBe(userPrincipalId);
    expect(reply.thirdPartyRecipient).toBe(false);
  });

  it("leg: surface ≠ imessage → queue", async () => {
    const reply = await createReply({ surface: "cli" });
    expect(reply.status).toBe("pending");
    expect(reply.approvedAt).toBeNull();
    expect(await decisionFor(reply)).toEqual({
      approved: false,
      failedLegs: ["surface"],
    });
  });

  it("leg: requesting principal missing → queue (conversation leg fails with it)", async () => {
    const reply = await createReply({ requestingPrincipalId: null });
    expect(reply.status).toBe("pending");
    expect((await decisionFor(reply)).failedLegs).toEqual([
      "requesting-principal",
      "conversation-principal", // conversation ≠ a null requester by definition
    ]);
  });

  it("leg: requesting principal not the owner (harness) → queue", async () => {
    const reply = await createReply({ requestingPrincipalId: harnessPrincipalId });
    expect(reply.status).toBe("pending");
    const legs = (await decisionFor(reply)).failedLegs;
    expect(legs).toContain("requesting-principal");
    expect(legs).toContain("conversation-principal"); // harness ≠ the user conversation principal
  });

  it("leg: recipient ≠ the verified transport identity → queue", async () => {
    const reply = await createReply({ payload: { content: "pong", recipient: "+15559998888" } });
    expect(reply.status).toBe("pending");
    expect((await decisionFor(reply)).failedLegs).toEqual(["recipient"]);
  });

  it("leg: no verified recipient configured → queue (fail closed)", async () => {
    const reply = await createReply({}, { replyVerifiedRecipient: null });
    expect(reply.status).toBe("pending");
    expect((await decisionFor(reply, null)).failedLegs).toEqual(["recipient"]);
  });

  it("leg: conversation principal ≠ requesting principal → queue", async () => {
    const reply = await createReply({ conversationPrincipalId: harnessPrincipalId });
    expect(reply.status).toBe("pending");
    expect((await decisionFor(reply)).failedLegs).toEqual(["conversation-principal"]);
  });

  it("leg: conversation principal missing → queue", async () => {
    const reply = await createReply({ conversationPrincipalId: null });
    expect(reply.status).toBe("pending");
    expect((await decisionFor(reply)).failedLegs).toEqual(["conversation-principal"]);
  });

  it("leg: third-party recipient true → queue; unknown (null) fails closed too", async () => {
    const flagged = await createReply({ thirdPartyRecipient: true });
    expect(flagged.status).toBe("pending");
    expect((await decisionFor(flagged)).failedLegs).toEqual(["third-party-recipient"]);
    const unknown = await createReply({ thirdPartyRecipient: null });
    expect(unknown.status).toBe("pending");
    expect((await decisionFor(unknown)).failedLegs).toEqual(["third-party-recipient"]);
  });

  it("non-reply kinds never trip the reply rule; brief still auto-approves from the list", async () => {
    const brief = await createNotification(db.pool, {
      kind: "brief",
      title: "Morning brief",
      payload: { content: "..." },
      sourceType: "brief",
      sourceId: randomUUID(),
      createdBy: userPrincipalId,
    }, { config: DEFAULT_NOTIFICATIONS_CONFIG, now: () => T0 });
    expect(brief.status).toBe("approved");
    const escalation = await createNotification(db.pool, {
      kind: "escalation",
      title: "Needs review",
      payload: { text: "..." },
      sourceType: "escalation",
      sourceId: randomUUID(),
      createdBy: userPrincipalId,
    }, { config: DEFAULT_NOTIFICATIONS_CONFIG, now: () => T0 });
    expect(escalation.status).toBe("pending");
  });

  it("GUARD: a config that lists reply in autoApproveKinds still cannot kind-approve replies", async () => {
    // Conjunction failing (surface wrong) + reply in the kind list → queue.
    const pending = await createReply({ surface: "cli" }, { config: REPLY_LISTED_CONFIG });
    expect(pending.status).toBe("pending");
    // Conjunction passing approves — via the RULE, not the list.
    const approved = await createReply({}, { config: REPLY_LISTED_CONFIG });
    expect(approved.status).toBe("approved");
  });

  it("GUARD: the policy projection drop-filters reply from autoApproveKinds", () => {
    const config = notificationsConfigFromPolicyV1({
      notifications: { autoApproveKinds: ["brief", "reply"] },
    });
    expect(config.autoApproveKinds).toEqual(["brief"]);
    // And the shipped defaults never contain it.
    expect(DEFAULT_NOTIFICATIONS_CONFIG.autoApproveKinds).not.toContain("reply");
  });

  it("the audit row records the rule decision and failing legs", async () => {
    const pending = await createReply({ surface: "cli" }); // pending
    const approved = await createReply(); // approved
    const audits = await db.pool.query(
      `SELECT outputs_ref::jsonb AS o FROM audit_log
       WHERE action = 'notification.created'
         AND outputs_ref::jsonb->>'notificationId' = ANY($1::text[])
       ORDER BY created_at`,
      [[pending.id, approved.id]],
    );
    expect(audits.rows.length).toBe(2);
    expect(audits.rows[0].o).toMatchObject({
      replyRule: false,
      replyFailedLegs: ["surface"],
    });
    expect(audits.rows[1].o).toMatchObject({ replyRule: true, replyFailedLegs: [] });
  });
});
