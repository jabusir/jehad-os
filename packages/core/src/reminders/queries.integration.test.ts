// Reminder queries integration tests (W6-phase-2 lane R1,
// w6-phase-2-reminders.md) against an isolated migrated database. Covers
// the data-layer contract: create + dueTouches ordering, touch recording
// with nudge escalation counting, the armed-guarded state transitions
// (complete / renegotiate-with-forgiveness / park / cancel), principal
// isolation (list/count are per-principal; the sweep feed is not), and the
// parked-since evening-brief filter. Needs PostgreSQL 16 — skipped unless
// TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  ReminderInputError,
  ReminderNotArmedError,
  ReminderNotFoundError,
  cancelReminder,
  completeReminder,
  countArmedReminders,
  createReminder,
  dueTouches,
  getReminder,
  listParkedSince,
  listReminders,
  parkReminder,
  recordTouch,
  renegotiateReminder,
  type CreateReminderInput,
  type ReminderRow,
} from "./queries.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const H = 3_600_000;
const MIN = 60_000;

// September 2026 — PDT (UTC-7). December — PST (UTC-8): the DST pair.
const T0 = new Date("2026-09-21T18:00:00.000Z");
const JEHAD = "principal-jehad";
const YUSRA = "principal-yusra";

describe.skipIf(!TEST_DATABASE_URL)("reminder queries (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w6rem");
    await migrateUp(db.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    await db.pool.query("DELETE FROM reminders");
  });

  async function mk(
    principal: string,
    title: string,
    firstTouchAt: Date,
    opts: Partial<CreateReminderInput> = {},
  ): Promise<ReminderRow> {
    return createReminder(db.pool, {
      principal,
      title,
      dueDate: "2026-09-22",
      firstTouchAt,
      firstTouchKind: "morning",
      threadId: randomUUID(),
      ...opts,
    });
  }

  async function nudgeTwice(id: string): Promise<ReminderRow> {
    await recordTouch(db.pool, id, {
      at: new Date(T0.getTime() + 24 * H),
      kind: "nudge",
      nextTouchAt: new Date(T0.getTime() + 48 * H),
      nextTouchKind: "nudge",
    });
    return recordTouch(db.pool, id, {
      at: new Date(T0.getTime() + 48 * H),
      kind: "nudge",
      nextTouchAt: null,
      nextTouchKind: null,
    });
  }

  it("create arms the row; dueTouches returns only due armed rows in next_touch_at order", async () => {
    const r1 = await mk(JEHAD, "call sheikh jamaal", new Date(T0.getTime() + 15 * H));
    const r2 = await mk(JEHAD, "file the permit", new Date(T0.getTime() + 21.5 * H), {
      firstTouchKind: "probe",
      dueTime: { hour: 15, minute: 0 },
    });
    const r3 = await mk(JEHAD, "water the plants", new Date(T0.getTime() + 23 * H));

    expect(r1.status).toBe("armed");
    expect(r1.dueDate).toBe("2026-09-22");
    expect(r1.dueTime).toBeNull();
    expect(r1.escalations).toBe(0);
    expect(r1.renegotiations).toBe(0);
    expect(r1.resolvedAt).toBeNull();
    expect(r1.nextTouchAt).toBe(new Date(T0.getTime() + 15 * H).toISOString());
    expect(r1.nextTouchKind).toBe("morning");
    expect(typeof r1.threadId).toBe("string");

    expect(await dueTouches(db.pool, T0)).toEqual([]);

    const afterProbe = await dueTouches(db.pool, new Date(T0.getTime() + 21.5 * H));
    expect(afterProbe.map((r) => r.id)).toEqual([r1.id, r2.id]);
    expect(afterProbe.map((r) => r.title)).toEqual(["call sheikh jamaal", "file the permit"]);

    const all = await dueTouches(db.pool, new Date(T0.getTime() + 23 * H));
    expect(all.map((r) => r.id)).toEqual([r1.id, r2.id, r3.id]);
  });

  it("explicit dueTime pins principal-local PT on the due date — DST-aware", async () => {
    const summer = await mk(JEHAD, "afternoon thing", new Date(T0.getTime() + H), {
      dueTime: { hour: 15, minute: 0 },
    });
    // 15:00 PDT (UTC-7) on 2026-09-22.
    expect(summer.dueTime).toBe("2026-09-22T22:00:00.000Z");

    const winter = await mk(JEHAD, "winter thing", new Date(T0.getTime() + H), {
      dueDate: "2026-12-22",
      dueTime: { hour: 9, minute: 0 },
    });
    // 09:00 PST (UTC-8) on 2026-12-22 — the offset moved with DST.
    expect(winter.dueTime).toBe("2026-12-22T17:00:00.000Z");
    expect(winter.dueDate).toBe("2026-12-22");
  });

  it("recordTouch moves last/next touch fields; only nudges increment escalations", async () => {
    const r = await mk(JEHAD, "call sheikh jamaal", new Date(T0.getTime() + 15 * H));

    const afterMorning = await recordTouch(db.pool, r.id, {
      at: new Date(T0.getTime() + 15 * H),
      kind: "morning",
      nextTouchAt: new Date(T0.getTime() + 21.5 * H),
      nextTouchKind: "probe",
    });
    expect(afterMorning.lastTouchAt).toBe(new Date(T0.getTime() + 15 * H).toISOString());
    expect(afterMorning.nextTouchAt).toBe(new Date(T0.getTime() + 21.5 * H).toISOString());
    expect(afterMorning.nextTouchKind).toBe("probe");
    expect(afterMorning.escalations).toBe(0);

    const afterProbe = await recordTouch(db.pool, r.id, {
      at: new Date(T0.getTime() + 21.5 * H),
      kind: "probe",
      nextTouchAt: new Date(T0.getTime() + 39 * H),
      nextTouchKind: "nudge",
    });
    expect(afterProbe.escalations).toBe(0);

    const afterNudge1 = await recordTouch(db.pool, r.id, {
      at: new Date(T0.getTime() + 39 * H),
      kind: "nudge",
      nextTouchAt: null,
      nextTouchKind: null,
    });
    expect(afterNudge1.escalations).toBe(1);
    expect(afterNudge1.nextTouchAt).toBeNull();
    expect(afterNudge1.nextTouchKind).toBeNull();

    const afterNudge2 = await recordTouch(db.pool, r.id, {
      at: new Date(T0.getTime() + 63 * H),
      kind: "nudge",
      nextTouchAt: null,
      nextTouchKind: null,
    });
    expect(afterNudge2.escalations).toBe(2);
    expect(afterNudge2.renegotiations).toBe(0);
  });

  it("complete: armed → completed with resolution provenance; leaves the sweep", async () => {
    const r = await mk(JEHAD, "call sheikh jamaal", new Date(T0.getTime() + 15 * H));
    const done = await completeReminder(db.pool, r.id, "user_reply");
    expect(done.status).toBe("completed");
    expect(done.resolvedVia).toBe("user_reply");
    expect(done.resolvedAt).not.toBeNull();
    expect(done.nextTouchAt).toBeNull();
    expect(done.nextTouchKind).toBeNull();

    expect((await getReminder(db.pool, r.id))?.status).toBe("completed");
    expect((await dueTouches(db.pool, new Date(T0.getTime() + 48 * H))).map((x) => x.id)).toEqual([]);
  });

  it("renegotiate: escalations are forgiven to 0, renegotiations bump, row stays armed", async () => {
    const r = await mk(JEHAD, "call sheikh jamaal", new Date(T0.getTime() + 15 * H));
    await nudgeTwice(r.id);
    expect((await getReminder(db.pool, r.id))?.escalations).toBe(2);

    const next = new Date(T0.getTime() + 63 * H);
    const moved = await renegotiateReminder(db.pool, r.id, {
      dueDate: "2026-09-25",
      dueTime: null,
      firstTouchAt: next,
      firstTouchKind: "morning",
    });
    expect(moved.status).toBe("armed");
    expect(moved.escalations).toBe(0);
    expect(moved.renegotiations).toBe(1);
    expect(moved.dueDate).toBe("2026-09-25");
    expect(moved.nextTouchAt).toBe(next.toISOString());
    expect(moved.nextTouchKind).toBe("morning");
  });

  it("renegotiate with an explicit time re-pins dueTime to PT", async () => {
    const r = await mk(JEHAD, "call sheikh jamaal", new Date(T0.getTime() + 15 * H));
    const moved = await renegotiateReminder(db.pool, r.id, {
      dueDate: "2026-09-25",
      dueTime: { hour: 20, minute: 0 },
      firstTouchAt: new Date(T0.getTime() + 63 * H),
      firstTouchKind: "probe",
    });
    expect(moved.dueTime).toBe("2026-09-26T03:00:00.000Z"); // 20:00 PDT
    expect(moved.nextTouchKind).toBe("probe");
  });

  it("park: armed → parked at the given instant; cancel: armed → cancelled with via", async () => {
    const p = await mk(JEHAD, "still open", new Date(T0.getTime() + 15 * H));
    const parkedAt = new Date(T0.getTime() + 87 * H);
    const parked = await parkReminder(db.pool, p.id, parkedAt);
    expect(parked.status).toBe("parked");
    expect(parked.parkedAt).toBe(parkedAt.toISOString());
    expect(parked.nextTouchAt).toBeNull();
    expect(parked.nextTouchKind).toBeNull();

    const c = await mk(JEHAD, "never mind", new Date(T0.getTime() + 15 * H));
    const cancelled = await cancelReminder(db.pool, c.id, "user");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledVia).toBe("user");
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.nextTouchAt).toBeNull();
  });

  it("transitions are guarded: unknown id → NotFound, non-armed → NotArmed", async () => {
    const missing = randomUUID();
    await expect(completeReminder(db.pool, missing, "manual")).rejects.toThrow(ReminderNotFoundError);
    await expect(recordTouch(db.pool, missing, { at: T0, kind: "probe", nextTouchAt: null, nextTouchKind: null })).rejects.toThrow(
      ReminderNotFoundError,
    );

    const parked = await parkReminder(
      db.pool,
      (await mk(JEHAD, "to park", new Date(T0.getTime() + H))).id,
      T0,
    );
    await expect(completeReminder(db.pool, parked.id, "user_reply")).rejects.toThrow(ReminderNotArmedError);
    await expect(renegotiateReminder(db.pool, parked.id, {
      dueDate: "2026-09-25",
      dueTime: null,
      firstTouchAt: T0,
      firstTouchKind: "morning",
    })).rejects.toThrow(ReminderNotArmedError);
    await expect(cancelReminder(db.pool, parked.id, "user")).rejects.toThrow(ReminderNotArmedError);
    await expect(
      recordTouch(db.pool, parked.id, { at: T0, kind: "probe", nextTouchAt: null, nextTouchKind: null }),
    ).rejects.toThrow(ReminderNotArmedError);

    const cancelled = await cancelReminder(
      db.pool,
      (await mk(JEHAD, "to cancel", new Date(T0.getTime() + H))).id,
      "manual",
    );
    expect(cancelled.cancelledVia).toBe("manual");
    await expect(parkReminder(db.pool, cancelled.id, T0)).rejects.toThrow(ReminderNotArmedError);
  });

  it("getReminder returns null for unknown ids; list/count are principal-isolated", async () => {
    expect(await getReminder(db.pool, randomUUID())).toBeNull();

    const mine = await mk(JEHAD, "mine", new Date(T0.getTime() + H));
    const theirs = await mk(YUSRA, "theirs", new Date(T0.getTime() + H));

    const myList = await listReminders(db.pool, JEHAD);
    expect(myList.map((r) => r.id)).toEqual([mine.id]);
    const yourList = await listReminders(db.pool, YUSRA);
    expect(yourList.map((r) => r.id)).toEqual([theirs.id]);

    expect(await countArmedReminders(db.pool, JEHAD)).toBe(1);
    expect(await countArmedReminders(db.pool, YUSRA)).toBe(1);

    // The sweep feed is cross-principal by design; principal rides the row.
    const sweep = await dueTouches(db.pool, new Date(T0.getTime() + 2 * H));
    expect(new Set(sweep.map((r) => r.principal))).toEqual(new Set([JEHAD, YUSRA]));
  });

  it("listReminders filters by status; completed/parked/cancelled leave the armed count", async () => {
    const r = await mk(JEHAD, "one", new Date(T0.getTime() + H));
    await mk(JEHAD, "two", new Date(T0.getTime() + H));

    expect((await listReminders(db.pool, JEHAD, { statuses: ["armed"] })).length).toBe(2);
    expect((await listReminders(db.pool, JEHAD, { statuses: ["parked"] })).length).toBe(0);

    await parkReminder(db.pool, r.id, T0);
    const parked = await listReminders(db.pool, JEHAD, { statuses: ["parked"] });
    expect(parked.map((x) => x.title)).toEqual(["one"]);
    expect(await countArmedReminders(db.pool, JEHAD)).toBe(1);

    await expect(listReminders(db.pool, JEHAD, { statuses: ["nope"] })).rejects.toThrow(ReminderInputError);
  });

  it("listParkedSince returns this principal's rows parked at or after the cutoff", async () => {
    const cutoff = new Date(T0.getTime() + 24 * H);
    const older = await mk(JEHAD, "older parked", new Date(T0.getTime() + H));
    const newer = await mk(JEHAD, "newer parked", new Date(T0.getTime() + H));
    const foreign = await mk(YUSRA, "foreign parked", new Date(T0.getTime() + H));

    await parkReminder(db.pool, older.id, new Date(T0.getTime() + 20 * H));
    await parkReminder(db.pool, newer.id, new Date(T0.getTime() + 30 * H));
    await parkReminder(db.pool, foreign.id, new Date(T0.getTime() + 40 * H));

    const sinceCutoff = await listParkedSince(db.pool, JEHAD, cutoff);
    expect(sinceCutoff.map((r) => r.id)).toEqual([newer.id]);

    const sinceBeginning = await listParkedSince(db.pool, JEHAD, T0);
    expect(sinceBeginning.map((r) => r.id)).toEqual([older.id, newer.id]);
    expect(await listParkedSince(db.pool, YUSRA, T0).then((rs) => rs.map((r) => r.id))).toEqual([
      foreign.id,
    ]);
  });

  it("createReminder validates its input before touching the database", async () => {
    await expect(
      mk("", "no principal", T0),
    ).rejects.toThrow(ReminderInputError);
    await expect(
      createReminder(db.pool, {
        principal: JEHAD,
        title: "",
        dueDate: "2026-09-22",
        firstTouchAt: T0,
        firstTouchKind: "morning",
      }),
    ).rejects.toThrow(ReminderInputError);
    await expect(
      createReminder(db.pool, {
        principal: JEHAD,
        title: "x",
        dueDate: "2026-02-30",
        firstTouchAt: T0,
        firstTouchKind: "morning",
      }),
    ).rejects.toThrow(ReminderInputError);
    await expect(
      createReminder(db.pool, {
        principal: JEHAD,
        title: "x",
        dueDate: "2026-09-22",
        dueTime: { hour: 25, minute: 0 },
        firstTouchAt: T0,
        firstTouchKind: "morning",
      }),
    ).rejects.toThrow(ReminderInputError);
    await expect(
      createReminder(db.pool, {
        principal: JEHAD,
        title: "x",
        dueDate: "2026-09-22",
        firstTouchAt: new Date("not a date"),
        firstTouchKind: "morning",
      }),
    ).rejects.toThrow(ReminderInputError);
    await expect(
      createReminder(db.pool, {
        principal: JEHAD,
        title: "x",
        dueDate: "2026-09-22",
        firstTouchAt: T0,
        firstTouchKind: "evening",
      }),
    ).rejects.toThrow(ReminderInputError);
    await expect(
      createReminder(db.pool, {
        principal: JEHAD,
        title: "x",
        commitmentId: "not-a-uuid",
        dueDate: "2026-09-22",
        firstTouchAt: T0,
        firstTouchKind: "morning",
      }),
    ).rejects.toThrow(ReminderInputError);
    expect(await countArmedReminders(db.pool, JEHAD)).toBe(0);
  });

  it("countArmedReminders counts only armed rows; terminal transitions decrement it", async () => {
    const a = await mk(JEHAD, "armed", new Date(T0.getTime() + H));
    const b = await mk(JEHAD, "to complete", new Date(T0.getTime() + H));
    const c = await mk(JEHAD, "to park", new Date(T0.getTime() + H));
    expect(await countArmedReminders(db.pool, JEHAD)).toBe(3);
    await completeReminder(db.pool, b.id, "manual");
    await parkReminder(db.pool, c.id, new Date(T0.getTime() + 2 * MIN));
    expect(await countArmedReminders(db.pool, JEHAD)).toBe(1);
    expect((await getReminder(db.pool, a.id))?.escalations).toBe(0);
  });
});
