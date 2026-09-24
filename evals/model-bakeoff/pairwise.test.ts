// §5/§16 pairwise preference harness — hermetic tests (fake provider,
// zero network). Pins: the blind deterministic shuffle, sheet blindness
// (no model names in the artifact), the ≥60%-of-≥20-pairs protocol math,
// and the full hermetic render over the answer-quality fixtures.

import { describe, expect, it } from "vitest";
import { fixturesPath, loadAnswerFixtures } from "../answer-quality/runner.js";
import {
  MIN_PAIRS,
  type PairVerdict,
  type PairwisePair,
  opaqueTag,
  pairwiseTally,
  renderPairwiseSheet,
  runPairwise,
  shuffleAssignments,
} from "./pairwise.js";
import { prng, seedOf } from "./shared.js";

const fixtures = loadAnswerFixtures(fixturesPath());

describe("blind shuffle", () => {
  it("is deterministic per (a, b, scenarioId, seed) and covers both slots", () => {
    const ids = fixtures.scenarios.map((s) => s.id);
    const first = shuffleAssignments(ids, "m/a", "m/b", 7);
    const again = shuffleAssignments(ids, "m/a", "m/b", 7);
    expect([...again.entries()]).toEqual([...first.entries()]);
    const slots = new Set([...first.values()].map((x) => x.A));
    expect(setsEqual(slots, new Set(["m/a", "m/b"]))).toBe(true);
    // Different seed → at least one flip across 24 scenarios (p ≈ 1 - 2^-23).
    const other = shuffleAssignments(ids, "m/a", "m/b", 8);
    expect(ids.some((id) => other.get(id)!.A !== first.get(id)!.A)).toBe(true);
  });

  it("swap of a/b mirrors every assignment", () => {
    const ids = fixtures.scenarios.map((s) => s.id);
    const first = shuffleAssignments(ids, "m/a", "m/b", 5);
    const swapped = shuffleAssignments(ids, "m/b", "m/a", 5);
    for (const id of ids) {
      expect(swapped.get(id)!.A).toBe(first.get(id)!.B);
    }
  });
});

describe("protocol math (D-1 / §16 USER PREFERENCE)", () => {
  it("≥60% of ≥20 pairs wins; ties are non-wins; sub-20 samples never win", () => {
    // 13A / 7B over 20 → 65% ≥ 60% → A wins.
    const won = pairwiseTally([...Array(13).fill("A"), ...Array(7).fill("B")] as PairVerdict[]);
    expect(won.meetsPairMinimum).toBe(true);
    expect(won.winner).toBe("A");
    expect(won.aWinRate).toBeCloseTo(0.65, 10);
    // 12A / 8B over 20 → 60% exactly → still a win (≥ bar).
    expect(pairwiseTally([...Array(12).fill("A"), ...Array(8).fill("B")] as PairVerdict[]).winner).toBe("A");
    // 12A / 5B / 3 ties over 20 → 60% of SCORED pairs → win (ties non-wins).
    const ties = pairwiseTally([...Array(12).fill("A"), ...Array(5).fill("B"), ...Array(3).fill("tie")] as PairVerdict[]);
    expect(ties.winner).toBe("A");
    expect(ties.aWinRateDecisive).toBeCloseTo(12 / 17, 10);
    // 19 pairs at 100% → below the ≥20 minimum → no winner (unscored disjunct).
    const short = pairwiseTally(Array(19).fill("A") as PairVerdict[]);
    expect(short.meetsPairMinimum).toBe(false);
    expect(short.winner).toBeNull();
    // 11A / 9B over 20 → 55% → no winner.
    expect(pairwiseTally([...Array(11).fill("A"), ...Array(9).fill("B")] as PairVerdict[]).winner).toBeNull();
    // Both at 60% is impossible with ties non-wins, but 12/12 over 24 → no winner.
    expect(pairwiseTally([...Array(12).fill("A"), ...Array(12).fill("B")] as PairVerdict[]).winner).toBeNull();
  });

  it("the fixtures support the ≥20-pair minimum on the default filter", () => {
    expect(fixtures.scenarios.length).toBeGreaterThanOrEqual(MIN_PAIRS);
    expect(fixtures.scenarios.filter((s) => s.group === "multiturn").length).toBeLessThan(MIN_PAIRS);
  });
});

describe("sheet rendering (blindness)", () => {
  const pair: PairwisePair = {
    scenarioId: "M01",
    group: "multiturn",
    question: "What about the second one?",
    priorTurns: [{ direction: "inbound", content: "I'm picking between two windows for the venue visit." }],
    results: [{ tool: "calendar.day", coverage: "calendar events only", data: { day: "tomorrow" } }],
    replyA: `hermetic reply [tag ${opaqueTag("openai/gpt-4.1")}]`,
    replyB: `hermetic reply [tag ${opaqueTag("anthropic/claude-sonnet-4.5")}]`,
  };

  it("renders the protocol header, the pair, and NEVER a model name", () => {
    const sheet = renderPairwiseSheet({ generatedAt: "2026-09-24T00:00:00Z", filter: "all", pairs: [pair] });
    expect(sheet).toContain("Pair 1 — M01 (multiturn)");
    expect(sheet).toContain("What about the second one?");
    expect(sheet).toContain("[tool: calendar.day]");
    expect(sheet).toContain("verdict: [ ] A better  [ ] B better  [ ] tie");
    for (const forbidden of ["openai/", "anthropic/", "google/", "gpt-4.1", "sonnet", "gemini"]) {
      expect(sheet).not.toContain(forbidden);
    }
  });

  it("render errors are honest placeholders, never silent", () => {
    const sheet = renderPairwiseSheet({
      generatedAt: "2026-09-24T00:00:00Z",
      filter: "all",
      pairs: [{ ...pair, replyA: "", errorA: "candidate: HTTP 429" }],
    });
    expect(sheet).toContain("render error: candidate: HTTP 429");
  });
});

describe("PRNG helpers", () => {
  it("prng is deterministic; opaqueTag never contains a model-family token", () => {
    expect(prng(seedOf("x"))()).toBe(prng(seedOf("x"))());
    for (const model of ["openai/gpt-4.1", "anthropic/claude-sonnet-4.5", "google/gemini-3.8-flash"]) {
      const tag = opaqueTag(model);
      expect(tag).toMatch(/^[0-9a-z]{6}$/);
      expect(model.includes(tag)).toBe(false);
    }
  });
});

describe("hermetic CLI run (fake provider, no network)", () => {
  it("emits a blind sheet + key over all 24 fixtures and exits 0", async () => {
    const code = await runPairwise(["--a", "openai/gpt-4o-mini", "--b", "anthropic/claude-sonnet-4.5"]);
    expect(code).toBe(0);
  });
});

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}
