import { describe, expect, it } from "vitest";
import { parsePolicyV1, type PolicyV1 } from "../policy/ceiling.js";
import { SYSTEM_STATE_LIMITATIONS } from "./system-state.js";
import {
  collectSelfBrief,
  renderSelfBrief,
  SELF_BRIEF_HONESTY_RULES,
  SELF_BRIEF_LIMITATIONS_VERSION,
  SELF_BRIEF_MAX_LINES,
} from "./system-self-brief.js";

function fakeDb(scripts: readonly { readonly sql: string; readonly rows: Record<string, unknown>[] }[]) {
  const issued: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let call = 0;
  return {
    issued,
    query: async (text: string, values?: readonly unknown[]) => {
      const script = scripts[call];
      call += 1;
      if (script === undefined) throw new Error(`unexpected query #${call - 1}: ${text}`);
      if (!text.includes(script.sql)) {
        throw new Error(`query #${call - 1} does not match script '${script.sql}'`);
      }
      issued.push({ sql: text, values });
      return { rows: script.rows };
    },
  };
}

const NOW = new Date("2026-09-21T12:00:00.000Z");
const now = (): Date => NOW;
const HOUR = 3_600_000;
const PRINCIPAL = "11111111-1111-1111-1111-111111111111";

function syncScripts(
  calendar: Date | null,
  gmail: Date | null,
  poison = false,
): { readonly sql: string; readonly rows: Record<string, unknown>[] }[] {
  const row = (at: Date | null): Record<string, unknown>[] =>
    at === null
      ? []
      : poison
        ? [
            {
              last_synced_at: at,
              health: JSON.stringify({ credential: "SECRETCRED" }),
              token_hash: "sha256:SECRETHASH123",
            },
          ]
        : [{ last_synced_at: at }];
  return [
    { sql: "calendar_sync_state", rows: row(calendar) },
    { sql: "gmail_sync_state", rows: row(gmail) },
  ];
}

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
    yusra: { model: anthropic/claude-sonnet-4.5, requests_per_hour: 20, cost_per_day: 2.0 }
