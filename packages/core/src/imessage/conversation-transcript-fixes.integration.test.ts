// Transcript autopsy 00:01–00:14 (the lost 9-item capture + the silent
// death): affirmatives confirm pending proposals dispatched by TYPE, a
// residue default-due rule rides the confirm, the model can't invent
// machinery, pending state is stated truthfully, and budget denial speaks.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { FakeModelProvider } from "@jehad/adapters";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import { issueGrant } from "../policy/grants.js";
import { augmentReadSetForAsk } from "./conversation.js";
import {
  CONVERSE_CAPABILITY,
  handleInbound,
  type ConversationDeps,
} from "./conversation.js";
import { setThreadPendingProposal, type ThreadPendingProposal } from "./threads.js";

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

const NINE_ITEM_BATCH: ThreadPendingProposal = {
  type: "task_batch",
  at: T0.toISOString(),
  offered: "I pulled out 9 tasks… Reply 'track them' and I'll track them.",
  payload: {
    type: "task_batch",
    items: [
      { title: "Wedding seating chart", due: null },
      { title: "wedding playlist", due: null },
      { title: "wedding appetizers", due: null },
      { title: "get prenup signed", due: "wednesday" },
      { title: "finish companions lecture", due: "wednesday" },
      { title: "build console table", due: null },
      { title: "build bed", due: null },
      { title: "Clean apartment and bathrooms", due: null },
      { title: "call sheikh jamal", due: null },
    ],
  },
};

