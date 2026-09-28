// Reliability wave goal 5 + shell-trust R5 — the semantic-contract corpus
// types + loader. REAL production cognitive model + REAL cognitive prompt +
// unseen natural language → expected semantic envelope / canonical effect.
// The corpus is two disjoint splits (dev / holdout); the structure test pins
// coverage, uniqueness, and disjointness so the holdout cannot leak into
// tuning. R5: cases may be TURN SEQUENCES (world persists across a case's
// turns — park→confirm, referent chains, /new survival); `{{confirm_token}}`
// in a turn's user text resolves to the RUNTIME-minted token from the prior
// turn's parked outcome_spec.

import { parse } from "yaml";
import { readFileSync } from "node:fs";

/** The behavior classes the directive requires covered. */
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
  "calendar_next",
  "gmail_recent",
  "gmail_search",
  "gmail_read_chain",
  "memory_recall",
  "offer_apply",
  "offer_decline",
  "delegate_intent",
  "delegate_confirm",
  "status_query",
  "phantom_work",
  "referent_chain",
  "new_thread_survival",
  "chat_nomutate",
  "injection_nomutate",
];

/** Shell-trust R5/§9: the common control operations measured at the ≥98%
 *  bar on BOTH splits. */
export const COMMON_CONTROL_BEHAVIORS: readonly string[] = [
  "reminder_create",
  "reminder_datetime",
  "task_capture",
  "commitment_done",
  "commitment_missed",
  "checkin_reply",
  "list_commitments",
  "calendar_today",
  "gmail_search",
  "delegate_intent",
  "delegate_confirm",
];

/**
 * W2a A/B expressibility filter (native-tool-cognition.md §10, amendment
 * A2): behaviors the W1 spike tool set can express AT ALL. The A/B scores
 * BOTH drivers on exactly this subset — same corpus, same classes — and
 * defers the rest to W3 (reminders.update/checkins, calendar reads/writes,
 * memory.recall, gmail.recent, occurrence updates are deferred tool
 * surface, not scored here for either driver).
 */
export const W2A_EXPRESSIBLE_BEHAVIORS: readonly string[] = [
  "reminder_create",
  "reminder_datetime",
  "task_capture",
  "commitment_done",
  "commitment_missed",
  "profile_address",
  "profile_tone_brevity",
  "list_commitments",
  "gmail_search",
  "gmail_read_chain",
  "offer_apply",
  "offer_decline",
  "delegate_intent",
  "delegate_confirm",
  "status_query",
  "phantom_work",
  "referent_chain",
  "new_thread_survival",
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

export interface SemanticSeedOutcome {
  readonly ref: string;
  readonly title: string;
  readonly status: string;
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
  /** R5: a canonical delegated outcome (status_query truth source). */
  readonly outcome?: SemanticSeedOutcome;
  /** R5: seeded OUTBOUND history — the phantom-work attack vector: Jin's
   *  own past reply narrating work that has no canonical existence. */
  readonly phantomHistory?: readonly string[];
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
  /** R5: N accepted/active outcomes exist canonically after the case. */
  readonly outcomesActive?: number;
  /** R5: a parked outcome_spec carrying a confirm token exists. */
  readonly outcomeParkedWithToken?: boolean;
}

export interface SemanticTurn {
  readonly user: string;
  /** Per-turn op expectations (checked immediately after this turn). */
  readonly ops?: readonly SemanticOpExpectation[];
  /** Per-turn read expectations (checked immediately after this turn). */
  readonly reads?: readonly string[];
}

export interface SemanticCase {
  readonly id: string;
  readonly behavior: string;
  readonly seed?: SemanticSeed;
  /** Single-turn sugar — mutually exclusive with `turns`. */
  readonly user?: string;
  /** R5: a turn sequence; the case's `expect` applies after the LAST turn. */
  readonly turns?: readonly SemanticTurn[];
  readonly expect: {
    readonly reads?: readonly string[];
    readonly ops?: readonly SemanticOpExpectation[];
    readonly noMutations?: boolean;
    readonly effects?: SemanticEffects;
    /** R5: the final reply must NOT confirm ongoing/finished work that the
     *  canonical work state does not show (the 14:14 regression class). */
    readonly noPhantomWork?: boolean;
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
    const user = c["user"] !== undefined ? String(c["user"]) : undefined;
    const turnsRaw = c["turns"];
    const turns =
      Array.isArray(turnsRaw)
        ? turnsRaw.map((t, tIndex) => {
            const turn = unknownRecord(t, `${file} cases[${index}].turns[${tIndex}]`);
            return {
              user: String(turn["user"]),
              ...(turn["ops"] !== undefined
                ? { ops: turn["ops"] as readonly SemanticOpExpectation[] }
                : {}),
              ...(turn["reads"] !== undefined
                ? { reads: turn["reads"] as readonly string[] }
                : {}),
            };
          })
        : undefined;
    if (user === undefined && turns === undefined) {
      throw new Error(`${file} cases[${index}]: requires user or turns`);
    }
    if (user !== undefined && turns !== undefined) {
      throw new Error(`${file} cases[${index}]: user and turns are exclusive`);
    }
    return {
      id: String(c["id"]),
      behavior: String(c["behavior"]),
      seed: (c["seed"] as SemanticSeed | undefined) ?? undefined,
      ...(user !== undefined ? { user } : {}),
      ...(turns !== undefined ? { turns } : {}),
      expect: {
        reads: (expect["reads"] as readonly string[] | undefined) ?? undefined,
        ops: (expect["ops"] as readonly SemanticOpExpectation[] | undefined) ?? undefined,
        noMutations: expect["noMutations"] === true,
        effects: (expect["effects"] as SemanticEffects | undefined) ?? undefined,
        noPhantomWork: expect["noPhantomWork"] === true,
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

/** All user phrasings of a case (every turn), for disjointness/overfit pins. */
export function casePhrasings(c: SemanticCase): readonly string[] {
  return c.turns !== undefined ? c.turns.map((t) => t.user) : [c.user!];
}
