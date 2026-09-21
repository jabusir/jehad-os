import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_TERMS,
  MAX_RECALL_LIMIT,
  MEMORY_RECALL_COVERAGE,
  recallMemory,
  rankRecallResults,
  renderMemoryRecallBlock,
  splitQueryTerms,
  CAP_RECALL_LINE_CHARS,
  type DecisionRecallItem,
  type MemoryRecallResult,
} from "./memory-recall.js";

const THROWING_DB = {
  query(): Promise<{ rows: Record<string, unknown>[] }> {
    return Promise.reject(new Error("recallMemory must not query the database here"));
  },
};

function decisionItem(overrides: Partial<DecisionRecallItem> = {}): DecisionRecallItem {
  return {
    kind: "decision",
    ref: "00000000-0000-4000-8000-00000000000a",
    summary: "Confirm venue by Friday",
    decidedAt: "2026-09-12T20:00:00.000Z",
    assertionKind: "user_declared",
    sourceAttribution: null,
    score: 2,
    ...overrides,
  };
}

describe("splitQueryTerms", () => {
  it("lowercases, splits on non-alphanumerics, and preserves first-seen order", () => {
    expect(splitQueryTerms("What about the Venue, really?")).toEqual([
      "what",
      "about",
      "the",
      "venue",
      "really",
    ]);
  });

  it("dedupes case-insensitively", () => {
    expect(splitQueryTerms("Venue venue VENUE")).toEqual(["venue"]);
  });

  it("drops single-character terms", () => {
    expect(splitQueryTerms("a I am venue")).toEqual(["am", "venue"]);
  });

  it("returns [] for empty or punctuation-only text", () => {
    expect(splitQueryTerms("")).toEqual([]);
    expect(splitQueryTerms("   ")).toEqual([]);
    expect(splitQueryTerms("?! - —")).toEqual([]);
  });

  it("caps the term count at MAX_QUERY_TERMS", () => {
    const terms = splitQueryTerms("one two three four five six seven eight nine ten");
    expect(terms).toHaveLength(MAX_QUERY_TERMS);
    expect(terms).toEqual(["one", "two", "three", "four", "five", "six", "seven", "eight"]);
  });

  it("yields alphanumeric-only terms, so ILIKE wildcards cannot smuggle through", () => {
    expect(splitQueryTerms("100% venue_cost")).toEqual(["100", "venue", "cost"]);
  });
});

describe("rankRecallResults", () => {
  const newer = decisionItem({
    ref: "00000000-0000-4000-8000-00000000000b",
    summary: "newer same score",
    decidedAt: "2026-09-18T00:00:00.000Z",
  });
  const older = decisionItem({
    ref: "00000000-0000-4000-8000-00000000000c",
    summary: "older same score",
    decidedAt: "2026-09-01T00:00:00.000Z",
  });
  const lowScore = decisionItem({
    ref: "00000000-0000-4000-8000-00000000000d",
    summary: "weak match",
    decidedAt: "2026-09-20T00:00:00.000Z",
    score: 1,
  });
  const tieBreakA = decisionItem({
    ref: "00000000-0000-4000-8000-00000000000a",
    decidedAt: "2026-09-12T20:00:00.000Z",
  });

  it("orders by matched-term score descending, then recency, then ref", () => {
    const ranked = rankRecallResults([lowScore, older, newer, tieBreakA]);
    expect(ranked.map((item) => item.summary)).toEqual([
      "newer same score",
      "Confirm venue by Friday",
      "older same score",
      "weak match",
    ]);
  });

  it("breaks full ties deterministically by ref ascending", () => {
    const a = tieBreakA;
    const b = { ...tieBreakA, ref: "00000000-0000-4000-8000-00000000000b" };
    expect(rankRecallResults([b, a]).map((item) => item.ref)).toEqual([a.ref, b.ref]);
  });

  it("slices to the limit (default cap 5)", () => {
    const many: MemoryRecallResult[] = [];
    for (let i = 0; i < 8; i += 1) {
      many.push(
        decisionItem({
          ref: `00000000-0000-4000-8000-0000000000${i.toString().padStart(2, "0")}`,
          decidedAt: `2026-09-0${i + 1}T00:00:00.000Z`,
        }),
      );
    }
    expect(rankRecallResults(many)).toHaveLength(MAX_RECALL_LIMIT);
    expect(rankRecallResults(many, 2)).toHaveLength(2);
  });
});