describe.skipIf(!TEST_DATABASE_URL)("transcript autopsy fixes (integration)", () => {
  let db: IsolatedDb;
  let domainId: string;
  let handle: string;
  let principalId: string;

  const deps = (over: Partial<Parameters<typeof makeDeps>[0]> = {}) => makeDeps(over);

  function makeDeps(over: {
    requestsPerHour?: number;
    modelReply?: string;
  }): ConversationDeps {
    return {
      db: db.pool,
      provider: new FakeModelProvider({
        respond: { text: over.modelReply ?? "model handled it" },
      }),
      registry: REGISTRY,
      principalPolicy: () => ({
        model: "fake/model-x",
        requestsPerHour: over.requestsPerHour ?? 60,
        costPerDay: 5,
        reads: ["commitments", "calendar", "state"],
      }),
      now: () => T0,
    };
  }

  const replyOf = async (outcome: { notificationId?: string }): Promise<string | undefined> => {
    if (outcome.notificationId === undefined) return undefined;
    const row = await db.pool.query(
      "SELECT payload->>'content' AS c FROM notifications WHERE id = $1::uuid",
      [outcome.notificationId],
    );
    return row.rows[0]?.c;
  };

  const setup = async (name: string, seq: number) => {
    const h = `+1555000${String(8000 + seq)}`;
    const principal = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
      [name],
    );
    const id = String(principal.rows[0].id);
    const session = await db.pool.query(
      `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, expires_at)
       VALUES ($1::uuid, 'pair', $2, now() + interval '5 minutes') RETURNING id`,
      [id, "d".repeat(64)],
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

  const activeThreadId = async (): Promise<string> => {
    const row = await db.pool.query(
      "SELECT id FROM interaction_threads WHERE principal_id = $1::uuid ORDER BY created_at DESC LIMIT 1",
      [principalId],
    );
    return String(row.rows[0].id);
  };

  const seedPendingBatch = async (): Promise<void> => {
    await setThreadPendingProposal(db.pool, {
      threadId: await activeThreadId(),
      principalId,
      pending: NINE_ITEM_BATCH,
    });
  };

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w6fix");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    domainId = String(domain.rows[0].id);
    const s = await setup("josctl", 1);
    principalId = s.id;
    handle = s.h;
    // create the active thread with one neutral turn
    await handleInbound(deps(), { principalId, handle, text: "hello" });
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("fix 1: bare 'confirm' applies the pending 9-item batch (dispatch by TYPE)", async () => {
    await seedPendingBatch();
    const outcome = await handleInbound(deps(), { principalId, handle, text: "confirm" });
    expect(outcome.replied).toBe(true);
    const reply = (await replyOf(outcome)) ?? "";
    expect(reply).toContain("Tracked 9 tasks");
    const count = await db.pool.query(
      `SELECT count(*)::int AS n FROM commitments WHERE description = ANY($1::text[])`,
      [
        [
          "Wedding seating chart", "wedding playlist", "wedding appetizers",
          "get prenup signed", "finish companions lecture", "build console table",
          "build bed", "Clean apartment and bathrooms", "call sheikh jamal",
        ],
      ],
    );
    expect(count.rows[0].n).toBe(9);
    const meta = await db.pool.query("SELECT metadata FROM interaction_threads WHERE id = $1::uuid", [
      await activeThreadId(),
    ]);
    expect(meta.rows[0].metadata?.pendingProposal).toBeUndefined();
  });

  it("fix 2: 'yes capture… assign thursday' applies the batch WITH the residue rule", async () => {
    await seedPendingBatch();
    const outcome = await handleInbound(deps(), {
      principalId,
      handle,
      text: "yes capture as committments anything that isnt specified for wednesday assign thursday as a deadline",
    });
    expect(outcome.replied).toBe(true);
    const rows = await db.pool.query(
      `SELECT due_at::date::text AS due_day FROM commitments
         WHERE description = 'Wedding seating chart' ORDER BY created_at DESC LIMIT 1`,
    );
    // due null → thursday 2026-09-24 (residue rule); without the rule: null
    expect(rows.rows[0].due_day).toBe("2026-09-24");
    const prenup = await db.pool.query(
      "SELECT due_at FROM commitments WHERE description ILIKE '%prenup%'",
    );
    expect(prenup.rows[0].due_at).not.toBeNull();
  });

  it("fix 2b: question-ish residue is NOT a confirm — pending survives, model answers", async () => {
    await seedPendingBatch();
    const outcome = await handleInbound(deps(), {
      principalId,
      handle,
      text: "yes and also what's on my calendar tomorrow",
    });
    expect(outcome.replied).toBe(true);
    expect((await replyOf(outcome)) ?? "").toBe("model handled it");
    const meta = await db.pool.query("SELECT metadata FROM interaction_threads WHERE id = $1::uuid", [
      await activeThreadId(),
    ]);
    expect(meta.rows[0].metadata?.pendingProposal).toBeDefined();
    await setThreadPendingProposal(db.pool, {
      threadId: await activeThreadId(),
      principalId,
      pending: null,
    });
  });

  it("fix 5: the model can't invent machinery — 'Reply confirm' is stripped from prose", async () => {
    const outcome = await handleInbound(
      deps({
        modelReply: "Understood.\n\nI'll capture all 9 items.\n\nReply 'confirm' to track them.",
        requestsPerHour: 60,
      }),
      { principalId, handle, text: "okay do it" },
    );
    const reply = (await replyOf(outcome)) ?? "";
    expect(reply).toContain("Understood.");
    expect(reply).not.toContain("Reply 'confirm'");
    expect(reply).not.toContain("Respond with");
  });

  it("fix 8: budget death speaks — one honest notice, then silence; inbound always logged", async () => {
    const first = await handleInbound(deps({ requestsPerHour: 0 }), {
      principalId,
      handle,
      text: "hello are you there",
    });
    // The gate returns replied:false; the notice goes out as its OWN
    // deterministic message (same pinned clock — assert on content).
    expect(first.replied).toBe(false);
    const noticeCount = async (): Promise<number> =>
      Number(
        (
          await db.pool.query(
            `SELECT count(*)::int AS n FROM notifications
               WHERE kind = 'reply' AND payload->>'content' LIKE '%request budget%'`,
          )
        ).rows[0].n,
      );
    expect(await noticeCount()).toBe(1);
    const noticeRow = await db.pool.query(
      `SELECT payload->>'content' AS c FROM notifications WHERE payload->>'content' LIKE '%request budget%'`,
    );
    expect(noticeRow.rows[0].c).toContain("still work");
    const second = await handleInbound(deps({ requestsPerHour: 0 }), {
      principalId,
      handle,
      text: "second message while dead",
    });
    expect(second.replied).toBe(false);
    // One notice per window — the second denial stays silent.
    expect(await noticeCount()).toBe(1);
    const threadId = await activeThreadId();
    const logged = await db.pool.query(
      `SELECT content FROM interaction_messages
         WHERE thread_id = $1::uuid AND direction = 'inbound'
           AND content IN ('hello are you there', 'second message while dead')`,
      [threadId],
    );
    expect(logged.rows.length).toBe(2);
  });

  it("fix 9: deterministic confirmations work while over budget", async () => {
    await seedPendingBatch();
    const outcome = await handleInbound(deps({ requestsPerHour: 0 }), {
      principalId,
      handle,
      text: "confirm",
    });
    expect(outcome.replied).toBe(true);
    const reply = (await replyOf(outcome)) ?? "";
    expect(reply).toContain("Tracked 9 tasks");
  });

  it("fix 10 (pure): open-items asks with an empty route read-set get day.state", () => {
    expect(augmentReadSetForAsk([], "what open items do i have for tomorrow", ["state"])).toEqual([
      { tool: "day.state" },
    ]);
    expect(augmentReadSetForAsk([], "best prestige TV shows?", ["state"])).toEqual([]);
    expect(augmentReadSetForAsk([{ tool: "calendar.day" }], "what's on my plate", ["state"])).toEqual([
      { tool: "calendar.day" },
    ]);
    expect(augmentReadSetForAsk([], "what's on my plate", [])).toEqual([]);
  });
});
