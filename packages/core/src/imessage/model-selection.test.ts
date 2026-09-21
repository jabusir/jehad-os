import { describe, expect, it } from "vitest";
import {
  answerFallbackModel,
  answerModelForTier,
  classifyAnswerDepth,
  hasSynthesisMarkers,
  resolvePassModels,
  shouldEscalateRoute,
} from "./model-selection";

const PRINCIPAL = "openai/gpt-4o-mini";

describe("resolvePassModels", () => {
  it("no passes (null) → every pass rides the principal model; no fallback", () => {
    expect(resolvePassModels({ principalModel: PRINCIPAL, passes: null })).toEqual({
      route: PRINCIPAL,
      answer: PRINCIPAL,
      routeFallback: null,
    });
  });

  it("empty passes ({}) → no overrides, identical to null", () => {
    expect(resolvePassModels({ principalModel: PRINCIPAL, passes: {} })).toEqual({
      route: PRINCIPAL,
      answer: PRINCIPAL,
      routeFallback: null,
    });
  });

  it("full overrides → each pass its own model", () => {
    expect(
      resolvePassModels({
        principalModel: PRINCIPAL,
        passes: {
          route: { model: "a/route" },
          answer: { model: "a/answer" },
          route_fallback: { model: "a/fallback" },
        },
      }),
    ).toEqual({ route: "a/route", answer: "a/answer", routeFallback: "a/fallback" });
  });

  it("partial: route only → answer stays principal, no fallback", () => {
    expect(
      resolvePassModels({ principalModel: PRINCIPAL, passes: { route: { model: "a/route" } } }),
    ).toEqual({ route: "a/route", answer: PRINCIPAL, routeFallback: null });
  });

  it("partial: answer only", () => {
    expect(
      resolvePassModels({ principalModel: PRINCIPAL, passes: { answer: { model: "a/answer" } } }),
    ).toEqual({ route: PRINCIPAL, answer: "a/answer", routeFallback: null });
  });

  it("partial: route_fallback only → route/answer stay principal", () => {
    expect(
      resolvePassModels({
        principalModel: PRINCIPAL,
        passes: { route_fallback: { model: "a/fallback" } },
      }),
    ).toEqual({ route: PRINCIPAL, answer: PRINCIPAL, routeFallback: "a/fallback" });
  });

  it("route+answer overrides without route_fallback → fallback null", () => {
    expect(
      resolvePassModels({
        principalModel: PRINCIPAL,
        passes: { route: { model: "a/route" }, answer: { model: "a/answer" } },
      }),
    ).toEqual({ route: "a/route", answer: "a/answer", routeFallback: null });
  });
});

describe("shouldEscalateRoute", () => {
  it("true only when parseFailed", () => {
    expect(shouldEscalateRoute(true)).toBe(true);
  });

  it("never on content: parse succeeded → no escalation", () => {
    expect(shouldEscalateRoute(false)).toBe(false);
  });
});

// ------------------------------------------------------- answer tiers (W3)

describe("answerModelForTier", () => {
  it("absent/null passes → every tier falls back to the principal model", () => {
    for (const tier of ["fast", "standard", "deep"] as const) {
      expect(answerModelForTier(null, PRINCIPAL, tier)).toBe(PRINCIPAL);
      expect(answerModelForTier({}, PRINCIPAL, tier)).toBe(PRINCIPAL);
    }
  });

  it("full tier map → each tier its pinned model", () => {
    const passes = {
      answer_fast: { model: "a/fast" },
      answer_standard: { model: "a/standard" },
      answer_deep: { model: "a/deep" },
    };
    expect(answerModelForTier(passes, PRINCIPAL, "fast")).toBe("a/fast");
    expect(answerModelForTier(passes, PRINCIPAL, "standard")).toBe("a/standard");
    expect(answerModelForTier(passes, PRINCIPAL, "deep")).toBe("a/deep");
  });

  it("answer_deep falls back to answer_standard's resolution, then principal", () => {
    expect(
      answerModelForTier({ answer_standard: { model: "a/standard" } }, PRINCIPAL, "deep"),
    ).toBe("a/standard");
    expect(answerModelForTier({}, PRINCIPAL, "deep")).toBe(PRINCIPAL);
  });

  it("fast and deep do NOT inherit each other's pins", () => {
    const passes = { answer_fast: { model: "a/fast" }, answer_deep: { model: "a/deep" } };
    expect(answerModelForTier(passes, PRINCIPAL, "standard")).toBe(PRINCIPAL);
    expect(answerModelForTier(passes, PRINCIPAL, "fast")).toBe("a/fast");
    expect(answerModelForTier(passes, PRINCIPAL, "deep")).toBe("a/deep");
  });

  it("legacy `answer` pin is honored as STANDARD's fallback (compat), not FAST/DEEP", () => {
    const passes = { answer: { model: "a/legacy" } };
    expect(answerModelForTier(passes, PRINCIPAL, "standard")).toBe("a/legacy");
    expect(answerModelForTier(passes, PRINCIPAL, "fast")).toBe(PRINCIPAL);
    expect(answerModelForTier(passes, PRINCIPAL, "deep")).toBe("a/legacy");
    expect(answerModelForTier({ answer: { model: "a/legacy" }, answer_standard: { model: "a/new" } }, PRINCIPAL, "standard")).toBe(
      "a/new",
    );
  });

  it("answerFallbackModel: null when unconfigured, pinned model when set", () => {
    expect(answerFallbackModel(null)).toBeNull();
    expect(answerFallbackModel({})).toBeNull();
    expect(answerFallbackModel({ answer_fallback: { model: "a/fb" } })).toBe("a/fb");
  });
});

