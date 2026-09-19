// Reply conjunction rule tests (gateway §4 — the ONE reply auto-approval
// rule). Needs PostgreSQL 16 for the transport-identity lookups and
// createNotification wiring; skipped unless TEST_DATABASE_URL is set.
// Multi-principal Lane P: the conjunction's identity legs ride PAIRED
// transport identities (fixtures pair the owner + a second principal up
// front) — EDGE_IMESSAGE_TARGET and the type='user' shortcut are gone.
// Covers: every conjunction leg failing routes to the approval queue, all
// legs passing approves at creation, the recipient fallback leg
// (payload.recipient), the env-target-never-consulted pin, the
// autoApproveKinds-never-contains-reply guard, and the audit trail.

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
} from "./service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const T0 = new Date("2026-09-18T12:00:00.000Z");
const OWNER_HANDLE = "+15550001111"; // paired in setup (transport identity)
const YUSRA_HANDLE = "+15550002222"; // second principal, also paired

/** A config that ILLEGALLY lists reply — the service must ignore it for replies. */
const REPLY_LISTED_CONFIG: NotificationsConfig = {
  ...DEFAULT_NOTIFICATIONS_CONFIG,
  autoApproveKinds: ["brief", "reply"],
};

describe.skipIf(!TEST_DATABASE_URL)("reply conjunction rule (integration, paired identities)", () => {
  let db: IsolatedDb;
  let ownerPrincipalId: string; // paired owner (Jehad fixtures)
  let yusraPrincipalId: string; // paired second principal
  let harnessPrincipalId: string; // never paired — identity leg must fail

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igbreply");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const owner = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
      [`owner-${randomUUID().slice(0, 8)}`],
    );
    ownerPrincipalId = String(owner.rows[0].id);
    const yusra = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
      [`yusra-${randomUUID().slice(0, 8)}`],
    );
    yusraPrincipalId = String(yusra.rows[0].id);
    const harness = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('harness', $1) RETURNING id",
      [`openclaw-${randomUUID().slice(0, 8)}`],
    );
    harnessPrincipalId = String(harness.rows[0].id);
    // Pair the fixtures: transport_identities rows via seeded sessions (the
    // single legal pairing path is attemptPairing; direct seeding is the
    // test's stand-in for the same end state).
    await db.pool.query(
      `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, expires_at)
       VALUES ($1::uuid, 'pair', $2, now() + interval '5 minutes'),
              ($3::uuid, 'pair', $2, now() + interval '5 minutes')`,
      [ownerPrincipalId, `a`.repeat(64), yusraPrincipalId],
    );
    const sessions = await db.pool.query(
      "SELECT id, principal_id FROM imessage_pairing_sessions",
    );
    for (const row of sessions.rows) {
      const handle = String(row.principal_id) === ownerPrincipalId ? OWNER_HANDLE : YUSRA_HANDLE;
      await db.pool.query(
        `INSERT INTO transport_identities (principal_id, transport, handle, verified_at, last_seen_at, paired_via_session)
         VALUES ($1::uuid, 'imessage', $2, $3::timestamptz, $3::timestamptz, $4::uuid)`,
        [row.principal_id, handle, T0.toISOString(), row.id],
      );
    }
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
      payload: { content: "pong", recipient: OWNER_HANDLE },
      recipient: OWNER_HANDLE,
      sourceType: "run",
      sourceId: randomUUID(),
      createdBy: harnessPrincipalId,
      surface: "imessage",
      requestingPrincipalId: ownerPrincipalId,
      conversationPrincipalId: ownerPrincipalId,
      thirdPartyRecipient: false,
      ...overrides,
    };
  }

  async function createReply(overrides: Partial<CreateNotificationInput> = {}) {
    return createNotification(db.pool, replyInput(overrides), {
      config: DEFAULT_NOTIFICATIONS_CONFIG,
      now: () => T0,
    });
  }

  /** The decision over exactly the stored row (post-create). */
  function decisionFor(notification: Awaited<ReturnType<typeof createReply>>) {
    return evaluateReplyApproval(db.pool, {
      kind: notification.kind,
      surface: notification.surface,
      requestingPrincipalId: notification.requestingPrincipalId,
      conversationPrincipalId: notification.conversationPrincipalId,
      thirdPartyRecipient: notification.thirdPartyRecipient,
      recipient: notification.recipient,
      payload: notification.payload,
    });
  }

  it("all legs pass → approved at creation (approved_by stays null: policy, not a principal)", async () => {
    const reply = await createReply();
    expect(reply.status).toBe("approved");
    expect(reply.approvedAt).toBe(T0.toISOString());
    expect(reply.approvedBy).toBeNull();
    expect(reply.surface).toBe("imessage");
    expect(reply.requestingPrincipalId).toBe(ownerPrincipalId);
    expect(reply.conversationPrincipalId).toBe(ownerPrincipalId);
    expect(reply.thirdPartyRecipient).toBe(false);
    expect(reply.recipient).toBe(OWNER_HANDLE);
  });

  it("second paired principal: recipient ∈ HER verified handles approves too (multi-principal)", async () => {
    const reply = await createReply({
      requestingPrincipalId: yusraPrincipalId,
      conversationPrincipalId: yusraPrincipalId,
      recipient: YUSRA_HANDLE,
      payload: { content: "pong", recipient: YUSRA_HANDLE },
    });
    expect(reply.status).toBe("approved");
  });

  it("cross-principal recipient (yusra's handle on the owner's reply) → queue", async () => {
    const reply = await createReply({
      recipient: YUSRA_HANDLE,
      payload: { content: "pong", recipient: YUSRA_HANDLE },
    });
    expect(reply.status).toBe("pending");
    expect((await decisionFor(reply)).failedLegs).toEqual(["recipient"]);
  });

  it("recipient fallback leg: row column absent, payload.recipient = the paired handle → approves", async () => {
    const reply = await createReply({ recipient: null });
    expect(reply.status).toBe("approved");
    expect((await decisionFor(reply)).approved).toBe(true);
  });

  it("EDGE_IMESSAGE_TARGET is NEVER consulted: a conflicting env value changes nothing", async () => {
    const previous = process.env.EDGE_IMESSAGE_TARGET;
    process.env.EDGE_IMESSAGE_TARGET = "+15559990000"; // not any fixture's handle
    try {
      const approved = await createReply();
      expect(approved.status).toBe("approved"); // paired handle, not the env
      const mismatched = await createReply({
        recipient: "+15559990000",
        payload: { content: "pong", recipient: "+15559990000" },
      });
      expect(mismatched.status).toBe("pending"); // env value is NOT verified
      expect((await decisionFor(mismatched)).failedLegs).toEqual(["recipient"]);
    } finally {
      if (previous === undefined) delete process.env.EDGE_IMESSAGE_TARGET;
      else process.env.EDGE_IMESSAGE_TARGET = previous;
    }
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

  it("leg: requesting principal missing → queue (recipient + conversation legs fail with it)", async () => {
    const reply = await createReply({ requestingPrincipalId: null });
    expect(reply.status).toBe("pending");
    expect((await decisionFor(reply)).failedLegs).toEqual([
      "requesting-principal",
      "recipient", // no principal → no verified handles → recipient fails closed
      "conversation-principal", // conversation ≠ a null requester by definition
    ]);
  });

  it("leg: requesting principal with NO verified identity (harness) → queue", async () => {
    const reply = await createReply({
      requestingPrincipalId: harnessPrincipalId,
      conversationPrincipalId: harnessPrincipalId,
      recipient: OWNER_HANDLE,
    });
    expect(reply.status).toBe("pending");
    const legs = (await decisionFor(reply)).failedLegs;
    expect(legs).toContain("requesting-principal"); // no transport identity
    expect(legs).toContain("recipient"); // OWNER_HANDLE is not the harness's
  });

  it("leg: recipient ≠ any verified transport identity → queue", async () => {
    const reply = await createReply({
      recipient: "+15559998888",
      payload: { content: "pong", recipient: "+15559998888" },
    });
    expect(reply.status).toBe("pending");
    expect((await decisionFor(reply)).failedLegs).toEqual(["recipient"]);
  });

  it("leg: recipient absent everywhere → queue (fail closed)", async () => {
    const reply = await createReply({ recipient: null, payload: { content: "pong" } });
    expect(reply.status).toBe("pending");
    expect((await decisionFor(reply)).failedLegs).toEqual(["recipient"]);
  });

  it("leg: conversation principal ≠ requesting principal → queue", async () => {
    const reply = await createReply({ conversationPrincipalId: yusraPrincipalId });
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

  // ADVERSARIAL (cross-principal identity claims): the full permutation
  // matrix of requesting/conversation principal × recipient across the two
  // paired principals plus an unpaired third-party target. Each principal
  // is paired to exactly her own handle, so the ONLY approved shapes are
  // the identity-consistent diagonals (conversation = requesting,
  // recipient = that principal's OWN handle, thirdParty = false). Every
  // combination that claims the other principal's identity or handle —
  // or points the reply at a third party — must land in the queue.
  it("adversarial: identity-claim permutation matrix — only the identity-consistent diagonal approves", async () => {
    const THIRD = "+15559998888";
    const ownHandleOf = (principalId: string) =>
      principalId === ownerPrincipalId ? OWNER_HANDLE : YUSRA_HANDLE;
    let approvedLegal = 0;
    let approvedIllegal = 0;
    for (const rq of [ownerPrincipalId, yusraPrincipalId]) {
      for (const cv of [ownerPrincipalId, yusraPrincipalId]) {
        for (const rc of [OWNER_HANDLE, YUSRA_HANDLE, THIRD]) {
          for (const tp of [false, true]) {
            const reply = await createReply({
              requestingPrincipalId: rq,
              conversationPrincipalId: cv,
              recipient: rc,
              payload: { content: "x", recipient: rc },
              thirdPartyRecipient: tp,
            });
            // Legality is principal-relative: the reply must be fully
            // consistent with the principal that requested it.
            const diagonal = cv === rq && rc === ownHandleOf(rq) && tp === false;
            if (reply.status === "approved") {
              if (diagonal) approvedLegal += 1;
              else approvedIllegal += 1;
            } else if (diagonal) {
              throw new Error(`legal diagonal was NOT approved: rq=${rq} cv=${cv} rc=${rc} tp=${tp}`);
            }
          }
        }
      }
    }
    // 24 distinct combinations; exactly the two diagonals approve.
    expect(approvedLegal).toBe(2);
    expect(approvedIllegal).toBe(0);
  });

  it("recipient on a non-reply kind is an input error (claim wire never carries one)", async () => {
    await expect(
      createNotification(db.pool, {
        kind: "brief",
        title: "Morning brief",
        payload: { content: "..." },
        recipient: OWNER_HANDLE,
        sourceType: "brief",
        sourceId: randomUUID(),
        createdBy: ownerPrincipalId,
      }, { config: DEFAULT_NOTIFICATIONS_CONFIG, now: () => T0 }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_INPUT_INVALID" });
  });

  it("non-reply kinds never trip the reply rule; brief still auto-approves from the list", async () => {
    const brief = await createNotification(db.pool, {
      kind: "brief",
      title: "Morning brief",
      payload: { content: "..." },
      sourceType: "brief",
      sourceId: randomUUID(),
      createdBy: ownerPrincipalId,
    }, { config: DEFAULT_NOTIFICATIONS_CONFIG, now: () => T0 });
    expect(brief.status).toBe("approved");
    const escalation = await createNotification(db.pool, {
      kind: "escalation",
      title: "Needs review",
      payload: { text: "..." },
      sourceType: "escalation",
      sourceId: randomUUID(),
      createdBy: ownerPrincipalId,
    }, { config: DEFAULT_NOTIFICATIONS_CONFIG, now: () => T0 });
    expect(escalation.status).toBe("pending");
  });

  it("GUARD: a config that lists reply in autoApproveKinds still cannot kind-approve replies", async () => {
    // Conjunction failing (surface wrong) + reply in the kind list → queue.
    const pending = await createReply({ surface: "cli" });
    expect(pending.status).toBe("pending");
    // Conjunction passing approves — via the RULE, not the list.
    const approved = await createNotification(db.pool, replyInput(), {
      config: REPLY_LISTED_CONFIG,
      now: () => T0,
    });
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
