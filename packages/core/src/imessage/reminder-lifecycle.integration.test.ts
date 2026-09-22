// W6-phase-2 acceptance: the reminder lifecycle end-to-end at the
// conversation boundary — capture arms the promise ("I'll text you …"),
// probe replies resolve deterministically (done / renegotiate / defer /
// stop), stale probes fall through, and nothing hijacks ambient chat.
// Fixed clock: T0 = 2026-09-21T20:56:00Z = Monday 13:56 PT.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { FakeModelProvider } from "@jehad/adapters";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import { issueGrant } from "../policy/grants.js";
import {
  dueWordFor,
  deferredAck,
  doneAck,
  movedAck,
  parkedAck,
  quietShiftedAck,
} from "../reminders/lifecycle.js";
import { setThreadPendingProposal, setThreadPendingProbe } from "./threads.js";
import { CONVERSE_CAPABILITY, handleInbound, type ConversationDeps } from "./conversation.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const T0 = new Date("2026-09-21T20:56:00Z");

const REGISTRY = new ModelEgressPolicyRegistry([
  {
    id: "test-personal-normal",
    domainId: "personal",
    sensitivity: "normal",
    allowedProviders: ["fake"],
    allowRemote: false,
    requireRedaction: false,
  },
]);

describe.skipIf(!TEST_DATABASE_URL)("W6-phase-2 reminder lifecycle (integration)", () => {
  let db: IsolatedDb;
  let domainId: string;
  let handle: string;
  let principalId: string;

  const deps = (): ConversationDeps => ({
    db: db.pool,
    provider: new FakeModelProvider({ respond: { text: "model handled it" } }),
    registry: REGISTRY,
    principalPolicy: () => ({
      model: "fake/model-x",
      requestsPerHour: 30,
      costPerDay: 5,
      reads: ["commitments", "calendar"],
    }),
    now: () => T0,
  });

  const setup = async (name: string, seq: number) => {
    const h = `+1555000${String(7000 + seq)}`;
    const principal = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
      [name],
    );
    const id = String(principal.rows[0].id);
    const session = await db.pool.query(
      `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, expires_at)
       VALUES ($1::uuid, 'pair', $2, now() + interval '5 minutes') RETURNING id`,
      [id, "c".repeat(64)],
    );
    await db.pool.query(
      `INSERT INTO transport_identities (principal_id, transport, handle, verified_at, last_seen_at, paired_via_session)
       VALUES ($1::uuid, 'imessage', $2, $3::timestamptz, $3::timestamptz, $4::uuid)`,
      [id, h, T0.toISOString(), session.rows[0].id],
    );
    await issueGrant(db.pool, {
      principalId: id,
      runId: null,
      capability: CONVERSE_CAPABILITY,
      resource: "imessage",
      domainId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    return { id, h };
  };

  /** Give the principal an active thread with a pending probe. */
  const seedPendingProbe = async (
    reminderId: string,
    kind: "probe" | "nudge" = "probe",
  ): Promise<string> => {
    await handleInbound(deps(), {
      principalId,
      handle,
      text: "what's on my plate",
    });
    const thread = await db.pool.query(
      "SELECT id FROM interaction_threads WHERE principal_id = $1::uuid ORDER BY created_at DESC LIMIT 1",
      [principalId],
    );
    const threadId = String(thread.rows[0].id);
    await db.pool.query(
      `UPDATE interaction_threads SET metadata = $2::jsonb WHERE id = $1::uuid`,
      [
        threadId,
        JSON.stringify({ pendingProbe: { reminderId, kind, sentAt: T0.toISOString() } }),
      ],
    );
    return threadId;
  };

  const armReminder = async (title: string, commitmentId: string | null = null) => {
    const row = await db.pool.query(
      `INSERT INTO reminders
         (principal, title, commitment_id, due_date, due_time, status, next_touch_at, next_touch_kind)
       VALUES ($1, $2, $3::uuid, '2026-09-21', NULL, 'armed', $4::timestamptz, 'probe')
       RETURNING id`,
      ['josctl', title, commitmentId, new Date(T0.getTime() + 30 * 60_000).toISOString()],
    );
    return String(row.rows[0].id);
  };

  const replyOf = async (outcome: { notificationId?: string }): Promise<string | undefined> => {
    if (outcome.notificationId === undefined) return undefined;
    const row = await db.pool.query(
      "SELECT payload->>'content' AS c FROM notifications WHERE id = $1::uuid",
      [outcome.notificationId],
    );
    return row.rows[0]?.c;
  };

  const reminderRow = async (id: string) => {
    const row = await db.pool.query(
      `SELECT title, status, due_date::text AS due_date, next_touch_at, next_touch_kind,
              escalations, renegotiations, commitment_id::text AS commitment_id,
              resolved_via, cancelled_via
         FROM reminders WHERE id = $1::uuid`,
      [id],
    );
    return row.rows[0];
  };

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w6rl");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    domainId = String(domain.rows[0].id);
    const s = await setup("josctl", 1);
    principalId = s.id;
    handle = s.h;
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("capture arms the lifecycle: commitment + reminder + named promise (tomorrow 9:00 AM PT)", async () => {
    const outcome = await handleInbound(deps(), {
      principalId,
      handle,
      text: "remind me to call sheikh jamaal tomorrow",
    });
    expect(outcome.replied).toBe(true);
    expect(await replyOf(outcome)).toBe("Tracked: call sheikh jamaal — due Tuesday. I'll text you Tuesday morning.");
    const row = await db.pool.query(
      `SELECT status, due_date::text AS due_date, next_touch_at, next_touch_kind, commitment_id::text AS cid
         FROM reminders WHERE principal = 'josctl' ORDER BY created_at DESC LIMIT 1`,
    );
    const r = row.rows[0];
    expect(r.status).toBe("armed");
    expect(r.due_date).toBe("2026-09-22");
    expect(r.next_touch_kind).toBe("morning");
    expect(new Date(r.next_touch_at).toISOString()).toBe("2026-09-22T16:00:00.000Z");
    const commitment = await db.pool.query(
      "SELECT status FROM commitments WHERE id = $1::uuid",
      [r.cid],
    );
    expect(commitment.rows[0].status).toBe("open");
  });

  it("bare 'remind me to X' (no when-words) defaults to tomorrow morning", async () => {
    const outcome = await handleInbound(deps(), {
      principalId,
      handle,
      text: "remind me to water the plants",
    });
    expect(await replyOf(outcome)).toBe("Tracked: water the plants. I'll text you Tuesday morning.");
    const row = await db.pool.query(
      `SELECT due_date::text AS due_date, next_touch_at FROM reminders
         WHERE principal = 'josctl' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(row.rows[0].due_date).toBe("2026-09-22");
    expect(new Date(row.rows[0].next_touch_at).toISOString()).toBe("2026-09-22T16:00:00.000Z");
  });

  it("probe reply 'yep' closes the loop: commitment met (user_reply), probe cleared", async () => {
    const evt = await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, recorded_at, idempotency_key,
                           domain_id, payload, sensitivity, schema_version)
       VALUES (gen_random_uuid(), 'capture.recorded', 'test', $1::timestamptz, $1::timestamptz, $2,
               $3::uuid, '{}'::jsonb, 'normal', 1) RETURNING id`,
      [T0.toISOString(), `w6rl-evt-${Math.random()}`, domainId],
    );
    const commitment = await db.pool.query(
      `INSERT INTO commitments (domain_id, direction, counterparty_text, description,
                                confidence, status, source_event_id)
         VALUES ($1::uuid, 'i_owe', 'self', 'call sheikh jamaal', 0.9, 'open', $2::uuid)
         RETURNING id`,
      [domainId, evt.rows[0].id],
    );
    const cid = String(commitment.rows[0].id);
    const rid = await armReminder("call sheikh jamaal", cid);
    await seedPendingProbe(rid);
    const outcome = await handleInbound(deps(), { principalId, handle, text: "yep" });
    expect(await replyOf(outcome)).toBe(doneAck("call sheikh jamaal"));
    const r = await reminderRow(rid);
    expect(r.status).toBe("completed");
    expect(r.resolved_via).toBe("user_reply");
    const c = await db.pool.query("SELECT status FROM commitments WHERE id = $1::uuid", [cid]);
    expect(c.rows[0].status).toBe("met");
    const meta = await db.pool.query("SELECT metadata FROM interaction_threads WHERE principal_id = $1::uuid ORDER BY created_at DESC LIMIT 1", [principalId]);
    expect(meta.rows[0].metadata).not.toBeNull();
    expect(meta.rows[0].metadata?.pendingProbe).toBeUndefined();
  });

  it("probe reply with a date ABIDES: due moves, escalations forgive, ack names the day", async () => {
    const rid = await armReminder("pick up dry cleaning");
    await seedPendingProbe(rid);
    const outcome = await handleInbound(deps(), {
      principalId,
      handle,
      text: "gonna do it tomorrow",
    });
    expect(await replyOf(outcome)).toBe(`Moved to ${dueWordFor("2026-09-22", T0)} — I'll check back then.`);
    const r = await reminderRow(rid);
    expect(r.status).toBe("armed");
    expect(r.due_date).toBe("2026-09-22");
    expect(r.renegotiations).toBe(1);
    expect(r.escalations).toBe(0);
    expect(r.next_touch_kind).toBe("morning");
  });

  it("renegotiation into quiet hours shifts the touch to 9:00 AM and says so", async () => {
    const rid = await armReminder("drop off the package");
    await seedPendingProbe(rid);
    const outcome = await handleInbound(deps(), {
      principalId,
      handle,
      text: "gonna do it tomorrow at 11pm",
    });
    expect(await replyOf(outcome)).toBe(
      `${movedAck(dueWordFor("2026-09-22", T0))} ${quietShiftedAck()}`,
    );
    const r = await reminderRow(rid);
    expect(r.next_touch_kind).toBe("morning");
    expect(new Date(r.next_touch_at).toISOString()).toBe("2026-09-23T16:00:00.000Z");
  });

  it("probe reply 'not yet' defers: ack, probe cleared, reminder stays armed", async () => {
    const rid = await armReminder("back up the laptop");
    await seedPendingProbe(rid);
    const outcome = await handleInbound(deps(), { principalId, handle, text: "not yet" });
    expect(await replyOf(outcome)).toBe(deferredAck());
    const r = await reminderRow(rid);
    expect(r.status).toBe("armed");
    const meta = await db.pool.query(
      "SELECT metadata FROM interaction_threads WHERE principal_id = $1::uuid ORDER BY created_at DESC LIMIT 1",
      [principalId],
    );
    expect(meta.rows[0].metadata?.pendingProbe).toBeUndefined();
  });

  it("'stop' cancels instantly with the parked ack", async () => {
    const rid = await armReminder("renew the parking permit");
    await seedPendingProbe(rid);
    const outcome = await handleInbound(deps(), { principalId, handle, text: "stop" });
    expect(await replyOf(outcome)).toBe(parkedAck("renew the parking permit"));
    const r = await reminderRow(rid);
    expect(r.status).toBe("cancelled");
    expect(r.cancelled_via).toBe("user");
  });

  it("a probe-directed phrase with NO live probe falls through to the model (stale probe cleared)", async () => {
    await seedPendingProbe("00000000-0000-4000-8000-000000000000");
    const outcome = await handleInbound(deps(), { principalId, handle, text: "yep" });
    expect(await replyOf(outcome)).toBe("model handled it");
    const meta = await db.pool.query(
      "SELECT metadata FROM interaction_threads WHERE principal_id = $1::uuid ORDER BY created_at DESC LIMIT 1",
      [principalId],
    );
    expect(meta.rows[0].metadata?.pendingProbe).toBeUndefined();
  });

  it("probe-directed phrases without a pending probe never hijack the turn", async () => {
    const outcome = await handleInbound(deps(), { principalId, handle, text: "yep" });
    expect(await replyOf(outcome)).toBe("model handled it");
  });

  it("pendingProbe metadata: strict parse roundtrip + proposal sibling survives probe writes", async () => {
    await handleInbound(deps(), { principalId, handle, text: "what's on my plate" });
    const thread = await db.pool.query(
      "SELECT id FROM interaction_threads WHERE principal_id = $1::uuid ORDER BY created_at DESC LIMIT 1",
      [principalId],
    );
    const threadId = String(thread.rows[0].id);
    const proposal = {
      type: "task_batch",
      at: T0.toISOString(),
      payload: { type: "task_batch", items: [{ title: "x" }] },
      offered: "offer text",
    };
    await setThreadPendingProposal(db.pool, {
      threadId,
      principalId,
      pending: proposal,
    });
    await setThreadPendingProbe(db.pool, {
      threadId,
      principalId,
      pending: { reminderId: "11111111-1111-4111-8111-111111111111", kind: "probe", sentAt: T0.toISOString() },
    });
    const bad = await db.pool.query("SELECT metadata FROM interaction_threads WHERE id = $1::uuid", [threadId]);
    const meta = bad.rows[0].metadata;
    expect(meta.pendingProbe?.reminderId).toBe("11111111-1111-4111-8111-111111111111");
    expect(meta.pendingProposal?.offered).toBe("offer text");
    await expect(
      setThreadPendingProbe(db.pool, {
        threadId,
        principalId,
        pending: { reminderId: "", kind: "probe", sentAt: T0.toISOString() },
      }),
    ).rejects.toThrow(/strict shape/);
    await setThreadPendingProbe(db.pool, { threadId, principalId, pending: null });
    const cleared = await db.pool.query("SELECT metadata FROM interaction_threads WHERE id = $1::uuid", [threadId]);
    expect(cleared.rows[0].metadata.pendingProbe).toBeUndefined();
    expect(cleared.rows[0].metadata.pendingProposal?.offered).toBe("offer text");
  });

  it("'remind me' capture stays gated on the capture principals (strangers get the model path)", async () => {
    const other = await setup("yusra", 2);
    const outcome = await handleInbound(deps(), {
      principalId: other.id,
      handle: other.h,
      text: "remind me to call sheikh jamaal tomorrow",
    });
    expect(await replyOf(outcome)).not.toContain("Tracked:");
  });
});
