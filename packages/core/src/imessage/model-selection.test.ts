import { describe, expect, it } from "vitest";
import {
  escalationAuditFields,
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
  it("true only when parseFailed — any text", () => {
    expect(shouldEscalateRoute("total garbage !!!", true)).toBe(true);
    expect(shouldEscalateRoute("", true)).toBe(true);
  });

  it("never on content: parse succeeded → no escalation, whatever the text says", () => {
    expect(shouldEscalateRoute("I cannot help with that.", false)).toBe(false);
    expect(shouldEscalateRoute("!!! ??? garbage ???", false)).toBe(false);
    expect(shouldEscalateRoute("", false)).toBe(false);
  });
});

describe("escalationAuditFields", () => {
  it("carries attempt + model for ledger symmetry", () => {
    expect(escalationAuditFields(1, "a/route")).toEqual({ attempt: 1, model: "a/route" });
    expect(escalationAuditFields(2, "a/fallback")).toEqual({ attempt: 2, model: "a/fallback" });
  });
});
