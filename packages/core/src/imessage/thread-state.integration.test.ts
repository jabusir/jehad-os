import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import {
  THREAD_REFERENT_REGISTRY_CAP,
  appendInteractionMessage,
  parseThreadMetadata,
  resolveActiveThread,
  retractThreadStance,
  type ThreadMetadata,
} from "./threads";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const CANONICAL_TABLES = [
  "commitments",
  "calendar_events",
  "action_intents",
  "action_attempts",
  "evidence",
  "decisions",
  "procedures",
  "memory_candidates",
  "events",
  "notifications",
  "audit_log",
  "model_calls",
  "review_refs",
  "escalations",
  "runs",
  "interaction_messages",
] as const;

describe.skipIf(!TEST_DATABASE_URL)("thread state (integration)", () => {
  let db: IsolatedDb;
  let jehadId: string;
  let yusraId: string;
  let now: Date;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "j1threadstate");
    await migrateUp(db.pool);
    const mk = async (name: string): Promise<string> => {
      const p = await db.pool.query(
        "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
        [name],
      );
      return String(p.rows[0].id);
    };
    jehadId = await mk("jehad");
    yusraId = await mk("yusra");
    now = new Date("2026-09-21T12:00:00Z");
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    await db.pool.query(`
      DELETE FROM interaction_messages; DELETE FROM interaction_threads;
    `);
    now = new Date("2026-09-21T12:00:00Z");
  });

  async function thread(principalId: string): Promise<string> {
    const t = await resolveActiveThread(db.pool, {
      principalId,
      surface: "imessage",
      now,
    });
    return t.id;
  }

  async function appendWithState(
    threadId: string,
    principalId: string,
    state: Parameters<typeof appendInteractionMessage>[0]["threadState"],
    receivedAt = now,
  ): Promise<void> {
    await appendInteractionMessage(db.pool, {
      threadId,
      principalId,
      surface: "imessage",
      direction: "inbound",
      trustClass: "authenticated_user_intent",
      content: "turn",
      receivedAt,
      threadState: state,
    });
  }

  async function metadataOf(threadId: string): Promise<ThreadMetadata | null> {
    const row = await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [
      threadId,
    ]);
    return parseThreadMetadata(row.rows[0]?.metadata);
  }

  async function rawMetadata(threadId: string): Promise<Record<string, unknown>> {
    const row = await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [
      threadId,
    ]);
    return row.rows[0].metadata as Record<string, unknown>;
  }

  async function tableCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of CANONICAL_TABLES) {
      const result = await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      counts[table] = Number(result.rows[0].n);
    }
    return counts;
  }

  it("append with thread state writes interaction_threads.metadata (topic, referents, lastStance)", async () => {
    const t = await thread(jehadId);
    const at = now.toISOString();
    await appendWithState(t, jehadId, {
      at,
      topic: "venue planning",
      referents: [{ kind: "action", ref: "7K4", label: "Henna sync proposal" }],
      stance: { kind: "proposal", summary: "proposed Henna sync tomorrow 2pm" },
    });
    expect(await metadataOf(t)).toEqual({
      topic: "venue planning",
      referents: [{ kind: "action", ref: "7K4", label: "Henna sync proposal", at }],
      lastStance: { kind: "proposal", summary: "proposed Henna sync tomorrow 2pm", at },
    });
  });

  it("append without thread state leaves metadata untouched (backward compatible)", async () => {
    const t = await thread(jehadId);
    await appendWithState(t, jehadId, null);
    expect(await rawMetadata(t)).toEqual({});
  });

  it("successive turns merge: topic replaced, referents appended and deduped, stance replaced", async () => {
    const t = await thread(jehadId);
    await appendWithState(t, jehadId, {
      at: now.toISOString(),
      topic: "first topic",
      referents: [
        { kind: "action", ref: "7K4", label: "v1" },
        { kind: "read", ref: "calendar.day", label: "today's calendar" },
      ],
      stance: { kind: "proposal", summary: "first stance" },
    });
    now = new Date(now.getTime() + 60_000);
    const secondAt = now.toISOString();
    await appendWithState(t, jehadId, {
      at: secondAt,
      topic: "second topic",
      referents: [{ kind: "action", ref: "7K4", label: "v2" }],
      stance: { kind: "answer", summary: "second stance" },
    });
    expect(await metadataOf(t)).toEqual({
      topic: "second topic",
      referents: [
        { kind: "action", ref: "7K4", label: "v2", at: secondAt },
        { kind: "read", ref: "calendar.day", label: "today's calendar", at: "2026-09-21T12:00:00.000Z" },
      ],
      lastStance: { kind: "answer", summary: "second stance", at: secondAt },
    });
  });

  it(`referent registry stays bounded at ${THREAD_REFERENT_REGISTRY_CAP} (newest kept)`, async () => {
    const t = await thread(jehadId);
    for (let turn = 0; turn < 3; turn++) {
      now = new Date(now.getTime() + 60_000);
      await appendWithState(t, jehadId, {
        at: now.toISOString(),
        referents: Array.from({ length: 8 }, (_, i) => ({
          kind: "read" as const,
          ref: `r${turn}-${i}`,
          label: `label ${turn}-${i}`,
        })),
      });
    }
    const metadata = await metadataOf(t);
    expect(metadata!.referents).toHaveLength(THREAD_REFERENT_REGISTRY_CAP);
    expect(metadata!.referents![0]!.ref).toBe("r0-4");
    expect(metadata!.referents!.at(-1)!.ref).toBe("r2-7");
  });

  it("thread state is per-thread: concurrent threads never share metadata", async () => {
    const jt = await thread(jehadId);
    const yt = await thread(yusraId);
    await appendWithState(jt, jehadId, {
      at: now.toISOString(),
      topic: "jehad topic",
      referents: [{ kind: "read", ref: "calendar.day", label: "cal" }],
    });
    await appendWithState(yt, yusraId, { at: now.toISOString(), topic: "yusra topic" });
    const jm = await metadataOf(jt);
    const ym = await metadataOf(yt);
    expect(jm!.topic).toBe("jehad topic");
    expect(ym!.topic).toBe("yusra topic");
    expect(ym!.referents).toBeUndefined();
  });

  it("retraction changes metadata only — ZERO canonical rows change anywhere (invariant pin)", async () => {
    const t = await thread(jehadId);
    const at = now.toISOString();
    await appendWithState(t, jehadId, {
      at,
      topic: "dinner",
      referents: [{ kind: "action", ref: "7K4", label: "reservation proposal" }],
      stance: { kind: "proposal", summary: "proposed 7:30pm dinner" },
    });
    const before = await tableCounts();
    const threadRowBefore = await db.pool.query(
      `SELECT status, last_activity_at, metadata FROM interaction_threads WHERE id = $1::uuid`,
      [t],
    );

    const retracted = await retractThreadStance(db.pool, { threadId: t, principalId: jehadId });

    expect(retracted.lastStance).toBeUndefined();
    expect(retracted.topic).toBe("dinner");
    expect(retracted.referents).toEqual([
      { kind: "action", ref: "7K4", label: "reservation proposal", at },
    ]);
    expect(await metadataOf(t)).toEqual(retracted);
    const after = await tableCounts();
    expect(after).toEqual(before);
    const threadRowAfter = await db.pool.query(
      `SELECT status, last_activity_at, metadata FROM interaction_threads WHERE id = $1::uuid`,
      [t],
    );
    expect(threadRowAfter.rows[0].status).toBe(threadRowBefore.rows[0].status);
    expect(
      new Date(threadRowAfter.rows[0].last_activity_at).toISOString(),
    ).toBe(new Date(threadRowBefore.rows[0].last_activity_at).toISOString());
    expect(threadRowAfter.rows[0].metadata).not.toEqual(threadRowBefore.rows[0].metadata);
  });

  it("retraction is idempotent and honest when no stance exists", async () => {
    const t = await thread(jehadId);
    await appendWithState(t, jehadId, { at: now.toISOString(), topic: "only topic" });
    const first = await retractThreadStance(db.pool, { threadId: t, principalId: jehadId });
    const second = await retractThreadStance(db.pool, { threadId: t, principalId: jehadId });
    expect(first).toEqual({ topic: "only topic" });
    expect(second).toEqual(first);
    expect(await metadataOf(t)).toEqual({ topic: "only topic" });
  });

  it("retraction fails closed on a foreign principal's thread", async () => {
    const jt = await thread(jehadId);
    await expect(
      retractThreadStance(db.pool, { threadId: jt, principalId: yusraId }),
    ).rejects.toThrow(/does not belong/i);
  });

  it("garbage metadata in the DB fails closed: merge rebuilds, retract returns empty", async () => {
    const t = await thread(jehadId);
    await db.pool.query(
      `UPDATE interaction_threads SET metadata = '{"bogus": true}'::jsonb WHERE id = $1::uuid`,
      [t],
    );
    now = new Date(now.getTime() + 60_000);
    await appendWithState(t, jehadId, { at: now.toISOString(), topic: "rebuilt" });
    expect(await metadataOf(t)).toEqual({ topic: "rebuilt" });

    await db.pool.query(
      `UPDATE interaction_threads SET metadata = '{"topic": "x", "evil": 1}'::jsonb WHERE id = $1::uuid`,
      [t],
    );
    const retracted = await retractThreadStance(db.pool, { threadId: t, principalId: jehadId });
    expect(retracted).toEqual({});
  });

  it("retention turnover starts a fresh thread with empty metadata (state does not leak across threads)", async () => {
    const t1 = await thread(jehadId);
    await appendWithState(t1, jehadId, {
      at: now.toISOString(),
      topic: "old thread topic",
      stance: { kind: "proposal", summary: "old stance" },
    });
    now = new Date(now.getTime() + 73 * 60 * 60_000);
    const t2 = await thread(jehadId);
    expect(t2).not.toBe(t1);
    expect(await metadataOf(t2)).toEqual({});
    const closed = await db.pool.query(
      `SELECT metadata FROM interaction_threads WHERE id = $1::uuid`,
      [t1],
    );
    expect(parseThreadMetadata(closed.rows[0].metadata)?.topic).toBe("old thread topic");
  });
});
