import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { REDACTED_TOKEN } from "./redact";
import {
  THREAD_REFERENT_REGISTRY_CAP,
  TURN_REFERENTS_MAX,
  deriveThreadState,
  isPendingExpired,
  mergeThreadState,
  parseThreadMetadata,
  pendingWithDerivedIds,
  retractLastStance,
  type ThreadMetadata,
  type ThreadPendingProposal,
  type ThreadReferent,
} from "./threads";

const AT = "2026-09-21T12:00:00.000Z";

function referent(over: Partial<ThreadReferent> = {}): ThreadReferent {
  return { kind: "read", ref: "calendar.day", label: "today's calendar", at: AT, ...over };
}

describe("deriveThreadState (deterministic derivation from turn artifacts)", () => {
  it("derives topic, referents stamped with the turn instant, and lastStance", () => {
    const derived = deriveThreadState({
      at: AT,
      topic: "venue planning",
      referents: [{ kind: "action", ref: "7K4", label: "Henna sync proposal" }],
      stance: { kind: "proposal", summary: "proposed Henna sync tomorrow 2pm" },
    });
    expect(derived).toEqual({
      topic: "venue planning",
      referents: [{ kind: "action", ref: "7K4", label: "Henna sync proposal", at: AT }],
      lastStance: { kind: "proposal", summary: "proposed Henna sync tomorrow 2pm", at: AT },
    });
  });

  it("empty artifacts derive an empty delta", () => {
    expect(deriveThreadState({ at: AT })).toEqual({});
    expect(deriveThreadState({ at: AT, topic: "  ", referents: [], stance: null })).toEqual({});
  });

  it("normalizes the timestamp; unparseable instants throw (fail closed)", () => {
    expect(deriveThreadState({ at: new Date(AT) }).topic).toBeUndefined();
    expect(deriveThreadState({ at: "2026-09-21T12:00:00Z", topic: "t" }).topic).toBe("t");
    expect(() => deriveThreadState({ at: "not-a-date", topic: "t" })).toThrow(/TurnArtifacts\.at/);
  });

  it("flattens newlines and redacts secrets in stored labels, topics, and stance summaries", () => {
    const derived = deriveThreadState({
      at: AT,
      topic: "billing\ntopic",
      referents: [{ kind: "read", ref: "r", label: "card 4242 4242 4242 4242\nsecond line" }],
      stance: { kind: "s", summary: "sk-ant-abcdefghijklmnopqrstuvwxyz012345" },
    });
    expect(derived.topic).toBe("billing\\ntopic");
    expect(derived.referents![0]!.label).toContain(REDACTED_TOKEN);
    expect(derived.referents![0]!.label).not.toContain("4242");
    expect(derived.referents![0]!.label).toContain("\\nsecond line");
    expect(derived.lastStance!.summary).toContain(REDACTED_TOKEN);
  });

  it("bounds label and topic lengths", () => {
    const derived = deriveThreadState({
      at: AT,
      topic: "t".repeat(500),
      referents: [{ kind: "review", ref: "r".repeat(100), label: "l".repeat(500) }],
    });
    expect(derived.topic!.length).toBeLessThanOrEqual(160);
    expect(derived.referents![0]!.ref.length).toBe(64);
    expect(derived.referents![0]!.label.length).toBeLessThanOrEqual(200);
  });

  it("drops invalid referents and dedupes within the turn by (kind, ref)", () => {
    const derived = deriveThreadState({
      at: AT,
      referents: [
        { kind: "read", ref: "a", label: "first" },
        { kind: "read", ref: "a", label: "second" },
        { kind: "read", ref: "b", label: "" },
        { kind: "review", ref: "", label: "x" },
        { kind: "read", ref: "c", label: "kept" },
      ],
    });
    expect(derived.referents).toEqual([
      { kind: "read", ref: "a", label: "first", at: AT },
      { kind: "read", ref: "c", label: "kept", at: AT },
    ]);
  });

  it(`caps per-turn referents at ${TURN_REFERENTS_MAX}`, () => {
    const derived = deriveThreadState({
      at: AT,
      referents: Array.from({ length: 12 }, (_, i) => ({
        kind: "read" as const,
        ref: `r${i}`,
        label: `l${i}`,
      })),
    });
    expect(derived.referents).toHaveLength(TURN_REFERENTS_MAX);
    expect(derived.referents![0]!.ref).toBe("r0");
    expect(derived.referents!.at(-1)!.ref).toBe("r7");
  });

  it("is deterministic (pure)", () => {
    const artifacts = {
      at: AT,
      topic: "t",
      referents: [{ kind: "read" as const, ref: "r", label: "l" }],
      stance: { kind: "s", summary: "m" },
    };
    expect(deriveThreadState(artifacts)).toEqual(deriveThreadState(artifacts));
  });
});

