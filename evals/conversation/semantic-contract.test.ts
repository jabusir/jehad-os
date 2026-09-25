// Reliability wave goal 5 — HERMETIC structure tests for the semantic
// contract corpus (no network, no live model): schema validity, behavior
// coverage of every directive-required class in BOTH splits, id/phrasing
// uniqueness, and dev/holdout disjointness (the anti-leak pin).

import { describe, expect, it } from "vitest";
import { COGNITIVE_OPERATION_TYPES } from "@jehad/core";
import {
  DEV_CORPUS_FILE,
  HOLDOUT_CORPUS_FILE,
  SEMANTIC_BEHAVIORS,
  loadSemanticCorpus,
  phrasingKey,
} from "./semantic-corpus.js";

const dev = loadSemanticCorpus(DEV_CORPUS_FILE);
const holdout = loadSemanticCorpus(HOLDOUT_CORPUS_FILE);

describe("semantic contract corpus (structure)", () => {
  it("every directive-required behavior is covered in BOTH splits", () => {
    for (const corpus of [dev, holdout]) {
      const behaviors = new Set(corpus.cases.map((c) => c.behavior));
      for (const behavior of SEMANTIC_BEHAVIORS) {
        expect(behaviors.has(behavior), `${behavior} missing from a split`).toBe(true);
      }
      for (const behavior of behaviors) {
        expect(SEMANTIC_BEHAVIORS).toContain(behavior);
      }
    }
  });

  it("ids are unique across both splits", () => {
    const ids = [...dev.cases, ...holdout.cases].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("HOLDOUT phrasings are disjoint from DEV (anti-leak: no tuned phrase reuse)", () => {
    const devKeys = new Set(dev.cases.map((c) => phrasingKey(c.user)));
    for (const c of holdout.cases) {
      expect(devKeys.has(phrasingKey(c.user)), `holdout phrase leaked into dev: ${c.user}`).toBe(false);
    }
  });

  it("every expected op type is a registry member; every case has at least one expectation", () => {
    const registry = new Set<string>(COGNITIVE_OPERATION_TYPES);
    for (const c of [...dev.cases, ...holdout.cases]) {
      const hasPin =
        (c.expect.reads?.length ?? 0) > 0 ||
        (c.expect.ops?.length ?? 0) > 0 ||
        c.expect.noMutations === true ||
        c.expect.effects !== undefined;
      expect(hasPin, `${c.id}: no expectation pins`).toBe(true);
      for (const op of c.expect.ops ?? []) {
        expect(registry.has(op.type), `${c.id}: unknown op type ${op.type}`).toBe(true);
      }
    }
  });

  it("paraphrase density: multi-word behaviors carry ≥2 distinct phrasings in dev", () => {
    const counts = new Map<string, number>();
    for (const c of dev.cases) counts.set(c.behavior, (counts.get(c.behavior) ?? 0) + 1);
    for (const [behavior, n] of counts) {
      expect(n, `${behavior}: dev needs ≥2 paraphrases`).toBeGreaterThanOrEqual(2);
    }
  });
});
