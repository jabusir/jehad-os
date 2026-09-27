// Reliability wave goal 5 + shell-trust R5 — HERMETIC structure tests for
// the semantic contract corpus (no network, no live model): schema
// validity, behavior coverage, id/phrasing uniqueness, dev/holdout
// disjointness across EVERY turn (multi-turn aware), and the no-prompt-
// overfit pin (no corpus phrasing appears in any cognitive prompt surface).

import { describe, expect, it } from "vitest";
import { COGNITIVE_OPERATION_TYPES, cognitivePromptSurfacesForOverfitPin } from "@jehad/core";
import {
  DEV_CORPUS_FILE,
  HOLDOUT_CORPUS_FILE,
  SEMANTIC_BEHAVIORS,
  casePhrasings,
  loadSemanticCorpus,
  phrasingKey,
} from "./semantic-corpus.js";

const dev = loadSemanticCorpus(DEV_CORPUS_FILE);
const holdout = loadSemanticCorpus(HOLDOUT_CORPUS_FILE);

/** Holdout v1 predates the R5 surface (work/delegation/multi-turn classes).
 *  Holdout v2 is OWNER-AUTHORED phrasing and frozen after R1–R4 land
 *  (plan §5 R5.3 — one hand authoring dev and holdout is the overfit
 *  vector). Until the freeze, these classes are dev-measured only; the
 *  §9 exit bar requires holdout coverage of them at freeze time. */
const HOLDOUT_PENDING_V2: ReadonlySet<string> = new Set([
  "delegate_confirm",
  "status_query",
  "phantom_work",
  "referent_chain",
  "new_thread_survival",
  "gmail_read_chain",
  "calendar_next",
]);

describe("semantic contract corpus (structure)", () => {
  it("every directive-required behavior is covered in dev", () => {
    const behaviors = new Set(dev.cases.map((c) => c.behavior));
    for (const behavior of SEMANTIC_BEHAVIORS) {
      expect(behaviors.has(behavior), `${behavior} missing from dev`).toBe(true);
    }
    for (const behavior of behaviors) {
      expect(SEMANTIC_BEHAVIORS).toContain(behavior);
    }
  });

  it("holdout covers every class except the tracked v2-pending set (owner-authored freeze pending)", () => {
    const behaviors = new Set(holdout.cases.map((c) => c.behavior));
    for (const behavior of behaviors) {
      expect(SEMANTIC_BEHAVIORS).toContain(behavior);
    }
    for (const behavior of SEMANTIC_BEHAVIORS) {
      if (HOLDOUT_PENDING_V2.has(behavior)) continue;
      expect(behaviors.has(behavior), `${behavior} missing from holdout`).toBe(true);
    }
  });

  it("ids are unique across both splits", () => {
    const ids = [...dev.cases, ...holdout.cases].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("HOLDOUT phrasings are disjoint from DEV across every turn (anti-leak)", () => {
    const devKeys = new Set(dev.cases.flatMap((c) => casePhrasings(c).map(phrasingKey)));
    for (const c of holdout.cases) {
      for (const phrase of casePhrasings(c)) {
        expect(devKeys.has(phrasingKey(phrase)), `holdout phrase leaked into dev: ${phrase}`).toBe(false);
      }
    }
  });

  it("every expected op type is a registry member; every case has at least one expectation", () => {
    const registry = new Set<string>(COGNITIVE_OPERATION_TYPES);
    for (const c of [...dev.cases, ...holdout.cases]) {
      const hasPin =
        (c.expect.reads?.length ?? 0) > 0 ||
        (c.expect.ops?.length ?? 0) > 0 ||
        c.expect.noMutations === true ||
        c.expect.noPhantomWork === true ||
        c.expect.effects !== undefined;
      expect(hasPin, `${c.id}: no expectation pins`).toBe(true);
      for (const op of c.expect.ops ?? []) {
        expect(registry.has(op.type), `${c.id}: unknown op type ${op.type}`).toBe(true);
      }
      for (const turn of c.turns ?? []) {
        for (const op of turn.ops ?? []) {
          expect(registry.has(op.type), `${c.id}: unknown turn op type ${op.type}`).toBe(true);
        }
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

  it("NO corpus phrasing appears in any cognitive prompt surface (no prompt overfitting)", () => {
    const surfaces = cognitivePromptSurfacesForOverfitPin().map((s) => s.toLowerCase());
    const phrases = [...dev.cases, ...holdout.cases].flatMap((c) =>
      casePhrasings(c).filter((p) => p.split(/\s+/).length >= 4),
    );
    for (const phrase of phrases) {
      const key = phrasingKey(phrase);
      for (const surface of surfaces) {
        expect(
          surface.includes(key),
          `eval phrasing leaked into a prompt surface: "${phrase.slice(0, 60)}"`,
        ).toBe(false);
      }
    }
  });
});