describe("renderMemoryRecallBlock", () => {
  it("renders the canonical attributed line (source + date + assertion kind)", () => {
    const lines = renderMemoryRecallBlock([decisionItem()]);
    expect(lines).toEqual([
      "[decision d-2026-09-12 | per your decision on Sep 12 | user_declared] Confirm venue by Friday",
    ]);
  });

  it("flattens newlines to literal \\n and caps every line at 200 chars", () => {
    const multiline = decisionItem({ summary: "line one\nline two\r\nline three" });
    expect(renderMemoryRecallBlock([multiline])).toEqual([
      "[decision d-2026-09-12 | per your decision on Sep 12 | user_declared] line one\\nline two\\nline three",
    ]);

    const long = decisionItem({ summary: "x".repeat(400) });
    const [line] = renderMemoryRecallBlock([long]);
    expect(line!.length).toBe(CAP_RECALL_LINE_CHARS);
    expect(line!.endsWith("…")).toBe(true);
  });

  it("omits empty label segments and joins assertion kind with source attribution", () => {
    const bare = decisionItem({ assertionKind: null, sourceAttribution: null });
    expect(renderMemoryRecallBlock([bare])).toEqual([
      "[decision d-2026-09-12 | per your decision on Sep 12] Confirm venue by Friday",
    ]);

    const both = decisionItem({ sourceAttribution: "cli.capture" });
    expect(renderMemoryRecallBlock([both])).toEqual([
      "[decision d-2026-09-12 | per your decision on Sep 12 | user_declared, cli.capture] Confirm venue by Friday",
    ]);
  });

  it("disambiguates same-kind same-day short refs deterministically", () => {
    const pair = [decisionItem(), decisionItem({ ref: "00000000-0000-4000-8000-00000000000b" })];
    const lines = renderMemoryRecallBlock(pair);
    expect(lines[0]).toContain("d-2026-09-12 ");
    expect(lines[1]).toContain("d-2026-09-12#2 ");
  });

  it("labels non-open commitment statuses and renders per-kind phrases", () => {
    const met = {
      kind: "commitment" as const,
      ref: "00000000-0000-4000-8000-00000000000c",
      summary: "Pay the venue deposit",
      capturedAt: "2026-09-02T20:00:00.000Z",
      status: "met",
      assertionKind: null,
      sourceAttribution: "cli.capture",
      score: 1,
    };
    const evidence = {
      kind: "evidence" as const,
      ref: "00000000-0000-4000-8000-00000000000d",
      summary: "Henna prefers no shellfish",
      occurredAt: "2026-09-16T20:00:00.000Z",
      assertionKind: "user_declared" as const,
      sourceAttribution: "user_declared:evt-1",
      score: 1,
    };
    const procedure = {
      kind: "procedure" as const,
      ref: "00000000-0000-4000-8000-00000000000e",
      summary: "Venue booking checklist",
      createdAt: "2026-09-07T20:00:00.000Z",
      assertionKind: null,
      sourceAttribution: "procedures/venue.md",
      score: 1,
    };
    expect(renderMemoryRecallBlock([met, evidence, procedure])).toEqual([
      "[commitment c-2026-09-02 | per your commitment on Sep 2 (met) | cli.capture] Pay the venue deposit",
      "[evidence e-2026-09-16 | per evidence observed Sep 16 | user_declared, user_declared:evt-1] Henna prefers no shellfish",
      "[procedure p-2026-09-07 | per your procedure from Sep 7 | procedures/venue.md] Venue booking checklist",
    ]);
  });

  it("returns [] for no items", () => {
    expect(renderMemoryRecallBlock([])).toEqual([]);
  });
});

describe("recallMemory input handling (no database)", () => {
  it("returns [] without querying when the query text yields no terms", async () => {
    await expect(
      recallMemory(THROWING_DB, { principalId: "p1", queryText: "  ?! " }),
    ).resolves.toEqual([]);
  });

  it("rejects invalid limits before any query", async () => {
    await expect(
      recallMemory(THROWING_DB, { principalId: "p1", queryText: "venue", limit: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      recallMemory(THROWING_DB, { principalId: "p1", queryText: "venue", limit: Number.NaN }),
    ).rejects.toThrow(RangeError);
  });

  it("rejects blank principalId and non-string queryText", async () => {
    await expect(
      recallMemory(THROWING_DB, { principalId: "  ", queryText: "venue" }),
    ).rejects.toThrow(TypeError);
    await expect(
      recallMemory(THROWING_DB, { principalId: "p1", queryText: undefined as unknown as string }),
    ).rejects.toThrow(TypeError);
  });

  it("exposes a coverage-honesty sentence", () => {
    expect(typeof MEMORY_RECALL_COVERAGE).toBe("string");
    expect(MEMORY_RECALL_COVERAGE).toContain("not covered");
  });
});
