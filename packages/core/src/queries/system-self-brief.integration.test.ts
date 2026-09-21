import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { parsePolicyV1 } from "../policy/ceiling.js";
import {
  collectSelfBrief,
  renderSelfBrief,
  SELF_BRIEF_HONESTY_RULES,
} from "./system-self-brief.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-21T12:00:00.000Z");
const now = (): Date => NOW;
const HOUR = 3_600_000;

const POLICY_TEXT = `
version: 1
autonomy_ceiling:
  read: autonomous
  propose: autonomous
  write_canonical: gated
  external_side_effect: approval_required
  money_and_contracts: prohibited
gateway:
  capture: { enabled: true, principals: [josctl], max_per_hour: 5, dedupe_window_hours: 24 }
  review: { enabled: true, principals: [josctl], max_bad_refs: 3, snooze_hours: 24, ref_ttl_hours: 168, digest_max_candidates: 10, digest_max_escalations: 5 }
  actions: { enabled: true, principals: [josctl], max_proposals_per_day: 10, max_dispatches_per_day: 5, confirm_ttl_minutes: 10 }
  principals:
    josctl: { model: openai/gpt-4o-mini, requests_per_hour: 30, cost_per_day: 5.0, reads: [calendar, commitments, gmail, state, memory, system] }
    yusra: { model: openai/gpt-4o-mini, requests_per_hour: 20, cost_per_day: 2.0 }
personas: { enabled: true, principals: [josctl] }
`;

