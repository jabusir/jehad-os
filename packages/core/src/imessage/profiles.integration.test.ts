// W4 integration tests (jarvis-v1.md §7 W4 rev2 R2; §5 invariants 2 + 9):
// append-only versioned storage (migration 018 — UPDATE/DELETE rejected,
// active = max version), the storage-layer cross-principal write guard,
// fail-closed inert behavior on unparseable definitions, and thread-scoped
// override lifecycle — the override survives W1 turn-state writes, expires
// with the thread, and NEVER persists to the profile (DB pin).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import {
  appendInteractionMessage,
  parseThreadMetadata,
  resolveActiveThread,
} from "./threads.js";
import {
  JOSCTL_PROFILE_DEFINITION,
  activeProfile,
  mergeThreadOverride,
  nextProfileVersion,
  renderPersonaFragment,
  seedProfile,
  setThreadProfileOverride,
} from "./profiles.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("interaction profiles (integration)", () => {
  let db: IsolatedDb;
  let josctlId: string;
  let yusraId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igprofiles");
    await migrateUp(db.pool);
    const mk = async (name: string): Promise<string> => {
      const p = await db.pool.query(
        "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
        [name],
      );
      return String(p.rows[0].id);
    };
    josctlId = await mk("josctl");
    yusraId = await mk("yusra");
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    // TRUNCATE, not DELETE — the append-only guard fires on row deletes.
    await db.pool.query("TRUNCATE interaction_profiles");
    await db.pool.query("DELETE FROM interaction_messages");
    await db.pool.query("DELETE FROM interaction_threads");
  });

  it("seed → next version → active is max(version); versions never mutate", async () => {
    const v1 = await seedProfile(db.pool, {
      principalId: josctlId,
      surface: "imessage",
      definition: JOSCTL_PROFILE_DEFINITION,
    });
    expect(v1).toBe(1);
    const briefer = {
      ...JOSCTL_PROFILE_DEFINITION,
      brevity: { maxSentences: 2, maxChars: 300 },
    };
    const v2 = await nextProfileVersion(db.pool, {
      principalId: josctlId,
      surface: "imessage",
      definition: briefer,
      via: "self",
    });
    expect(v2).toBe(2);

    const active = await activeProfile(db.pool, { principalId: josctlId, surface: "imessage" });
    expect(active?.version).toBe(2);
    expect(active?.definition.brevity).toEqual({ maxSentences: 2, maxChars: 300 });

    const all = await db.pool.query(
      `SELECT version, created_via FROM interaction_profiles ORDER BY version`,
    );
    expect(all.rows).toEqual([
      { version: 1, created_via: "owner_seed" },
      { version: 2, created_via: "self" },
    ]);

    // APPEND-ONLY PIN: no UPDATE path exists, even raw SQL.
    await expect(
      db.pool.query(`UPDATE interaction_profiles SET definition = '{"register":"x"}'::jsonb`),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.pool.query(`DELETE FROM interaction_profiles`),
    ).rejects.toThrow(/append-only/);
    const after = await activeProfile(db.pool, { principalId: josctlId, surface: "imessage" });
    expect(after?.version).toBe(2);
  });

  it("the active view yields exactly one row per (principal, surface) at the max version", async () => {
    for (let i = 0; i < 3; i++) {
      await nextProfileVersion(db.pool, {
        principalId: josctlId,
        surface: "imessage",
        definition: JOSCTL_PROFILE_DEFINITION,
        via: i === 0 ? "owner_seed" : "self",
      });
    }
    const rows = await db.pool.query(
      `SELECT count(*)::int AS n FROM interaction_profiles_active`,
    );
    expect(rows.rows[0].n).toBe(1);
    const active = await activeProfile(db.pool, { principalId: josctlId, surface: "imessage" });
    expect(active?.version).toBe(3);
  });

  it("CROSS-PRINCIPAL GUARD: rows can never be re-attributed; reads never cross principals", async () => {
    await seedProfile(db.pool, {
      principalId: josctlId,
      surface: "imessage",
      definition: JOSCTL_PROFILE_DEFINITION,
    });
    await seedProfile(db.pool, {
      principalId: yusraId,
      surface: "imessage",
      definition: {
        register: "warm and direct",
        brevity: { maxSentences: 6, maxChars: 900 },
        explanation: "lead_with_context",
        address: {},
      },
    });
    await expect(
      db.pool.query(`UPDATE interaction_profiles SET principal_id = $1::uuid`, [yusraId]),
    ).rejects.toThrow(/append-only/);

    const josctlActive = await activeProfile(db.pool, { principalId: josctlId, surface: "imessage" });
    const yusraActive = await activeProfile(db.pool, { principalId: yusraId, surface: "imessage" });
    expect(josctlActive?.definition.register).toBe(JOSCTL_PROFILE_DEFINITION.register);
    expect(yusraActive?.definition.register).toBe("warm and direct");
    expect(josctlActive?.definition.address).toEqual({ ownerName: "Chief" });

    // Surface separation: a different surface starts fresh at v1.
    const other = await activeProfile(db.pool, { principalId: josctlId, surface: "web" });
    expect(other).toBeNull();
  });

  it("created_via CHECK + UNIQUE (principal, surface, version) are structural", async () => {
    await seedProfile(db.pool, {
      principalId: josctlId,
      surface: "imessage",
      definition: JOSCTL_PROFILE_DEFINITION,
    });
    await expect(
      db.pool.query(
        `INSERT INTO interaction_profiles (id, principal_id, surface, version, definition, created_via)
         VALUES (gen_random_uuid(), $1::uuid, 'imessage', 2, '{}', 'admin')`,
        [josctlId],
      ),
    ).rejects.toThrow(/created_via/);
    await expect(
      db.pool.query(
        `INSERT INTO interaction_profiles (id, principal_id, surface, version, definition, created_via)
         VALUES (gen_random_uuid(), $1::uuid, 'imessage', 1, '{}', 'self')`,
        [josctlId],
      ),
    ).rejects.toThrow(/duplicate key|unique/);
  });

  it("an unparseable stored definition is INERT (null), never a guess", async () => {
    await db.pool.query(
      `INSERT INTO interaction_profiles (id, principal_id, surface, version, definition, created_via)
       VALUES (gen_random_uuid(), $1::uuid, 'imessage', 1, $2, 'owner_seed')`,
      [josctlId, JSON.stringify({ register: "hostile", evil: true })],
    );
    expect(await activeProfile(db.pool, { principalId: josctlId, surface: "imessage" })).toBeNull();
  });

  it("invalid surfaces and invalid definitions are refused before storage", async () => {
    await expect(
      activeProfile(db.pool, { principalId: josctlId, surface: "Not A Surface" }),
    ).rejects.toThrow(/surface/);
    await expect(
      seedProfile(db.pool, {
        principalId: josctlId,
        surface: "imessage",
        definition: { ...JOSCTL_PROFILE_DEFINITION, brevity: { maxSentences: 0, maxChars: 10 } },
      }),
    ).rejects.toThrow(/strict schema/);
  });

  it("THREAD OVERRIDE lifecycle: survives turn-state writes, expires with the thread, NEVER persists to the profile", async () => {
    const v1 = await seedProfile(db.pool, {
      principalId: josctlId,
      surface: "imessage",
      definition: JOSCTL_PROFILE_DEFINITION,
    });
    expect(v1).toBe(1);
    const beforeProfile = await db.pool.query(
      `SELECT definition::text AS d FROM interaction_profiles WHERE principal_id = $1::uuid`,
      [josctlId],
    );

    const thread = await resolveActiveThread(db.pool, {
      principalId: josctlId,
      surface: "imessage",
      now: new Date(),
    });
    const directive = parse_thread_directive();
    await setThreadProfileOverride(db.pool, {
      threadId: thread.id,
      principalId: josctlId,
      override: directive,
    });

    // The override lives under the literal profile_override key and
    // round-trips the strict metadata parser.
    const stored = await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [
      thread.id,
    ]);
    const parsed = parseThreadMetadata(stored.rows[0].metadata);
    expect(parsed?.profile_override).toEqual(directive);

    // It SURVIVES W1 turn-state writes (topic/referents/stance merges).
    await appendInteractionMessage(db.pool, {
      threadId: thread.id,
      principalId: josctlId,
      surface: "imessage",
      direction: "inbound",
      trustClass: "authenticated_user_intent",
      content: "what is going on today",
      receivedAt: new Date(),
      threadState: {
        at: new Date().toISOString(),
        topic: "status check",
        referents: [{ kind: "read", ref: "day.state", label: "assembled day state" }],
        stance: { kind: "answer", summary: "gave the assembled picture" },
      },
    });
    const afterTurn = await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [
      thread.id,
    ]);
    const afterParsed = parseThreadMetadata(afterTurn.rows[0].metadata);
    expect(afterParsed?.topic).toBe("status check");
    expect(afterParsed?.profile_override).toEqual(directive);

    // The effective persona is definition + override — and stays clean.
    const active = await activeProfile(db.pool, { principalId: josctlId, surface: "imessage" });
    const effective = mergeThreadOverride(active!.definition, afterParsed?.profile_override ?? null);
    expect(effective.brevity.maxSentences).toBe(JOSCTL_PROFILE_DEFINITION.brevity.maxSentences - 2);
    const fragment = renderPersonaFragment(effective, { principalName: "josctl" });
    expect(fragment).toContain(`${effective.brevity.maxSentences} sentences`);

    // DB PIN: the profile row is byte-identical — the override NEVER persists.
    const afterProfile = await db.pool.query(
      `SELECT definition::text AS d FROM interaction_profiles WHERE principal_id = $1::uuid`,
      [josctlId],
    );
    expect(afterProfile.rows).toEqual(beforeProfile.rows);

    // EXPIRY WITH THREAD: turnover closes the thread; the new one is clean.
    const fresh = await resolveActiveThread(db.pool, {
      principalId: josctlId,
      surface: "imessage",
      now: new Date(),
      forceReset: true,
    });
    expect(fresh.id).not.toBe(thread.id);
    const freshMeta = await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [
      fresh.id,
    ]);
    expect(parseThreadMetadata(freshMeta.rows[0].metadata)?.profile_override).toBeUndefined();
    expect((await activeProfile(db.pool, { principalId: josctlId, surface: "imessage" }))?.version).toBe(1);

    // Clearing the override on a thread removes the key entirely.
    await setThreadProfileOverride(db.pool, {
      threadId: thread.id,
      principalId: josctlId,
      override: null,
    });
    const cleared = await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [
      thread.id,
    ]);
    expect(parseThreadMetadata(cleared.rows[0].metadata)?.profile_override).toBeUndefined();

    function parse_thread_directive() {
      return {
        brevityDelta: { maxSentences: -2, maxChars: -300 },
        extraDirective: "Answer the principal as \"Chief\" for this thread only.",
      };
    }
  });

  it("CROSS-PRINCIPAL: setThreadProfileOverride fails closed on a foreign thread; empty overrides are refused", async () => {
    const josctlThread = await resolveActiveThread(db.pool, {
      principalId: josctlId,
      surface: "imessage",
      now: new Date(),
    });
    await expect(
      setThreadProfileOverride(db.pool, {
        threadId: josctlThread.id,
        principalId: yusraId,
        override: { brevityDelta: { maxSentences: -2 } },
      }),
    ).rejects.toThrow(/does not belong/i);
    await expect(
      setThreadProfileOverride(db.pool, {
        threadId: josctlThread.id,
        principalId: josctlId,
        override: {},
      }),
    ).rejects.toThrow(/brevity delta or a directive/);
  });
});
