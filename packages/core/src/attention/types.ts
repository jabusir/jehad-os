// Attention contract — W1 shared types (ADR-0018; product-reset plan §5).
// Integrator-owned file: lanes build against these types; changes go through
// the integrator (never edit in a lane branch).

export const ATTENTION_LEVELS = ["inbox", "digest", "interrupt"] as const;
export type AttentionLevel = (typeof ATTENTION_LEVELS)[number];
// NO 'silent': an item exists only when it requires attention (ADR-0018 §1.2).

export const ATTENTION_STATES = [
  "open", "seen", "snoozed", "resolved", "dismissed",
] as const;
export type AttentionState = (typeof ATTENTION_STATES)[number];

export const ATTENTION_SAFETY_CLASSES = ["none", "security", "water", "safety"] as const;
export type AttentionSafetyClass = (typeof ATTENTION_SAFETY_CLASSES)[number];

export const ATTENTION_SOURCE_TYPES = ["watch", "outcome", "system"] as const;
export type AttentionSourceType = (typeof ATTENTION_SOURCE_TYPES)[number];

export const ATTENTION_ITEM_KINDS = [
  "outcome.ready", "outcome.blocked", "outcome.failed",
  "watch.match", "system.missed_evidence", "system.scan_gap",
] as const;
export type AttentionItemKind = (typeof ATTENTION_ITEM_KINDS)[number];

/** Producer-supplied per-occurrence identity — NEVER the rendered text, NEVER
 *  the event row id (ADR-0018 §1.4): gmail messageId; home entity_id+last_changed;
 *  outcome id+status. */
export type AttentionChangeFingerprint = string;

export interface AttentionEvidenceRef {
  readonly type: "outcome" | "gmail_message" | "event" | "artifact" | "notification";
  readonly id: string;
}

export const ATTENTION_ACTION_KEYS = [
  "attention.resolve", "attention.dismiss", "attention.snooze",
  "attention.seen", "attention.feedback", "outcome.open",
] as const;
export type AttentionActionKey = (typeof ATTENTION_ACTION_KEYS)[number];

export interface AttentionActionRef {
  readonly key: AttentionActionKey;
  readonly args?: Readonly<Record<string, string | number>>;
}

/** DB row shape for attention_items (migration 029). Timestamps as Date. */
export interface AttentionItemRow {
  readonly id: string;
  readonly principalId: string;
  readonly sourceType: AttentionSourceType;
  readonly sourceObjectId: string;
  readonly fingerprint: string;
  readonly kind: AttentionItemKind;
  readonly state: AttentionState;
  readonly level: AttentionLevel;
  readonly safetyClass: AttentionSafetyClass;
  readonly title: string;
  readonly summary: string;
  readonly whyItMatters: string | null;
  readonly evidenceRefs: readonly AttentionEvidenceRef[];
  readonly actions: readonly AttentionActionRef[];
  readonly occurrences: number;
  readonly changeFingerprint: AttentionChangeFingerprint | null;
  readonly firstRaisedAt: Date;
  readonly updatedAt: Date;
  readonly seenAt: Date | null;
  readonly snoozedUntil: Date | null;
  readonly snoozeCount: number;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: "owner" | "producer" | "liveness" | "system" | null;
  readonly resolutionReason: string | null;
  readonly lastDeliveredAt: Date | null;
  readonly deliveryAttempts: number;
  readonly lastDeliveryAttemptAt: Date | null;
}

/** Input to the three-branch write (ADR-0018 §1.3). */
export interface OpenAttentionInput {
  readonly principalId: string;
  readonly sourceType: AttentionSourceType;
  readonly sourceObjectId: string;
  readonly fingerprint: string;
  readonly kind: AttentionItemKind;
  readonly level: AttentionLevel;
  readonly safetyClass?: AttentionSafetyClass;
  readonly title: string;
  readonly summary: string;
  readonly whyItMatters?: string;
  readonly evidenceRefs?: readonly AttentionEvidenceRef[];
  readonly actions?: readonly AttentionActionRef[];
  readonly changeFingerprint?: AttentionChangeFingerprint;
}

export type OpenAttentionResultAction = "opened" | "bumped" | "reopened";

export interface OpenAttentionResult {
  readonly action: OpenAttentionResultAction;
  readonly item: AttentionItemRow;
  /** true ⇒ the caller should enqueue delivery NOW (salience passed). */
  readonly deliverNow: boolean;
  readonly deferReason: "quiet_hours" | "cooldown" | "unchanged" | "snoozed" | null;
}

/** Deterministic salience decision (ADR-0018 §1.7). Pure; table-tested. */
export interface SalienceDecision {
  readonly deliver: boolean;
  readonly deferReason: "quiet_hours" | "cooldown" | "unchanged" | "snoozed" | null;
}

export type AttentionResolvedBy = "owner" | "producer" | "liveness" | "system";

export type AttentionVerdict = "useful" | "noise" | "missed" | "interruptive";

/** Quiet hours window — America/Los_Angeles, matching the reminders lane. */
export const ATTENTION_QUIET_HOURS = { startHour: 22, endHour: 7 } as const;
/** Default per-item re-delivery cooldown, minutes (plan §12.4). */
export const ATTENTION_DEFAULT_COOLDOWN_MINUTES = 60;
/** Default expiry for disposable watch/system GC decisions (plan §10). */
export const ATTENTION_TERMINAL_RETENTION_DAYS = 30;

/** W1 notification payload contract for kind='attention' (edge-agent renders
 *  title + content + optional todayUrl line; deterministic, no LLM). */
export interface AttentionNotificationPayload {
  readonly content: string;
  readonly whyItMatters?: string;
  readonly todayUrl?: string;
}
