import { describe, expect, it } from "vitest";
import { REDACTED_TOKEN } from "./redact";
import {
  THREAD_REFERENT_REGISTRY_CAP,
  TURN_REFERENTS_MAX,
  deriveThreadState,
  mergeThreadState,
  parseThreadMetadata,
  retractLastStance,
  type ThreadMetadata,
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
    ];
    for (const value of cases) {
      expect(parseThreadMetadata(value), JSON.stringify(value)).toBeNull();
    }
  });
});
