// Empirical trust unit tests (owner decalibration directive 2026-09-17):
// policyConfidence caps the model's claim with observed precision; loaders
// fail closed (missing → null, malformed → throw). Hermetic — tmp files only.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EmpiricalPrecisionError,
  FAIL_CLOSED_ACTION_PRECISION,
  empiricalPrecisionFromReport,
  loadEmpiricalPrecision,
  parseEmpiricalPrecision,
  policyConfidence,
  serializeEmpiricalPrecision,
  writeEmpiricalPrecision,
  writeEmpiricalPrecisionFromReport,
  type EmpiricalPrecision,
} from "./empirical.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jehad-w6c-trust-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const EMPIRICAL: EmpiricalPrecision = {
  updatedAt: "2026-09-17T00:00:00.000Z",
  byClass: { commitment: 0.81, decision: 0.95 },
  source: "test",
};

describe("policyConfidence — empirical precision CAPS the model's claim", () => {
  it("min(modelConfidence, empiricalByClass) — the acceptance case: 0.95 capped to 0.81", () => {
    expect(
      policyConfidence(0.95, { class: "commitment", empirical: EMPIRICAL, purpose: "action" }),
    ).toBe(0.81);
  });

  it("never raises the model's claim when the cap is higher", () => {
    expect(
      policyConfidence(0.6, { class: "decision", empirical: EMPIRICAL, purpose: "action" }),
    ).toBe(0.6);
  });

  it("uncovered class falls back to byClass.default, else uncapped for display / fail-closed for action", () => {
    const withDefault = { ...EMPIRICAL, byClass: { default: 0.9, commitment: 0.81 } };
    expect(
      policyConfidence(0.95, { class: "semantic", empirical: withDefault, purpose: "action" }),
    ).toBe(0.9);
    // No cover at all: the owner formula leaves display raw; an action
    // decision never falls back to the uncalibrated model number.
    expect(
      policyConfidence(0.95, { class: "semantic", empirical: EMPIRICAL, purpose: "display" }),
    ).toBe(0.95);
    expect(
      policyConfidence(0.95, { class: "semantic", empirical: EMPIRICAL, purpose: "action" }),
    ).toBe(FAIL_CLOSED_ACTION_PRECISION);
  });

  it("missing empirical source fails action decisions closed to 0.5, display stays raw", () => {
    expect(policyConfidence(0.95, { class: "commitment", empirical: null, purpose: "action" })).toBe(
      FAIL_CLOSED_ACTION_PRECISION,
    );
    expect(policyConfidence(0.3, { class: "commitment", empirical: null, purpose: "action" })).toBe(0.3);
    expect(policyConfidence(0.95, { class: "commitment", empirical: null, purpose: "display" })).toBe(0.95);
  });

  it("rejects out-of-range model confidence", () => {
    expect(() =>
      policyConfidence(1.2, { class: "commitment", empirical: EMPIRICAL, purpose: "action" }),
    ).toThrow(RangeError);
    expect(() =>
      policyConfidence(Number.NaN, { class: "commitment", empirical: EMPIRICAL, purpose: "display" }),
    ).toThrow(RangeError);
  });
});

describe("parseEmpiricalPrecision — validation fails closed", () => {
  it("accepts the simple runner shape and validates ranges", () => {
    const parsed = parseEmpiricalPrecision(
      { updatedAt: "2026-09-17T00:00:00.000Z", byClass: { commitment: 0.95 }, byState: { open: 0.9 } },
      "fixtures",
    );
    expect(parsed.byClass).toEqual({ commitment: 0.95 });
    expect(parsed.byState).toEqual({ open: 0.9 });
  });

  it.each([
    ["not an object", []],
    ["missing updatedAt", { byClass: {} }],
    ["byClass not an object", { updatedAt: "x", byClass: 7 }],
    ["byClass value out of range", { updatedAt: "x", byClass: { commitment: 1.5 } }],
    ["byClass value not a number", { updatedAt: "x", byClass: { commitment: "high" } }],
  ])("throws on %s", (_label, json) => {
    expect(() => parseEmpiricalPrecision(json, "fixtures")).toThrow(EmpiricalPrecisionError);
  });
});

