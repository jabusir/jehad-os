// Attention action registry (ADR-0018 §1.6; W1 contract). Items store only
// typed {key, args} pairs — NEVER endpoint strings or URLs; this server-side
// registry maps keys to descriptors with per-action argument validators.
// Labels are server-provided constants, never row-provided text (the row is
// producer input and only the registry speaks for the UI).

import type { AttentionActionKey, AttentionVerdict } from "./types.js";

export interface AttentionActionDescriptor {
  readonly kind: "resolve" | "dismiss" | "snooze" | "seen" | "feedback" | "link";
  readonly defaultArgs?: Readonly<Record<string, string | number>>;
  validateArgs(args?: Readonly<Record<string, string | number>>): boolean;
  label(args?: Readonly<Record<string, string | number>>): string;
}

const VERDICTS: readonly AttentionVerdict[] = ["useful", "noise", "missed", "interruptive"];

function isPositiveMinutes(args?: Readonly<Record<string, string | number>>): boolean {
  const minutes = args?.minutes;
  if (minutes === undefined) return true; // absent → defaultArgs applies
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0;
}

export const ATTENTION_ACTION_REGISTRY: Record<AttentionActionKey, AttentionActionDescriptor> = {
  "attention.resolve": {
    kind: "resolve",
    validateArgs: () => true,
    label: () => "Resolve",
  },
  "attention.dismiss": {
    kind: "dismiss",
    validateArgs: () => true,
    label: () => "Dismiss",
  },
  "attention.snooze": {
    kind: "snooze",
    defaultArgs: { minutes: 60 },
    validateArgs: isPositiveMinutes,
    label: (args) => `Snooze ${args?.minutes ?? 60}m`,
  },
  "attention.seen": {
    kind: "seen",
    validateArgs: () => true,
    label: () => "Mark seen",
  },
  "attention.feedback": {
    kind: "feedback",
    validateArgs: (args) =>
      args !== undefined &&
      VERDICTS.includes(args.verdict as AttentionVerdict),
    label: (args) => (args !== undefined ? `Feedback: ${String(args.verdict)}` : "Feedback"),
  },
  "outcome.open": {
    kind: "link",
    validateArgs: (args) =>
      args !== undefined && typeof args.ref === "string" && args.ref.trim().length > 0,
    label: () => "Open outcome",
  },
};

/** Fail-closed lookup: an unknown key has NO descriptor (null), never a guess. */
export function getActionDescriptor(key: string): AttentionActionDescriptor | null {
  return Object.hasOwn(ATTENTION_ACTION_REGISTRY, key)
    ? ATTENTION_ACTION_REGISTRY[key as AttentionActionKey]
    : null;
}
