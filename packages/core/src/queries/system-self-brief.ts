// W6(b) — the live self-model (jarvis-v1.md §7 W6 rev3 R9; §12
// Self-Awareness Strategy). A RUNTIME-DERIVED capability/configuration
// snapshot: sensor connectivity + read depth, memory lanes, conversation
// retention facts, persona state, action lanes, and the versioned honest
// limitations list. Nothing here is hand-maintained prose — every value
// is derived at collect time from live sync state, the passed-in policy
// object, and code constants (RAW_RETENTION_MS / ACTIVE_CONTEXT_TTL_MS
// imported from the threads module, so the brief can never drift from
// the retention code or describe an older version of the system).
//
// Read-only by construction: the only SQL is the two staleness sync-state
// SELECTs. Policy arrives as a parameter (the orchestrator already has it
// cached); null/absent policy renders 'unknown' for every policy-derived
// value, never a guess (§5 invariant 11: unknown > fabricated certainty).
//
// The brief describes CAPABILITIES, not vendors: no model ids, no
// handles, no tokens, no principal names ever enter the structured data
// or the render (pinned in tests).

import { UUID_RE } from "../events/envelope.js";
import { ACTIVE_CONTEXT_TTL_MS, RAW_RETENTION_MS } from "../imessage/threads.js";
import { personasPolicyOf, type PolicyV1 } from "../policy/ceiling.js";
import type { QueryExecutor } from "./executor.js";
import { sourceFreshness } from "./staleness.js";
import { SYSTEM_STATE_LIMITATIONS } from "./system-state.js";

export const SELF_BRIEF_COVERAGE =
  "runtime self-description: sensor connectivity and read depth, memory lanes, retention facts, persona and action lanes for this principal; read-only, no credentials, no message or email content";

/**
 * Version of the limitations list rendered in the brief. The list itself
 * REUSES SYSTEM_STATE_LIMITATIONS verbatim (W7's versioned honest list —
 * one source of truth, no parallel prose to maintain).
 */
export const SELF_BRIEF_LIMITATIONS_VERSION = 1;