describe("empiricalPrecisionFromReport — derives caps from a live-run report", () => {
  const REPORT = {
    skipped: false,
    run: {
      meta: { tier: "live", ranAt: "2026-09-17T01:02:03.000Z" },
      report: {
        detection: { precision: 0.95 },
        actionDriving: { threshold: 0.7, accuracy: 0.92 },
        failures: [],
      },
    },
  };

  it("maps action-driving precision to commitment, overall to default", () => {
    const derived = empiricalPrecisionFromReport(REPORT);
    expect(derived.updatedAt).toBe("2026-09-17T01:02:03.000Z");
    expect(derived.byClass).toEqual({ commitment: 0.92, default: 0.95 });
  });

  it("tolerates the precision key variant on actionDriving", () => {
    const derived = empiricalPrecisionFromReport({
      run: { report: { detection: { precision: 0.9 }, actionDriving: { precision: 0.81 } } },
    });
    expect(derived.byClass.commitment).toBe(0.81);
  });

  it.each([
    ["no run object", {}],
    ["skipped run without report", { run: {} }],
    ["missing detection precision", { run: { report: { detection: {} } } }],
    ["out-of-range precision", { run: { report: { detection: { precision: 2 } } } }],
  ])("throws on %s (fail closed)", (_label, json) => {
    expect(() => empiricalPrecisionFromReport(json)).toThrow(EmpiricalPrecisionError);
  });
});

describe("loadEmpiricalPrecision — file loader", () => {
  it("loads the simple .empirical-precision.json shape", async () => {
    const file = join(dir, "prec.json");
    await writeEmpiricalPrecision(file, EMPIRICAL);
    const loaded = await loadEmpiricalPrecision(file);
    expect(loaded?.byClass).toEqual({ commitment: 0.81, decision: 0.95 });
  });

  it("derives caps from a .last-live.json run file", async () => {
    const file = join(dir, "last-live.json");
    await writeFile(
      file,
      JSON.stringify({
        skipped: false,
        run: {
          meta: { ranAt: "2026-09-17T01:02:03.000Z" },
          report: { detection: { precision: 0.95 }, actionDriving: { accuracy: 0.92 } },
        },
      }),
      "utf8",
    );
    const loaded = await loadEmpiricalPrecision(file);
    expect(loaded?.byClass).toEqual({ commitment: 0.92, default: 0.95 });
  });

  it("missing file → null (callers fail closed by purpose)", async () => {
    expect(await loadEmpiricalPrecision(join(dir, "does-not-exist.json"))).toBeNull();
  });

  it("malformed JSON throws (fail closed, never silently)", async () => {
    const file = join(dir, "malformed.json");
    await writeFile(file, "{not json", "utf8");
    await expect(loadEmpiricalPrecision(file)).rejects.toThrow(EmpiricalPrecisionError);
  });

  it("valid JSON with an invalid shape throws", async () => {
    const file = join(dir, "invalid.json");
    await writeFile(file, JSON.stringify({ updatedAt: "x", byClass: { commitment: 42 } }), "utf8");
    await expect(loadEmpiricalPrecision(file)).rejects.toThrow(EmpiricalPrecisionError);
  });
});

describe("writeEmpiricalPrecisionFromReport — future eval-runner wiring", () => {
  it("writes a loadable .empirical-precision.json from a report", async () => {
    const file = join(dir, "nested", "empirical-precision.json");
    const written = await writeEmpiricalPrecisionFromReport(
      {
        run: {
          meta: { ranAt: "2026-09-17T01:02:03.000Z" },
          report: { detection: { precision: 0.95 }, actionDriving: { accuracy: 0.92 } },
        },
      },
      file,
    );
    expect(written.byClass.commitment).toBe(0.92);
    const reloaded = await loadEmpiricalPrecision(file);
    expect(reloaded?.updatedAt).toBe("2026-09-17T01:02:03.000Z");
    const text = await readFile(file, "utf8");
    expect(text).toBe(serializeEmpiricalPrecision(written));
  });

  it("throws on a malformed report without writing anything usable", async () => {
    const file = join(dir, "bad-report.json");
    await expect(writeEmpiricalPrecisionFromReport({ run: {} }, file)).rejects.toThrow(
      EmpiricalPrecisionError,
    );
  });
});
