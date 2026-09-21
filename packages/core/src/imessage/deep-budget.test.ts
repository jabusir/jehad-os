// Deep-budget guard (W3) — pure cap math. Ledger counting is covered by
// deep-budget.integration.test.ts against PostgreSQL.

import { describe, expect, it } from "vitest";
import { DEEP_BUDGET_FRACTION_OF_DAILY, deepDailyCapUsd, deepPromptVersion } from "./deep-budget";

describe("deepDailyCapUsd", () => {
  it("derives from the ratified envelope default: 0.5 × (40 / 30) USD/day", () => {
    expect(deepDailyCapUsd({})).toBeCloseTo((40 / 30) * DEEP_BUDGET_FRACTION_OF_DAILY, 10);
  });

  it("follows MODEL_BUDGET_SOFT_USD — the cap is never a hardcoded number", () => {
    expect(deepDailyCapUsd({ MODEL_BUDGET_SOFT_USD: "60" })).toBeCloseTo(1.0, 10);
    expect(deepDailyCapUsd({ MODEL_BUDGET_SOFT_USD: "12" })).toBeCloseTo(0.2, 10);
  });

  it("misconfigured env fails closed and loud (budget module contract)", () => {
    expect(() => deepDailyCapUsd({ MODEL_BUDGET_SOFT_USD: "lots" })).toThrow();
    expect(() => deepDailyCapUsd({ MODEL_BUDGET_SOFT_USD: "0" })).toThrow();
    expect(() => deepDailyCapUsd({ MODEL_BUDGET_SOFT_USD: "500", MODEL_BUDGET_HARD_USD: "90" })).toThrow();
  });
});

describe("deepPromptVersion", () => {
  it("stamps the documented :deep suffix on the base answer prompt version", () => {
    expect(deepPromptVersion("imessage-converse-v2")).toBe("imessage-converse-v2:deep");
    expect(deepPromptVersion("imessage-converse-v3")).toBe("imessage-converse-v3:deep");
  });
});