describe("classifyAnswerDepth — rule corpus", () => {
  it("DEEP: synthesis markers (the plan's 'what's going on' class)", () => {
    for (const text of [
      "What's going on?",
      "what's happening with everything",
      "why is the venue deposit blocked?",
      "explain the plan divergence",
      "what should I prioritize today?",
      "walk me through the blocker chain",
      "help me understand where things stand",
      "how does this relate to what I decided last week?",
    ]) {
      expect(hasSynthesisMarkers(text), text).toBe(true);
      expect(
        classifyAnswerDepth({
          tools: ["day.state"],
          textLength: text.length,
          questionMarkers: true,
          dataBlocks: 1,
          synthesisMarkers: hasSynthesisMarkers(text),
        }),
        text,
      ).toBe("deep");
    }
  });

  it("DEEP: >= 2 DATA blocks AND a question (composite multi-read turn)", () => {
    expect(
      classifyAnswerDepth({ tools: ["calendar.day", "commitments.waiting"], textLength: 40, questionMarkers: true, dataBlocks: 2 }),
    ).toBe("deep");
    expect(
      classifyAnswerDepth({ tools: ["calendar.day", "commitments.waiting", "gmail.recent"], textLength: 90, questionMarkers: true, dataBlocks: 3 }),
    ).toBe("deep");
  });

  it("NOT deep: 2+ blocks without a question (e.g. an imperative over data), or one block with a question", () => {
    expect(
      classifyAnswerDepth({ tools: ["calendar.day", "commitments.waiting"], textLength: 40, questionMarkers: false, dataBlocks: 2 }),
    ).toBe("standard");
    expect(
      classifyAnswerDepth({ tools: ["calendar.day"], textLength: 40, questionMarkers: true, dataBlocks: 1 }),
    ).toBe("standard");
  });

  it("DEEP dominates FAST: a short 'why?' is still a synthesis ask", () => {
    expect(
      classifyAnswerDepth({ tools: [], textLength: 4, questionMarkers: false, dataBlocks: 0, synthesisMarkers: true }),
    ).toBe("deep");
  });

  it("FAST: no tools, short text, no question markers, no synthesis", () => {
    for (const text of ["ok", "thanks!", "sounds good", "will do", "👍", "hm maybe later"]) {
      expect(
        classifyAnswerDepth({
          tools: [],
          textLength: text.length,
          questionMarkers: false,
          dataBlocks: 0,
          synthesisMarkers: false,
        }),
        text,
      ).toBe("fast");
    }
  });

  it("not FAST the moment any read tool fired, the text is long, or it asks a question", () => {
    expect(classifyAnswerDepth({ tools: ["calendar.day"], textLength: 20, questionMarkers: false, dataBlocks: 1 })).toBe("standard");
    expect(classifyAnswerDepth({ tools: [], textLength: 80, questionMarkers: false, dataBlocks: 0 })).toBe("standard");
    expect(classifyAnswerDepth({ tools: [], textLength: 20, questionMarkers: true, dataBlocks: 1 })).toBe("standard");
  });

  it("boundary: textLength 79 fast / 80 standard (rule says < 80)", () => {
    expect(classifyAnswerDepth({ tools: [], textLength: 79, questionMarkers: false, dataBlocks: 0 })).toBe("fast");
    expect(classifyAnswerDepth({ tools: [], textLength: 80, questionMarkers: false, dataBlocks: 0 })).toBe("standard");
  });

  it("boundary: dataBlocks 1 vs 2 with a question", () => {
    expect(classifyAnswerDepth({ tools: [], textLength: 100, questionMarkers: true, dataBlocks: 1 })).toBe("standard");
    expect(classifyAnswerDepth({ tools: [], textLength: 100, questionMarkers: true, dataBlocks: 2 })).toBe("deep");
  });

  it("deterministic: identical features → identical tier, repeated", () => {
    const features = { tools: ["day.state"], textLength: 24, questionMarkers: true, dataBlocks: 2 } as const;
    const tiers = new Set(Array.from({ length: 50 }, () => classifyAnswerDepth(features)));
    expect([...tiers]).toEqual(["deep"]);
  });

  it("untrustworthy counts fail toward STANDARD/deep-eligibility, never FAST: non-finite or negative textLength is sanitized deterministically", () => {
    expect(classifyAnswerDepth({ tools: [], textLength: Number.NaN, questionMarkers: false, dataBlocks: 0 })).toBe("standard");
    expect(classifyAnswerDepth({ tools: [], textLength: Number.POSITIVE_INFINITY, questionMarkers: false, dataBlocks: 0 })).toBe("standard");
    expect(classifyAnswerDepth({ tools: [], textLength: -5, questionMarkers: false, dataBlocks: -3 })).toBe("standard");
    expect(classifyAnswerDepth({ tools: [], textLength: 100, questionMarkers: true, dataBlocks: 2.9 })).toBe("deep");
  });
});