personas: { enabled: true, principals: [josctl] }
`;

const POLICY = parsePolicyV1(POLICY_TEXT);

interface CollectInput {
  readonly cal: Date | null;
  readonly gmail: Date | null;
  readonly policy: PolicyV1 | null;
  readonly name: string | undefined;
  readonly v: number | null;
}

describe("collectSelfBrief (unit)", () => {
  it("derives every section from live sync state + policy + code constants", async () => {
    const db = fakeDb(syncScripts(new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR)));
    const brief = await collectSelfBrief(db, {
      principalId: PRINCIPAL,
      principalName: "josctl",
      now,
      policy: POLICY,
      activeProfileVersion: 3,
    });
    expect(brief).toEqual({
      principalId: PRINCIPAL,
      now: NOW.toISOString(),
      sources: { calendar: "read", gmail: "metadata_only" },
      memory: { explicitCapture: true, recall: true, autoPromotion: false },
      conversation: { threads: true, rawRetentionDays: 7, workingContextHours: 72 },
      persona: {
        enabled: true,
        selfModify: true,
        otherPrincipalModify: "owner_approval",
        activeProfileVersion: 3,
      },
      actions: { calendarWrite: true, commitmentTracking: true },
      remindersArmed: null,
      limits: [...SYSTEM_STATE_LIMITATIONS],
    });
  });

  it("policy null → policy-derived values are null (unknown), never guesses", async () => {
    const db = fakeDb(syncScripts(new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR)));
    const brief = await collectSelfBrief(db, { principalId: PRINCIPAL, now, policy: null });
    expect(brief.sources).toEqual({ calendar: "unknown", gmail: "unknown" });
    expect(brief.memory).toEqual({ explicitCapture: null, recall: null, autoPromotion: false });
    expect(brief.persona.enabled).toBeNull();
    expect(brief.persona.selfModify).toBeNull();
    expect(brief.persona.activeProfileVersion).toBeNull();
    expect(brief.actions).toEqual({ calendarWrite: null, commitmentTracking: null });
    // Policy-independent facts stay factual.
    expect(brief.conversation).toEqual({ threads: true, rawRetentionDays: 7, workingContextHours: 72 });
    expect(brief.limits).toEqual([...SYSTEM_STATE_LIMITATIONS]);
  });

  it("principal without memory read → recall false (a known negative, not unknown)", async () => {
    const policy = parsePolicyV1(
      POLICY_TEXT.replace(
        "reads: [calendar, commitments, gmail, state, memory, system]",
        "reads: [calendar, state]",
      ),
    );
    const db = fakeDb(syncScripts(new Date(NOW.getTime() - HOUR), null));
    const brief = await collectSelfBrief(db, {
      principalId: PRINCIPAL,
      principalName: "josctl",
      now,
      policy,
    });
    expect(brief.memory.recall).toBe(false);
    expect(brief.sources.calendar).toBe("read");
    expect(brief.sources.gmail).toBe("disconnected");
  });

  it("personas disabled → persona.enabled false and selfModify false", async () => {
    const policy = parsePolicyV1(POLICY_TEXT.replace("personas: { enabled: true", "personas: { enabled: false"));
    const db = fakeDb(syncScripts(new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR)));
    const brief = await collectSelfBrief(db, {
      principalId: PRINCIPAL,
      principalName: "josctl",
      now,
      policy,
    });
    expect(brief.persona.enabled).toBe(false);
    expect(brief.persona.selfModify).toBe(false);
  });

  it("principal absent from gateway → fail-closed negatives for reads-derived values", async () => {
    const db = fakeDb(syncScripts(new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR)));
    const brief = await collectSelfBrief(db, {
      principalId: PRINCIPAL,
      principalName: "yusra",
      now,
      policy: POLICY,
    });
    expect(brief.sources).toEqual({ calendar: "disconnected", gmail: "disconnected" });
    expect(brief.memory.recall).toBe(false);
    expect(brief.memory.explicitCapture).toBe(false);
    expect(brief.actions.calendarWrite).toBe(false);
    expect(brief.actions.commitmentTracking).toBe(false);
    expect(brief.persona.enabled).toBe(false);
  });

  it("policy present but principalName absent → name-scoped gates unknown", async () => {
    const db = fakeDb(syncScripts(new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR)));
    const brief = await collectSelfBrief(db, { principalId: PRINCIPAL, now, policy: POLICY });
    expect(brief.sources.calendar).toBe("unknown");
    expect(brief.memory.explicitCapture).toBeNull();
    expect(brief.persona.enabled).toBeNull();
  });

  it("never-synced sensors are disconnected regardless of policy", async () => {
    const noPolicy = await collectSelfBrief(fakeDb(syncScripts(null, null)), {
      principalId: PRINCIPAL,
      now,
      policy: null,
    });
    expect(noPolicy.sources).toEqual({ calendar: "disconnected", gmail: "disconnected" });

    const withPolicy = await collectSelfBrief(fakeDb(syncScripts(null, null)), {
      principalId: PRINCIPAL,
      principalName: "josctl",
      now,
      policy: POLICY,
    });
    expect(withPolicy.sources).toEqual({ calendar: "disconnected", gmail: "disconnected" });
  });

  it("read-only: exactly the two sync-state SELECTs are issued", async () => {
    const db = fakeDb(syncScripts(new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR)));
    await collectSelfBrief(db, {
      principalId: PRINCIPAL,
      principalName: "josctl",
      now,
      policy: POLICY,
    });
    expect(db.issued).toHaveLength(2);
    for (const { sql } of db.issued) {
      expect(sql.trimStart().toUpperCase().startsWith("SELECT")).toBe(true);
    }
  });

  it("rejects a non-uuid principalId before touching the database", async () => {
    const db = fakeDb([]);
    await expect(
      collectSelfBrief(db, { principalId: "not-a-uuid", now, policy: POLICY }),
    ).rejects.toThrow(/principalId must be a uuid/);
    expect(db.issued).toHaveLength(0);
  });

  it("secret-scrub pin: poisoned rows and model-carrying policy never surface", async () => {
    const db = fakeDb(syncScripts(new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR), true));
    const brief = await collectSelfBrief(db, {
      principalId: PRINCIPAL,
      principalName: "josctl",
      now,
      policy: POLICY,
    });
    const serialized = JSON.stringify(brief);
    const text = renderSelfBrief(brief);
    for (const secret of ["SECRETCRED", "SECRETHASH123", "openai/", "anthropic/", "gpt-4o-mini", "claude-sonnet", "josctl", "yusra"]) {
      expect(serialized, secret).not.toContain(secret);
      expect(text, secret).not.toContain(secret);
    }
  });

  it("deterministic: identical inputs render byte-identical briefs", async () => {
    const a = await collectSelfBrief(fakeDb(syncScripts(new Date(NOW.getTime() - HOUR), null)), {
      principalId: PRINCIPAL,
      principalName: "josctl",
      now,
      policy: POLICY,
    });
    const b = await collectSelfBrief(fakeDb(syncScripts(new Date(NOW.getTime() - HOUR), null)), {
      principalId: PRINCIPAL,
      principalName: "josctl",
      now,
      policy: POLICY,
    });
    expect(renderSelfBrief(a)).toBe(renderSelfBrief(b));
  });
});

describe("renderSelfBrief (goldens)", () => {
  it("full golden: connected world, policy known, active profile", async () => {
    const db = fakeDb(syncScripts(new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR)));
    const brief = await collectSelfBrief(db, {
      principalId: PRINCIPAL,
      principalName: "josctl",
      now,
      policy: POLICY,
      activeProfileVersion: 1,
    });
    expect(renderSelfBrief(brief)).toBe(
      [
        "SELF-BRIEF (runtime state — answer capability questions from THIS, not memory)",
        "sources: calendar read; gmail metadata_only (sender patterns only — never subjects or bodies)",
        "memory: explicit capture on; recall on; promotion never automatic (explicit review only)",
        "conversation: bounded iMessage threads; working context 72h; raw messages kept 7d",
        "persona: on (active profile v1); self-modify on via propose+confirm; other principals: owner approval only",
        "actions: calendar write on (always confirm-gated); commitment capture on — when the user asks to be reminded or to track something, that works (propose, then they confirm)",
        `limits: ${SYSTEM_STATE_LIMITATIONS.join("; ")}`,
        "as of 2026-09-21T12:00:00.000Z — unknown means not determined; never guess",
        "",
      ].join("\n"),
    );
  });

  it("unknown-policy golden: honest unknowns, policy-independent facts intact", async () => {
    const db = fakeDb(syncScripts(new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR)));
    const brief = await collectSelfBrief(db, { principalId: PRINCIPAL, now, policy: null });
    expect(renderSelfBrief(brief)).toBe(
      [
        "SELF-BRIEF (runtime state — answer capability questions from THIS, not memory)",
        "sources: calendar unknown; gmail unknown",
        "memory: explicit capture unknown; recall unknown; promotion never automatic (explicit review only)",
        "conversation: bounded iMessage threads; working context 72h; raw messages kept 7d",
        "persona: unknown (no active profile); self-modify unknown via propose+confirm; other principals: owner approval only",
        "actions: calendar write unknown (always confirm-gated); commitment capture unknown — when the user asks to be reminded or to track something, that works (propose, then they confirm)",
        `limits: ${SYSTEM_STATE_LIMITATIONS.join("; ")}`,
        "as of 2026-09-21T12:00:00.000Z — unknown means not determined; never guess",
        "",
      ].join("\n"),
    );
  });

  it("disconnected-sensors golden", async () => {
    const db = fakeDb(syncScripts(null, null));
    const brief = await collectSelfBrief(db, {
      principalId: PRINCIPAL,
      principalName: "josctl",
      now,
      policy: POLICY,
    });
    expect(renderSelfBrief(brief)).toBe(
      [
        "SELF-BRIEF (runtime state — answer capability questions from THIS, not memory)",
        "sources: calendar disconnected; gmail disconnected",
        "memory: explicit capture on; recall on; promotion never automatic (explicit review only)",
        "conversation: bounded iMessage threads; working context 72h; raw messages kept 7d",
        "persona: on (no active profile); self-modify on via propose+confirm; other principals: owner approval only",
        "actions: calendar write on (always confirm-gated); commitment capture on — when the user asks to be reminded or to track something, that works (propose, then they confirm)",
        `limits: ${SYSTEM_STATE_LIMITATIONS.join("; ")}`,
        "as of 2026-09-21T12:00:00.000Z — unknown means not determined; never guess",
        "",
      ].join("\n"),
    );
  });

  it("compactness pin: every render stays within SELF_BRIEF_MAX_LINES", async () => {
    const worlds: CollectInput[] = [
      { cal: new Date(NOW.getTime() - HOUR), gmail: new Date(NOW.getTime() - HOUR), policy: POLICY, name: "josctl", v: 1 },
      { cal: new Date(NOW.getTime() - HOUR), gmail: new Date(NOW.getTime() - HOUR), policy: null, name: undefined, v: null },
      { cal: null, gmail: null, policy: POLICY, name: "yusra", v: null },
    ];
    for (const world of worlds) {
      const db = fakeDb(syncScripts(world.cal, world.gmail));
      const brief = await collectSelfBrief(db, {
        principalId: PRINCIPAL,
        principalName: world.name,
        now,
        policy: world.policy,
        activeProfileVersion: world.v,
      });
      const lineCount = renderSelfBrief(brief).trimEnd().split("\n").length;
      expect(lineCount, JSON.stringify(world)).toBeLessThanOrEqual(SELF_BRIEF_MAX_LINES);
    }
  });
});

describe("self-brief constants", () => {
  it("limitations reuse W7's versioned list verbatim (no parallel prose)", () => {
    expect(SELF_BRIEF_LIMITATIONS_VERSION).toBe(1);
  });

  it("honesty rules: brief-only answers, metadata-first, no guessing, no stale self-model", () => {
    expect(SELF_BRIEF_HONESTY_RULES).toHaveLength(4);
    const joined = SELF_BRIEF_HONESTY_RULES.join(" | ");
    expect(joined).toMatch(/ONLY from the SELF-BRIEF/);
    expect(joined).toMatch(/metadata_only/);
    expect(joined).toMatch(/never guess/);
    expect(joined).toMatch(/older version/);
    for (const rule of SELF_BRIEF_HONESTY_RULES) {
      expect(rule).not.toMatch(/[\r\n]/);
      expect(rule.length).toBeLessThanOrEqual(300);
    }
  });
});