describe("mergeThreadState", () => {
  it("replaces topic and stance only when the turn carries them", () => {
    const existing: ThreadMetadata = {
      topic: "old",
      lastStance: { kind: "old", summary: "old", at: AT },
    };
    expect(mergeThreadState(existing, { topic: "new" })).toEqual({
      topic: "new",
      lastStance: existing.lastStance,
    });
    expect(mergeThreadState(existing, {})).toEqual(existing);
    expect(mergeThreadState(null, {})).toEqual({});
  });

  it("appends referents; a re-referenced (kind, ref) updates in place, newest value wins", () => {
    const existing: ThreadMetadata = {
      referents: [
        { kind: "action", ref: "7K4", label: "v1", at: "2026-09-20T00:00:00.000Z" },
        { kind: "read", ref: "calendar.day", label: "today", at: "2026-09-20T00:00:00.000Z" },
      ],
    };
    const merged = mergeThreadState(existing, {
      referents: [
        { kind: "action", ref: "7K4", label: "v2", at: AT },
        { kind: "review", ref: "A1B", label: "approve candidate", at: AT },
      ],
    });
    expect(merged.referents).toEqual([
      { kind: "action", ref: "7K4", label: "v2", at: AT },
      { kind: "read", ref: "calendar.day", label: "today", at: "2026-09-20T00:00:00.000Z" },
      { kind: "review", ref: "A1B", label: "approve candidate", at: AT },
    ]);
  });

  it(`bounds the registry at ${THREAD_REFERENT_REGISTRY_CAP} keeping the newest`, () => {
    const old: ThreadMetadata = {
      referents: Array.from({ length: THREAD_REFERENT_REGISTRY_CAP }, (_, i) =>
        referent({ ref: `old-${i}`, at: "2026-09-01T00:00:00.000Z" }),
      ),
    };
    const merged = mergeThreadState(old, {
      referents: [referent({ ref: "new-1" }), referent({ ref: "new-2" })],
    });
    expect(merged.referents).toHaveLength(THREAD_REFERENT_REGISTRY_CAP);
    expect(merged.referents![0]!.ref).toBe("old-2");
    expect(merged.referents!.at(-2)!.ref).toBe("new-1");
    expect(merged.referents!.at(-1)!.ref).toBe("new-2");
  });

  it("skips malformed referents defensively", () => {
    const merged = mergeThreadState(
      { referents: [{ kind: "bogus" as "read", ref: "x", label: "y", at: AT }] },
      { referents: [{ kind: "read", ref: "ok", label: "fine", at: AT }] },
    );
    expect(merged.referents).toEqual([{ kind: "read", ref: "ok", label: "fine", at: AT }]);
  });
});

describe("retractLastStance (thread-local changed-my-mind)", () => {
  it("removes only lastStance; topic and referents survive", () => {
    const metadata: ThreadMetadata = {
      topic: "venue",
      referents: [referent()],
      lastStance: { kind: "proposal", summary: "proposed 7pm", at: AT },
    };
    expect(retractLastStance(metadata)).toEqual({ topic: "venue", referents: [referent()] });
  });

  it("is a no-op without a stance and tolerates null", () => {
    expect(retractLastStance({ topic: "t" })).toEqual({ topic: "t" });
    expect(retractLastStance(null)).toEqual({});
  });

  it("never mutates the input (pure)", () => {
    const metadata: ThreadMetadata = {
      lastStance: { kind: "k", summary: "s", at: AT },
    };
    retractLastStance(metadata);
    expect(metadata.lastStance).toEqual({ kind: "k", summary: "s", at: AT });
  });
});

