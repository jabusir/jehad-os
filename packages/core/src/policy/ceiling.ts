// packages/core/src/policy/ceiling.ts — policy.yaml v1 autonomy ceiling
// (policy-model.md §4; ADR-0007 item 4; §35 pattern).
//
// The ceiling is data, not model judgment: a strict, versioned, fail-closed
// parser for the fixed v1 shape (a `version` scalar plus one nested
// `autonomy_ceiling` mapping). No YAML library dependency — the schema is
// ours, closed, and anything that does not match it exactly is an error, so
// policy can never silently degrade into permissiveness.

import { readFile } from "node:fs/promises";

export const AUTONOMY_LEVELS = [
  "autonomous",
  "gated",
  "approval_required",
  "prohibited",
] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const ACTION_TYPES = [
  "read",
  "propose",
  "write_canonical",
  "external_side_effect",
  "money_and_contracts",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface PolicyV1 {
  version: 1;
  autonomy_ceiling: Readonly<Record<ActionType, AutonomyLevel>>;
}

export type AutonomyDecision =
  | { allowed: true; level: AutonomyLevel }
  | { allowed: false; level: AutonomyLevel; reason: string };

export interface AutonomyContext {
  /** True only when an explicit approval exists (action_intents approved). */
  approved?: boolean;
  /** True only when the write qualifies under the promotion gate (plan §6.2). */
  gatePassed?: boolean;
}

function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return (
    typeof value === "string" &&
    (AUTONOMY_LEVELS as readonly string[]).includes(value)
  );
}

function isActionType(value: unknown): value is ActionType {
  return (
    typeof value === "string" &&
    (ACTION_TYPES as readonly string[]).includes(value)
  );
}

function stripComment(line: string): string {
  const hash = line.indexOf("#");
  return (hash >= 0 ? line.slice(0, hash) : line).trimEnd();
}

/**
 * Parses policy.yaml text. Fails closed: throws on any structural deviation —
 * wrong version, unknown or duplicate keys, missing action types, invalid
 * levels, or anything beyond the fixed v1 shape.
 */
export function parsePolicyV1(text: string): PolicyV1 {
  const ceiling: Partial<Record<ActionType, AutonomyLevel>> = {};
  let version: number | undefined;
  let inCeiling = false;
  let sawCeiling = false;

  for (const rawLine of text.split("\n")) {
    const line = stripComment(rawLine);
    if (line.trim() === "") continue;

    const indented = line.startsWith(" ");
    const [rawKey, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const key = rawKey?.trim() ?? "";

    if (!indented) {
      inCeiling = false;
      if (key === "version") {
        if (version !== undefined) throw new Error("policy: duplicate version key");
        if (value !== "1") throw new Error(`policy: unsupported version ${String(value)}`);
        version = 1;
      } else if (key === "autonomy_ceiling") {
        if (value !== "") throw new Error("policy: autonomy_ceiling must be a mapping");
        if (sawCeiling) throw new Error("policy: duplicate autonomy_ceiling key");
        sawCeiling = true;
        inCeiling = true;
      } else {
        throw new Error(`policy: unknown top-level key '${key}'`);
      }
      continue;
    }

    if (!inCeiling) throw new Error(`policy: unexpected indented line '${line.trim()}'`);
    if (!isActionType(key)) throw new Error(`policy: unknown action type '${key}'`);
    if (ceiling[key] !== undefined) throw new Error(`policy: duplicate action type '${key}'`);
    if (!isAutonomyLevel(value)) {
      throw new Error(`policy: invalid autonomy level '${value}' for '${key}'`);
    }
    ceiling[key] = value;
  }

  if (version !== 1) throw new Error("policy: missing version: 1");
  if (!sawCeiling) throw new Error("policy: missing autonomy_ceiling mapping");
  for (const actionType of ACTION_TYPES) {
    if (ceiling[actionType] === undefined) {
      throw new Error(`policy: autonomy_ceiling is missing '${actionType}'`);
    }
  }
  return { version: 1, autonomy_ceiling: ceiling as Record<ActionType, AutonomyLevel> };
}

/** Loads and parses a policy.yaml file from disk. Fails closed on any error. */
export async function loadPolicyFile(path: string | URL): Promise<PolicyV1> {
  return parsePolicyV1(await readFile(path, "utf8"));
}

/** The configured ceiling for an action type. Unknown types throw. */
export function autonomyLevelFor(policy: PolicyV1, actionType: ActionType): AutonomyLevel {
  return policy.autonomy_ceiling[actionType];
}

/**
 * Decides whether an action of `actionType` may proceed under the ceiling.
 * - autonomous → allowed
 * - gated → allowed only with an explicit passed gate (plan §6.2 exceptions)
 * - approval_required → allowed only with an explicit approval on record
 * - prohibited → never allowed — approval does not override prohibition
 * Unknown action types (uncaught by typing) deny fail-closed.
 */
export function decideAutonomy(
  policy: PolicyV1,
  actionType: string,
  context: AutonomyContext = {},
): AutonomyDecision {
  if (!isActionType(actionType)) {
    return { allowed: false, level: "prohibited", reason: "unknown_action_type" };
  }
  const level = policy.autonomy_ceiling[actionType];
  switch (level) {
    case "autonomous":
      return { allowed: true, level };
    case "gated":
      return context.gatePassed === true
        ? { allowed: true, level }
        : { allowed: false, level, reason: "gate_not_passed" };
    case "approval_required":
      return context.approved === true
        ? { allowed: true, level }
        : { allowed: false, level, reason: "approval_required" };
    case "prohibited":
      return { allowed: false, level, reason: "prohibited_by_policy" };
  }
}
