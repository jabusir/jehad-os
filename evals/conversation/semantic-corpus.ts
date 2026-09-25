// Reliability wave goal 5 — the semantic-contract corpus types + loader.
// REAL production cognitive model + REAL cognitive prompt + unseen natural
// language → expected semantic envelope / canonical effect. The corpus is
// two disjoint splits (dev / holdout); the structure test pins coverage,
// uniqueness, and disjointness so the holdout cannot leak into tuning.

import { parse } from "yaml";
import { readFileSync } from "node:fs";

/** The 21 behavior classes the directive requires covered. */
export const SEMANTIC_BEHAVIORS: readonly string[] = [
  "reminder_create",
  "reminder_datetime",
  "task_capture",
  "commitment_done",
  "commitment_missed",
  "reminder_renegotiate",
  "checkin_reply",
  "occurrence_happened",
  "occurrence_skipped",
  "profile_address",
  "profile_tone_brevity",
  "list_commitments",
  "calendar_today",
  "gmail_recent",
  "gmail_search",
  "memory_recall",
  "offer_apply",
  "offer_decline",
  "delegate_intent",
  "chat_nomutate",
  "injection_nomutate",
];

export interface SemanticSeedCalendar {
  readonly summary: string;
  /** "HH:MM" local (PT) today. */
  readonly time: string;
}

export interface SemanticSeedReminder {
  readonly title: string;
  readonly date: "today" | "tomorrow";
  readonly time: string;
}

export interface SemanticSeedGmail {
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  readonly ageHours: number;
}

export interface SemanticSeed {
  readonly commitments?: readonly string[];
  readonly calendar?: readonly SemanticSeedCalendar[];
  readonly armedReminders?: readonly SemanticSeedReminder[];
  readonly pendingOffer?: {
    readonly type: string;
    readonly items: readonly { readonly title: string }[];
  };
  readonly gmail?: readonly SemanticSeedGmail[];
}

export interface SemanticOpExpectation {
  readonly type: string;
  /** Arg pins (observer-based): the emitted op must satisfy each. */
  readonly verb?: string;
  readonly titleContains?: readonly string[];
}

export interface SemanticEffects {
  readonly remindersArmed?: number;
  readonly remindersCompleted?: number;
  readonly reminderDueDate?: string;
  readonly commitmentStatus?: Readonly<Record<string, string>>;
  readonly occurrenceObserved?: number;
  readonly occurrenceMissed?: number;
  readonly profileVersion?: number;
  readonly pendingTaskBatch?: boolean;
  readonly pendingOutcomeSpec?: boolean;
  readonly commitmentsOpen?: number;
}

export interface SemanticCase {
  readonly id: string;
  readonly behavior: string;
  readonly seed?: SemanticSeed;
  readonly user: string;
  readonly expect: {
    readonly reads?: readonly string[];
    readonly ops?: readonly SemanticOpExpectation[];
    readonly noMutations?: boolean;
    readonly effects?: SemanticEffects;
  };
}

export interface SemanticCorpus {
  readonly version: number;
  readonly cases: readonly SemanticCase[];
}

function unknownRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`semantic corpus: ${what} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function parseCorpus(text: string, file: string): SemanticCorpus {
  const raw = unknownRecord(parse(text), file);
  if (raw["version"] !== 1) throw new Error(`${file}: version must be 1`);
  const cases = raw["cases"];
  if (!Array.isArray(cases) || cases.length === 0) throw new Error(`${file}: cases must be a non-empty list`);
  const parsed: SemanticCase[] = cases.map((entry, index) => {
    const c = unknownRecord(entry, `${file} cases[${index}]`);
    const expect = unknownRecord(c["expect"] ?? {}, `${file} cases[${index}].expect`);
    return {
      id: String(c["id"]),
      behavior: String(c["behavior"]),
      seed: (c["seed"] as SemanticSeed | undefined) ?? undefined,
      user: String(c["user"]),
      expect: {
        reads: (expect["reads"] as readonly string[] | undefined) ?? undefined,
        ops: (expect["ops"] as readonly SemanticOpExpectation[] | undefined) ?? undefined,
        noMutations: expect["noMutations"] === true,
        effects: (expect["effects"] as SemanticEffects | undefined) ?? undefined,
      },
    };
  });
  return { version: 1, cases: parsed };
}

export function loadSemanticCorpus(file: string): SemanticCorpus {
  return parseCorpus(readFileSync(file, "utf8"), file);
}

export const DEV_CORPUS_FILE = new URL("./semantic-corpus-dev.yaml", import.meta.url).pathname;
export const HOLDOUT_CORPUS_FILE = new URL("./semantic-corpus-holdout.yaml", import.meta.url).pathname;

/** Normalized phrasing key — the dev/holdout disjointness pin. */
export function phrasingKey(userText: string): string {
  return userText.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