describe("parseThreadMetadata (fail-closed DB reader)", () => {
  it("round-trips a derived metadata value", () => {
    const derived = deriveThreadState({
      at: AT,
      topic: "t",
      referents: [{ kind: "action", ref: "7K4", label: "l" }],
      stance: { kind: "s", summary: "m" },
    });
    expect(parseThreadMetadata(JSON.parse(JSON.stringify(derived)))).toEqual(derived);
  });

  it("accepts empty and null values", () => {
    expect(parseThreadMetadata(null)).toBeNull();
    expect(parseThreadMetadata(undefined)).toBeNull();
    expect(parseThreadMetadata({})).toEqual({});
  });

  it("fails closed on any structural deviation", () => {
    const cases: unknown[] = [
      "string",
      42,
      [],
      { extra: 1 },
      { topic: "" },
      { topic: 7 },
      { referents: {} },
      { referents: [{ kind: "nope", ref: "r", label: "l", at: AT }] },
      { referents: [{ kind: "read", ref: "", label: "l", at: AT }] },
      { referents: [{ kind: "read", ref: "r", label: "l", at: "garbage" }] },
      { referents: [{ kind: "read", ref: "r", label: "l" }] },
      { lastStance: null },
      { lastStance: { kind: "", summary: "s", at: AT } },
      { lastStance: { kind: "k", summary: "s", at: "nope" } },
      { lastStance: { kind: "k" } },
      { profileOverride: { brevityDelta: { maxSentences: -2 } } },
      { "profile-override": {} },
    ];
    for (const value of cases) {
      expect(parseThreadMetadata(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("admits the W4 profile_override key (strict shape) and rejects malformed ones", () => {
    const valid = {
      topic: "t",
      profile_override: {
        brevityDelta: { maxSentences: -2, maxChars: -300 },
        extraDirective: "Answer the principal as \"Chief\" for this thread only.",
      },
    };
    expect(parseThreadMetadata(JSON.parse(JSON.stringify(valid)))).toEqual(valid);

    const malformed: unknown[] = [
      { profile_override: "brief" },
      { profile_override: {} },
      { profile_override: null },
      { profile_override: [] },
      { profile_override: { brevityDelta: {} } },
      { profile_override: { brevityDelta: { maxSentences: 1.5, maxChars: -300 } } },
      { profile_override: { brevityDelta: { maxSentences: "-2" } } },
      { profile_override: { brevityDelta: { tone: -2 } } },
      { profile_override: { extraDirective: "" } },
      { profile_override: { extraDirective: 7 } },
      { profile_override: { extraDirective: "two\nlines" } },
      { profile_override: { extraDirective: "x".repeat(121) } },
      { profile_override: { brevityDelta: { maxChars: -300 }, extra: true } },
    ];
    for (const value of malformed) {
      expect(parseThreadMetadata(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("thread-state merges preserve a profile_override untouched (W4 expiry-with-thread semantics)", () => {
    const existing = {
      topic: "t",
      profile_override: { brevityDelta: { maxSentences: -2 } },
    };
    const turn = deriveThreadState({
      at: AT,
      topic: "new topic",
      stance: { kind: "answer", summary: "s" },
    });
    const merged = mergeThreadState(existing, turn);
    expect(merged.topic).toBe("new topic");
    expect(merged.profile_override).toEqual({ brevityDelta: { maxSentences: -2 } });
    const retracted = retractLastStance(merged);
    expect(retracted.profile_override).toEqual({ brevityDelta: { maxSentences: -2 } });
  });

  it("admits the W6(a) pendingProposal key (strict shape) and rejects malformed ones", () => {
    const valid = {
      topic: "t",
      pendingProposal: {
        type: "task_batch",
        at: AT,
        payload: { type: "task_batch", items: [{ title: "Clean apartment", due: "by wednesday" }] },
        offered: "I pulled out 1 tasks: Clean apartment. Reply 'track them' and I'll track all 1.",
      },
    };
    expect(parseThreadMetadata(JSON.parse(JSON.stringify(valid)))).toEqual(valid);

    const malformed: unknown[] = [
      { pendingProposal: "yes" },
      { pendingProposal: {} },
      { pendingProposal: null },
      { pendingProposal: [] },
      { pendingProposal: { type: "calendar.create", at: AT, payload: {}, offered: "x" } },
      { pendingProposal: { type: "task_batch", payload: {}, offered: "x" } },
      { pendingProposal: { type: "task_batch", at: "garbage", payload: {}, offered: "x" } },
      { pendingProposal: { type: "task_batch", at: AT, offered: "x" } },
      { pendingProposal: { type: "task_batch", at: AT, payload: "x".repeat(1001), offered: "x" } },
      { pendingProposal: { type: "task_batch", at: AT, payload: {}, offered: "" } },
      { pendingProposal: { type: "task_batch", at: AT, payload: {}, offered: "x".repeat(401) } },
      { pendingProposal: { type: "task_batch", at: AT, payload: {}, offered: "two\nlines" } },
      { pendingProposal: { type: "task_batch", at: AT, payload: {}, offered: "x", extra: 1 } },
    ];
    for (const value of malformed) {
      expect(parseThreadMetadata(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("thread-state merges and retractions preserve a pendingProposal untouched (W6(a) mirror of the override law)", () => {
    const existing = {
      topic: "t",
      pendingProposal: {
        type: "system_feedback",
        at: AT,
        payload: { type: "system_feedback", category: "bug", subject: "s", detail: null },
        offered: "Worth logging about me: \"s\" (bug).",
      },
    };
    const turn = deriveThreadState({
      at: AT,
      topic: "new topic",
      stance: { kind: "answer", summary: "s" },
    });
    const merged = mergeThreadState(existing, turn);
    expect(merged.pendingProposal).toEqual(existing.pendingProposal);
    const retracted = retractLastStance(merged);
    expect(retracted.pendingProposal).toEqual(existing.pendingProposal);
    // Both thread-scoped records coexist and survive together.
    const both = mergeThreadState(
      { ...existing, profile_override: { brevityDelta: { maxSentences: -2 } } },
      turn,
    );
    expect(both.profile_override).toEqual({ brevityDelta: { maxSentences: -2 } });
    expect(both.pendingProposal).toEqual(existing.pendingProposal);
  });
});

const LEGACY_PENDING: ThreadPendingProposal = {
  type: "task_batch",
  at: AT,
  payload: { type: "task_batch", items: [{ title: "Clean apartment", due: "by wednesday" }] },
  offered: "I pulled out 1 tasks: Clean apartment. Reply 'track them' and I'll track all 1.",
};

const STAMPED_PENDING: ThreadPendingProposal = {
  ...LEGACY_PENDING,
  id: "task_batch:1a2b",
  expiresAt: "2026-09-22T12:00:00.000Z",
  parkedAtSeq: 7,
};

describe("parseThreadMetadata §22.14 dual-shape pending entries", () => {
  it("parses legacy 4-key entries unchanged and carries id/expiresAt/parkedAtSeq through", () => {
    expect(parseThreadMetadata(JSON.parse(JSON.stringify({ pendingProposals: [LEGACY_PENDING] })))).toEqual({
      pendingProposals: [LEGACY_PENDING],
    });
    expect(parseThreadMetadata(JSON.parse(JSON.stringify({ pendingProposals: [STAMPED_PENDING] })))).toEqual({
      pendingProposals: [STAMPED_PENDING],
    });
    expect(parseThreadMetadata(JSON.parse(JSON.stringify({ pendingProposal: STAMPED_PENDING })))).toEqual({
      pendingProposal: STAMPED_PENDING,
    });
  });

  it("merges and retractions carry the new fields through untouched (hazard 2: carry, not tolerate)", () => {
    const existing: ThreadMetadata = { topic: "t", pendingProposals: [STAMPED_PENDING] };
    const turn = deriveThreadState({ at: AT, topic: "new", stance: { kind: "answer", summary: "s" } });
    const merged = mergeThreadState(existing, turn);
    expect(merged.pendingProposals).toEqual([STAMPED_PENDING]);
    expect(retractLastStance(merged).pendingProposals).toEqual([STAMPED_PENDING]);
  });

  it("fails closed on malformed id/expiresAt/parkedAtSeq", () => {
    const base = { type: "task_batch", at: AT, payload: {}, offered: "x" };
    const malformed: unknown[] = [
      { pendingProposal: { ...base, id: "task_batch:1A2B" } },
      { pendingProposal: { ...base, id: "task_batch:1a2" } },
      { pendingProposal: { ...base, id: "task_batch:1a2b3" } },
      { pendingProposal: { ...base, id: "system_feedback:1a2b" } },
      { pendingProposal: { ...base, id: "task_batch" } },
      { pendingProposal: { ...base, id: 7 } },
      { pendingProposal: { ...base, expiresAt: "garbage" } },
      { pendingProposal: { ...base, expiresAt: 42 } },
      { pendingProposal: { ...base, parkedAtSeq: 1.5 } },
      { pendingProposal: { ...base, parkedAtSeq: "3" } },
      { pendingProposal: { ...base, parkedAtSeq: -1 } },
      { pendingProposal: { ...base, extraNew: 1 } },
    ];
    for (const value of malformed) {
      expect(parseThreadMetadata(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("pendingWithDerivedIds (§22.14 legacy provenance)", () => {
  it("derives the documented hash id for legacy-parked entries; expiresAt/parkedAtSeq stay absent", () => {
    const digest = createHash("sha256").update("task_batch" + AT).digest("hex").slice(0, 4);
    const expected: ThreadPendingProposal = { ...LEGACY_PENDING, id: `task_batch:${digest}` };
    const derived = pendingWithDerivedIds({
      pendingProposal: LEGACY_PENDING,
      pendingProposals: [LEGACY_PENDING],
    });
    expect(derived).toEqual({ pendingProposal: expected, pendingProposals: [expected] });
    expect(derived!.pendingProposals![0]!.expiresAt).toBeUndefined();
    expect(derived!.pendingProposals![0]!.parkedAtSeq).toBeUndefined();
  });

  it("passes id-bearing entries through untouched (same reference)", () => {
    const metadata: ThreadMetadata = { pendingProposals: [STAMPED_PENDING], pendingProposal: STAMPED_PENDING };
    expect(pendingWithDerivedIds(metadata)).toBe(metadata);
    expect(pendingWithDerivedIds({ topic: "t" })).toEqual({ topic: "t" });
    expect(pendingWithDerivedIds(null)).toBeNull();
  });

  it("derives only for the legacy entries in a mixed set", () => {
    const digest = createHash("sha256").update("system_feedback" + AT).digest("hex").slice(0, 4);
    const legacy: ThreadPendingProposal = {
      type: "system_feedback",
      at: AT,
      payload: { type: "system_feedback", category: "bug", subject: "s", detail: null },
      offered: "Worth logging about me: \"s\" (bug).",
    };
    const derived = pendingWithDerivedIds({ pendingProposals: [STAMPED_PENDING, legacy] });
    expect(derived).toEqual({
      pendingProposals: [STAMPED_PENDING, { ...legacy, id: `system_feedback:${digest}` }],
    });
  });
});

describe("isPendingExpired (§22.6 24h TTL)", () => {
  it("detects expired entries; unexpired and unknown-but-unexpired pass", () => {
    const expiresAt = "2026-09-22T12:00:00.000Z";
    const stamped: ThreadPendingProposal = { ...STAMPED_PENDING, expiresAt };
    expect(isPendingExpired(stamped, new Date("2026-09-22T12:00:00.000Z"))).toBe(true);
    expect(isPendingExpired(stamped, new Date("2026-09-23T00:00:00.000Z"))).toBe(true);
    expect(isPendingExpired(stamped, new Date("2026-09-22T11:59:59.999Z"))).toBe(false);
    expect(isPendingExpired(stamped, new Date("2026-09-21T00:00:00.000Z"))).toBe(false);
    expect(isPendingExpired(LEGACY_PENDING, new Date("2027-01-01T00:00:00.000Z"))).toBe(false);
  });
});