/** Rendered compactness contract (plan §7 W6(b): "compact ≤12 lines"). */
export const SELF_BRIEF_MAX_LINES = 12;

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Calendar visibility for THIS principal. 'read' = the sensor has synced
 * AND the principal's policy reads include a calendar-bearing source
 * (calendar, or the assembled day.state). 'disconnected' = the assistant
 * has no usable calendar path (never synced, or no read grant — from the
 * conversation's perspective those are the same honest answer). 'unknown'
 * = synced but policy was not supplied (permission undeterminable).
 */
export type SelfBriefCalendarStatus = "read" | "disconnected" | "unknown";

/**
 * Gmail visibility for THIS principal. The conversation read depth is
 * structurally METADATA-ONLY (sender/domain patterns; never subjects or
 * bodies) — 'read' is reserved for a future full-depth gmail read and is
 * unreachable today by design. 'disconnected'/'unknown' as calendar.
 */
export type SelfBriefGmailStatus = "metadata_only" | "read" | "disconnected" | "unknown";

export interface SelfBriefSources {
  readonly calendar: SelfBriefCalendarStatus;
  readonly gmail: SelfBriefGmailStatus;
}

export interface SelfBriefMemory {
  /** Explicit capture lane on for this principal (gateway.capture). */
  readonly explicitCapture: boolean | null;
  /** memory.recall reachable (policy reads include 'memory'). */
  readonly recall: boolean | null;
  /** Structurally false: promotion is always explicit review (ADR-0004). */
  readonly autoPromotion: false;
}

export interface SelfBriefConversation {
  /** Bounded threads are structural in this system (ADR-0014). */
  readonly threads: true;
  /** Derived from RAW_RETENTION_MS — the single retention constant. */
  readonly rawRetentionDays: number;
  /** Derived from ACTIVE_CONTEXT_TTL_MS — the single context constant. */
  readonly workingContextHours: number;
}

export interface SelfBriefPersona {
  /** Personas policy on + this principal allowlisted. */
  readonly enabled: boolean | null;
  /**
   * Self-configuration reachable for this principal (same personas gate —
   * the propose→confirm self-profile path; presentation only, never
   * authority). Extends to profile behavior flags when W6(a) lands them.
   */
  readonly selfModify: boolean | null;
  /** Structural: cross-principal profile changes need the owner + approve. */
  readonly otherPrincipalModify: "owner_approval";
  /** Active (principal, surface) profile version, when the caller knows it. */
  readonly activeProfileVersion: number | null;
}

export interface SelfBriefActions {
  /** Calendar write lane on for this principal (gateway.actions). */
  readonly calendarWrite: boolean | null;
  /**
   * Canonical commitment writes reachable: capture lane AND review
   * confirm (capture → review → promotion writer is the only path that
   * INSERTs commitments in this system; W5 verbs then track status).
   */
  readonly commitmentTracking: boolean | null;
}

export interface SelfBriefData {
  readonly principalId: string;
  readonly now: string;
  readonly sources: SelfBriefSources;
  readonly memory: SelfBriefMemory;
  readonly conversation: SelfBriefConversation;
  readonly persona: SelfBriefPersona;
  readonly actions: SelfBriefActions;
  readonly limits: readonly string[];
}

export interface CollectSelfBriefInput {
  readonly principalId: string;
  /** Needed to evaluate every name-scoped policy gate; absent → unknown. */
  readonly principalName?: string;
  readonly now?: () => Date;
  /** The orchestrator's cached policy; null/absent → 'unknown', never guess. */
  readonly policy?: PolicyV1 | null;
  /** Active profile version (e.g. from activeProfile()); null = none/unknown. */
  readonly activeProfileVersion?: number | null;
}

/** The name/policy-derived gates, with null = unknown (never a guess). */
interface PolicyView {
  readonly reads: readonly string[] | null;
  readonly captureOn: boolean | null;
  readonly reviewOn: boolean | null;
  readonly actionsOn: boolean | null;
  readonly personasOn: boolean | null;
}

const UNKNOWN_VIEW: PolicyView = {
  reads: null,
  captureOn: null,
  reviewOn: null,
  actionsOn: null,
  personasOn: null,
};

function policyView(
  policy: PolicyV1 | null | undefined,
  principalName: string | undefined,
): PolicyView {
  const name = principalName?.trim();
  if (policy == null || name === undefined || name.length === 0) return UNKNOWN_VIEW;
  const principal = policy.gateway?.principals[name] ?? null;
  const capture = policy.gateway?.capture;
  const review = policy.gateway?.review;
  const actions = policy.gateway?.actions;
  const personas = personasPolicyOf(policy);
  return {
    reads: principal === null ? [] : [...principal.reads],
    captureOn: capture !== undefined && capture.enabled && capture.principals.includes(name),
    reviewOn: review !== undefined && review.enabled && review.principals.includes(name),
    actionsOn: actions !== undefined && actions.enabled && actions.principals.includes(name),
    personasOn: personas.enabled && personas.principals.includes(name),
  };
}

function andTri(a: boolean | null, b: boolean | null): boolean | null {
  if (a === null || b === null) return null;
  return a && b;
}

function calendarStatus(connected: boolean, view: PolicyView): SelfBriefCalendarStatus {
  if (!connected) return "disconnected";
  if (view.reads === null) return "unknown";
  return view.reads.includes("calendar") || view.reads.includes("state")
    ? "read"
    : "disconnected";
}

function gmailStatus(connected: boolean, view: PolicyView): SelfBriefGmailStatus {
  if (!connected) return "disconnected";
  if (view.reads === null) return "unknown";
  return view.reads.includes("gmail") ? "metadata_only" : "disconnected";
}

export async function collectSelfBrief(
  db: QueryExecutor,
  input: CollectSelfBriefInput,
): Promise<SelfBriefData> {
  if (!UUID_RE.test(input.principalId)) {
    throw new TypeError("principalId must be a uuid");
  }
  const now = input.now?.() ?? new Date();
  const nowFn = (): Date => now;
  const freshness = await sourceFreshness(db, input.principalId, { now: nowFn });
  const calendar = freshness[0];
  const gmail = freshness[1];
  if (calendar === undefined || gmail === undefined) {
    throw new Error("collectSelfBrief: sourceFreshness must return calendar and gmail entries");
  }
  const view = policyView(input.policy ?? null, input.principalName);
  return {
    principalId: input.principalId,
    now: now.toISOString(),
    sources: {
      calendar: calendarStatus(calendar.lastSyncedAt !== null, view),
      gmail: gmailStatus(gmail.lastSyncedAt !== null, view),
    },
    memory: {
      explicitCapture: view.captureOn,
      recall: view.reads?.includes("memory") ?? null,
      autoPromotion: false,
    },
    conversation: {
      threads: true,
      rawRetentionDays: RAW_RETENTION_MS / MS_PER_DAY,
      workingContextHours: ACTIVE_CONTEXT_TTL_MS / MS_PER_HOUR,
    },
    persona: {
      enabled: view.personasOn,
      selfModify: view.personasOn,
      otherPrincipalModify: "owner_approval",
      activeProfileVersion: input.activeProfileVersion ?? null,
    },
    actions: {
      calendarWrite: view.actionsOn,
      commitmentTracking: andTri(view.captureOn, view.reviewOn),
    },
    limits: [...SYSTEM_STATE_LIMITATIONS],
  };
}

function tri(value: boolean | null): string {
  if (value === null) return "unknown";
  return value ? "on" : "off";
}

function gmailPhrase(status: SelfBriefGmailStatus): string {
  return status === "metadata_only"
    ? "metadata_only (sender patterns only — never subjects or bodies)"
    : status;
}

/**
 * Deterministic compact render (≤ SELF_BRIEF_MAX_LINES), provenance-labeled
 * header, no model ids, no handles, no tokens, no principal names. Pure:
 * derived only from the structured brief.
 */
export function renderSelfBrief(brief: SelfBriefData): string {
  const lines = [
    "SELF-BRIEF (runtime state — answer capability questions from THIS, not memory)",
    `sources: calendar ${brief.sources.calendar}; gmail ${gmailPhrase(brief.sources.gmail)}`,
    `memory: explicit capture ${tri(brief.memory.explicitCapture)}; recall ${tri(
      brief.memory.recall,
    )}; promotion never automatic (explicit review only)`,
    `conversation: bounded iMessage threads; working context ${brief.conversation.workingContextHours}h; raw messages kept ${brief.conversation.rawRetentionDays}d`,
    `persona: ${tri(brief.persona.enabled)}${
      brief.persona.activeProfileVersion === null
        ? " (no active profile)"
        : ` (active profile v${brief.persona.activeProfileVersion})`
    }; self-modify ${tri(brief.persona.selfModify)} via propose+confirm; other principals: owner approval only`,
    `actions: calendar write ${tri(brief.actions.calendarWrite)} (always confirm-gated); commitment capture ${tri(brief.actions.commitmentTracking)} — when the user asks to be reminded or to track something, that works (propose, then they confirm)`,
    `limits: ${brief.limits.join("; ")}`,
    `as of ${brief.now} — unknown means not determined; never guess`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * Prompt rules shipped alongside the brief (W6(b): capability/config
 * questions are answered ONLY from the brief; the metadata-only limit is
 * stated immediately when pertinence/judgment is asked; the system is
 * never described from an older version).
 */
export const SELF_BRIEF_HONESTY_RULES: readonly string[] = [
  "Answer capability and configuration questions ('what can you see/do/remember?', 'are you connected to …?') ONLY from the SELF-BRIEF block in this prompt — never from memory of earlier turns and never from assumptions about assistants.",
  "When the brief says a source is metadata_only, state that limit immediately whenever pertinence, depth, or judgment about that source is asked — before anything else about it.",
  "'unknown' in the brief means not determined: say so plainly; never guess and never fill the gap from general knowledge.",
  "The brief is the system as it is right now: never describe an older version, another deployment, or a planned capability as current.",
];
