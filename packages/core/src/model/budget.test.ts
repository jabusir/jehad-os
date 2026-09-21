// Budget env parsing (A13) — unit, no DB. Misconfiguration fails closed and
// loud rather than silently widening the caps.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_BUDGET_HARD_USD,
  DEFAULT_MODEL_BUDGET_SOFT_USD,
  ModelBudgetConfigError,
  modelBudgetFromEnv,
} from "./budget.js";

describe("modelBudgetFromEnv", () => {
  it("defaults to the proving-phase envelope ($40 soft / $90 hard)", () => {
    expect(modelBudgetFromEnv({})).toEqual({
      softUsd: DEFAULT_MODEL_BUDGET_SOFT_USD,
      hardUsd: DEFAULT_MODEL_BUDGET_HARD_USD,
    });
    expect(DEFAULT_MODEL_BUDGET_SOFT_USD).toBe(40);
    expect(DEFAULT_MODEL_BUDGET_HARD_USD).toBe(90);
  });

  it("reads MODEL_BUDGET_SOFT_USD / MODEL_BUDGET_HARD_USD overrides", () => {
    expect(
      modelBudgetFromEnv({ MODEL_BUDGET_SOFT_USD: "5", MODEL_BUDGET_HARD_USD: "12.5" }),
    ).toEqual({ softUsd: 5, hardUsd: 12.5 });
  });

  it("blank values fall back to defaults", () => {
    expect(modelBudgetFromEnv({ MODEL_BUDGET_SOFT_USD: "  ", MODEL_BUDGET_HARD_USD: "" })).toEqual({
      softUsd: 40,
      hardUsd: 90,
    });
  });

  it("rejects non-numeric, zero, and negative values", () => {
    expect(() => modelBudgetFromEnv({ MODEL_BUDGET_SOFT_USD: "lots" })).toThrow(ModelBudgetConfigError);
    expect(() => modelBudgetFromEnv({ MODEL_BUDGET_SOFT_USD: "0" })).toThrow(ModelBudgetConfigError);
    expect(() => modelBudgetFromEnv({ MODEL_BUDGET_HARD_USD: "-5" })).toThrow(ModelBudgetConfigError);
  });

  it("rejects soft above hard", () => {
    expect(() => modelBudgetFromEnv({ MODEL_BUDGET_SOFT_USD: "100" })).toThrow(ModelBudgetConfigError);
    expect(() => modelBudgetFromEnv({ MODEL_BUDGET_SOFT_USD: "50", MODEL_BUDGET_HARD_USD: "49" })).toThrow(
      ModelBudgetConfigError,
    );
  });
});