describe.skipIf(!TEST_DATABASE_URL)("system.self_brief (integration)", () => {
  let db: IsolatedDb;
  let josctlId: string;
  let yusraId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w6bselfbrief");
    await migrateUp(db.pool);
    await seedDomains(db.pool);

    const mkPrincipal = async (name: string): Promise<string> => {
      const inserted = await db.pool.query(
        `INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id`,
        [name],
      );
      return String(inserted.rows[0]!.id);
    };
    josctlId = await mkPrincipal(`w6b-josctl-${randomUUID().slice(0, 8)}`);
    yusraId = await mkPrincipal(`w6b-yusra-${randomUUID().slice(0, 8)}`);

    await setCalendarSync(new Date(NOW.getTime() - 30 * 60_000));
    await setGmailSync(new Date(NOW.getTime() - 30 * 60_000));
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function setCalendarSync(at: Date | null): Promise<void> {
    await db.pool.query(
      `INSERT INTO calendar_sync_state (id, calendar_id, sync_token, last_synced_at, last_page_count)
       VALUES (1, 'w6b-cal', NULL, $1::timestamptz, 0)
       ON CONFLICT (id) DO UPDATE SET last_synced_at = $1::timestamptz`,
      [at === null ? null : at.toISOString()],
    );
  }

  async function setGmailSync(at: Date | null): Promise<void> {
    await db.pool.query(
      `INSERT INTO gmail_sync_state (id, cursor_history_id, health, last_tick_at)
       VALUES ('singleton', NULL, '{}'::jsonb, $1::timestamptz)
       ON CONFLICT (id) DO UPDATE SET last_tick_at = $1::timestamptz`,
      [at === null ? null : at.toISOString()],
    );
  }

  it("reflects actual sync-state connectivity: golden render over the live DB", async () => {
    const brief = await collectSelfBrief(db.pool, {
      principalId: josctlId,
      principalName: "josctl",
      now,
      policy: parsePolicyV1(POLICY_TEXT),
      activeProfileVersion: 2,
    });
    expect(brief.sources).toEqual({ calendar: "read", gmail: "metadata_only" });
    expect(brief.memory).toEqual({ explicitCapture: true, recall: true, autoPromotion: false });
    expect(brief.persona).toEqual({
      enabled: true,
      selfModify: true,
      otherPrincipalModify: "owner_approval",
      activeProfileVersion: 2,
    });
    expect(brief.actions).toEqual({ calendarWrite: true, commitmentTracking: true });
    const text = renderSelfBrief(brief);
    expect(text).toContain("sources: calendar read; gmail metadata_only (sender patterns only — never subjects or bodies)");
    expect(text).toContain("conversation: bounded iMessage threads; working context 72h; raw messages kept 7d");
  });

  it("staleness boundary reuse: 6h+1m-stale-but-synced stays readable; never-synced is disconnected", async () => {
    await setCalendarSync(new Date(NOW.getTime() - (6 * HOUR + 60_000)));
    const stale = await collectSelfBrief(db.pool, {
      principalId: josctlId,
      principalName: "josctl",
      now,
      policy: parsePolicyV1(POLICY_TEXT),
    });
    // Capability ≠ freshness: staleness caveats are day.state's job (W1);
    // connectivity at any synced age still reads.
    expect(stale.sources.calendar).toBe("read");

    await setCalendarSync(null);
    await setGmailSync(null);
    const never = await collectSelfBrief(db.pool, {
      principalId: josctlId,
      principalName: "josctl",
      now,
      policy: parsePolicyV1(POLICY_TEXT),
    });
    expect(never.sources).toEqual({ calendar: "disconnected", gmail: "disconnected" });
    expect(renderSelfBrief(never)).toContain("sources: calendar disconnected; gmail disconnected");

    await setCalendarSync(new Date(NOW.getTime() - 30 * 60_000));
    await setGmailSync(new Date(NOW.getTime() - 30 * 60_000));
  });

  it("principal without memory read → recall false; ungranted sources render disconnected", async () => {
    // yusra has a converse budget but no reads (policy: no reads key).
    const brief = await collectSelfBrief(db.pool, {
      principalId: yusraId,
      principalName: "yusra",
      now,
      policy: parsePolicyV1(POLICY_TEXT),
    });
    expect(brief.memory.recall).toBe(false);
    expect(brief.memory.explicitCapture).toBe(false);
    expect(brief.persona.enabled).toBe(false);
    expect(brief.actions).toEqual({ calendarWrite: false, commitmentTracking: false });
    // Sensors are synced, but yusra holds no read grants: from the
    // conversation's perspective there is no usable path.
    expect(brief.sources).toEqual({ calendar: "disconnected", gmail: "disconnected" });
  });

  it("personas disabled in policy → persona.enabled false (fail-safe default is off)", async () => {
    const policy = parsePolicyV1(POLICY_TEXT.replace("personas: { enabled: true", "personas: { enabled: false"));
    const brief = await collectSelfBrief(db.pool, {
      principalId: josctlId,
      principalName: "josctl",
      now,
      policy,
    });
    expect(brief.persona.enabled).toBe(false);
    expect(brief.persona.selfModify).toBe(false);

    const absent = parsePolicyV1(POLICY_TEXT.replace(/\npersonas: .*\n/, "\n"));
    const briefAbsent = await collectSelfBrief(db.pool, {
      principalId: josctlId,
      principalName: "josctl",
      now,
      policy: absent,
    });
    expect(briefAbsent.persona.enabled).toBe(false);
  });

  it("read-only pin: zero writes anywhere (row counts unchanged, no audit rows)", async () => {
    const tables = [
      "principals",
      "calendar_sync_state",
      "gmail_sync_state",
      "commitments",
      "interaction_threads",
      "interaction_profiles",
      "events",
      "audit_log",
      "runs",
      "model_calls",
    ];
    const countsBefore = new Map<string, number>();
    for (const table of tables) {
      const result = await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      countsBefore.set(table, Number(result.rows[0]!.n));
    }
    await collectSelfBrief(db.pool, {
      principalId: josctlId,
      principalName: "josctl",
      now,
      policy: parsePolicyV1(POLICY_TEXT),
    });
    await collectSelfBrief(db.pool, { principalId: yusraId, now, policy: null });
    for (const table of tables) {
      const result = await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(Number(result.rows[0]!.n), table).toBe(countsBefore.get(table));
    }
  });

  it("secret-scrub pin: poisoned sync-state fields never surface", async () => {
    // The health jsonb is CHECK-constrained to the five dim keys/values, so
    // the poison rides calendar_id (free text) instead — the collector must
    // structurally never read anything but the sync timestamps.
    await db.pool.query(
      `UPDATE calendar_sync_state SET calendar_id = 'sk-live-CALSECRET-W6B'`,
    );
    const brief = await collectSelfBrief(db.pool, {
      principalId: josctlId,
      principalName: "josctl",
      now,
      policy: parsePolicyV1(POLICY_TEXT),
    });
    const serialized = JSON.stringify(brief);
    const text = renderSelfBrief(brief);
    expect(serialized).not.toContain("sk-live-CALSECRET-W6B");
    expect(text).not.toContain("sk-live-CALSECRET-W6B");
    for (const model of ["openai/", "gpt-4o-mini", "anthropic/"]) {
      expect(serialized).not.toContain(model);
      expect(text).not.toContain(model);
    }
    expect(SELF_BRIEF_HONESTY_RULES.length).toBeGreaterThan(0);
  });
});