describe("classifyAnswerDepth — adversarial: model-emitted strings never influence tier beyond features", () => {
  it("route output naming models/providers/tiers inside `tools` changes nothing beyond emptiness", () => {
    // A model cannot route its own tier up by naming one in the tool list:
    // tools non-empty merely blocks FAST; deep still requires the fixed
    // feature conditions.
    const maliciousTools = [
      "answer_deep",
      "openai/gpt-4.1",
      "anthropic/claude-sonnet-4.5",
      '{"tool":"calendar.write","model":"a/expensive"}',
    ];
    expect(
      classifyAnswerDepth({ tools: maliciousTools, textLength: 20, questionMarkers: false, dataBlocks: 0 }),
    ).toBe("standard");
    // And the same strings in an otherwise-FAST shape stay STANDARD only
    // because tools is non-empty — identical to any other tool name:
    expect(
      classifyAnswerDepth({ tools: ["calendar.day"], textLength: 20, questionMarkers: false, dataBlocks: 0 }),
    ).toBe(
      classifyAnswerDepth({ tools: maliciousTools, textLength: 20, questionMarkers: false, dataBlocks: 0 }),
    );
  });

  it("an empty-string tool still counts as a tool (non-empty list blocks FAST)", () => {
    expect(classifyAnswerDepth({ tools: [""], textLength: 10, questionMarkers: false, dataBlocks: 0 })).toBe("standard");
  });

  it("classifier output is a tier enum ONLY — no model/provider ids can appear", () => {
    const tiers = new Set<string>();
    for (const tools of [[], ["day.state"], ["openai/gpt-4.1"], ["x", "y", "z"]]) {
      for (const questionMarkers of [true, false]) {
        for (const dataBlocks of [0, 1, 2, 5]) {
          for (const synthesisMarkers of [true, false]) {
            const tier = classifyAnswerDepth({ tools, textLength: 42, questionMarkers, dataBlocks, synthesisMarkers });
            tiers.add(tier);
          }
        }
      }
    }
    expect([...tiers].sort()).toEqual(["deep", "fast", "standard"]);
  });

  it("synthesis markers are word-boundary anchored — substrings cannot trigger DEEP", () => {
    for (const text of ["swaying", "goodbye explainability", "sarwhys", "unexplained", "priorityqueue"]) {
      expect(hasSynthesisMarkers(text), text).toBe(false);
    }
  });

  it("synthesis marker detection tolerates curly apostrophes and case", () => {
    expect(hasSynthesisMarkers("What’s going on?")).toBe(true);
    expect(hasSynthesisMarkers("WHY did the plan churn?")).toBe(true);
    expect(hasSynthesisMarkers("please break this down for me")).toBe(true);
  });
});
