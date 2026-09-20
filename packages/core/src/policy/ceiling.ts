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
  /** E4 notification delivery policy; absent → code defaults apply. */
  notifications?: NotificationsPolicyV1;
  /** iMessage gateway principal budgets (multi-principal Lane P); absent → deny. */
  gateway?: GatewayPolicyV1;
}

/**
 * The `notifications:` section (E4 OpenClaw attach). Fail-closed like the
 * ceiling: unknown keys or malformed values are parser errors, never silent
 * permissiveness.
 */
export interface NotificationsPolicyV1 {
  /** Notification kinds that land status=approved at creation. */
  autoApproveKinds: readonly string[];
  /** Escalation raises enqueue a notification only at/above this urgency. */
  escalationMinUrgency: "low" | "medium" | "high" | "critical" | "blocker";
  /** Delivery window (minutes) stamped on new notifications as expires_at. */
  defaultTtlMinutes: number;
}

/**
 * The `gateway:` section (iMessage multi-principal onboarding, Lane P):
 * per-principal conversational budgets keyed by principal NAME. Absent
 * principal → the conversation handler denies (fail closed) — the section
 * existing but naming no principal is exactly "no converse budget".
 */
export interface GatewayPolicyV1 {
  readonly principals: Readonly<Record<string, GatewayPrincipalPolicy>>;
  /** Phase F capture config (gateway.capture); absent → module default. */
  readonly capture?: GatewayCapturePolicy;
  /** Phase G review/control config (gateway.review); absent → module default. */
  readonly review?: GatewayReviewPolicy;
  /** Phase H action-lane config (gateway.actions); absent → module default. */
  readonly actions?: GatewayActionsPolicy;
}

export interface GatewayPrincipalPolicy {
  /** OpenRouter model id (must be egress-allowlisted for personal/normal). */
  readonly model: string;
  /** Max conversation model_calls per rolling hour (principal × surface). */
  readonly requestsPerHour: number;
  /** Max conversation model spend per UTC day, USD (principal × surface). */
  readonly costPerDay: number;
  /**
   * Phase E grounded reads — data sources this principal's conversation
   * may query (ig-phase-e-contracts.md §3). Absent → no tools (fail
   * closed). Only ever grantable to the world-model owner.
   */
  readonly reads: readonly string[];
}

/** Valid Phase E read sources (fail-closed parse: unknown names throw). */
export const READ_SOURCES = ["calendar", "commitments"] as const;

/**
 * Phase F capture policy — `gateway.capture` (ig-phase-f-contracts.md §8):
 * `{ enabled: <bool>, principals: [name, …], max_per_hour: <int>,
 * dedupe_window_hours: <int> }` in that key order. Strict shape; anything
 * else throws (fail closed).
 */
export interface GatewayCapturePolicy {
  readonly enabled: boolean;
  readonly principals: readonly string[];
  readonly maxPerHour: number;
  readonly dedupeWindowHours: number;
}

export function parseGatewayCaptureEntry(value: string): GatewayCapturePolicy {
  const m = value.match(
    /^\{\s*enabled:\s*(true|false),\s*principals:\s*\[([A-Za-z0-9_,\s]*)\],\s*max_per_hour:\s*(\d+),\s*dedupe_window_hours:\s*(\d+)\s*\}$/,
  );
  if (m === null) {
    throw new Error(
      `policy: gateway.capture must be "{ enabled: <bool>, principals: [name, …], max_per_hour: <int>, dedupe_window_hours: <int> }" (got '${value}')`,
    );
  }
  const maxPerHour = Number(m[3]);
  const dedupeWindowHours = Number(m[4]);
  if (maxPerHour <= 0 || dedupeWindowHours <= 0) {
    throw new Error("policy: gateway.capture caps must be positive");
  }
  return {
    enabled: m[1] === "true",
    principals: [...new Set((m[2] ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0))],
    maxPerHour,
    dedupeWindowHours,
  };
}

/**
 * Phase G review/control policy — `gateway.review`
 * (ig-phase-g-contracts.md §7): `{ enabled: <bool>, principals: [name, …],
 * max_bad_refs: <int>, snooze_hours: <int>, ref_ttl_hours: <int>,
 * digest_max_candidates: <int>, digest_max_escalations: <int> }` in that
 * key order. Strict shape; anything else throws (fail closed).
 */
export interface GatewayReviewPolicy {
  readonly enabled: boolean;
  readonly principals: readonly string[];
  readonly maxBadRefs: number;
  readonly snoozeHours: number;
  readonly refTtlHours: number;
  readonly digestMaxCandidates: number;
  readonly digestMaxEscalations: number;
}

export function parseGatewayReviewEntry(value: string): GatewayReviewPolicy {
  const m = value.match(
    /^\{\s*enabled:\s*(true|false),\s*principals:\s*\[([A-Za-z0-9_,\s]*)\],\s*max_bad_refs:\s*(\d+),\s*snooze_hours:\s*(\d+),\s*ref_ttl_hours:\s*(\d+),\s*digest_max_candidates:\s*(\d+),\s*digest_max_escalations:\s*(\d+)\s*\}$/,
  );
  if (m === null) {
    throw new Error(
      `policy: gateway.review must be "{ enabled: <bool>, principals: [name, …], max_bad_refs: <int>, snooze_hours: <int>, ref_ttl_hours: <int>, digest_max_candidates: <int>, digest_max_escalations: <int> }" (got '${value}')`,
    );
  }
  const [maxBadRefs, snoozeHours, refTtlHours, digestMaxCandidates, digestMaxEscalations] = [
    Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]),
  ];
  if (maxBadRefs <= 0 || snoozeHours <= 0 || refTtlHours <= 0 || digestMaxCandidates <= 0 || digestMaxEscalations <= 0) {
    throw new Error("policy: gateway.review values must be positive");
  }
  return {
    enabled: m[1] === "true",
    principals: [...new Set((m[2] ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0))],
    maxBadRefs,
    snoozeHours,
    refTtlHours,
    digestMaxCandidates,
    digestMaxEscalations,
  };
}

/**
 * Phase H action-lane policy — `gateway.actions`
 * (ig-phase-h-contracts.md §7): `{ enabled: <bool>, principals: [name, …],
 * max_proposals_per_day: <int>, max_dispatches_per_day: <int>,
 * confirm_ttl_minutes: <int> }` in that key order. Strict shape mirroring
 * gateway.capture; anything else throws (fail closed). Confirmation is
 * ALWAYS required — there is deliberately no key that could disable it.
 */
export interface GatewayActionsPolicy {
  readonly enabled: boolean;
  readonly principals: readonly string[];
  /** Proposal flood bound (UTC day, per principal) — never disables confirm. */
  readonly maxProposalsPerDay: number;
  /** Confirmed-dispatch flood bound (UTC day, per principal). */
  readonly maxDispatchesPerDay: number;
  /** Confirm-token TTL in minutes (expiry cancels the intent). */
  readonly confirmTtlMinutes: number;
}

export function parseGatewayActionsEntry(value: string): GatewayActionsPolicy {
  const m = value.match(
    /^\{\s*enabled:\s*(true|false),\s*principals:\s*\[([A-Za-z0-9_,\s]*)\],\s*max_proposals_per_day:\s*(\d+),\s*max_dispatches_per_day:\s*(\d+),\s*confirm_ttl_minutes:\s*(\d+)\s*\}$/,
  );
  if (m === null) {
    throw new Error(
      `policy: gateway.actions must be "{ enabled: <bool>, principals: [name, …], max_proposals_per_day: <int>, max_dispatches_per_day: <int>, confirm_ttl_minutes: <int> }" (got '${value}')`,
    );
  }
  const maxProposalsPerDay = Number(m[3]);
  const maxDispatchesPerDay = Number(m[4]);
  const confirmTtlMinutes = Number(m[5]);
  if (maxProposalsPerDay <= 0 || maxDispatchesPerDay <= 0 || confirmTtlMinutes <= 0) {
    throw new Error("policy: gateway.actions caps must be positive");
  }
  return {
    enabled: m[1] === "true",
    principals: [...new Set((m[2] ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0))],
    maxProposalsPerDay,
    maxDispatchesPerDay,
    confirmTtlMinutes,
  };
}

/**
 * Strict flow-mapping parse for one gateway principal entry — exactly
 * `{ model: <id>, requests_per_hour: <int>, cost_per_day: <number> }`,
 * optionally followed by `, reads: [source, …]` (ig-phase-e-contracts.md
 * §3), in that key order. Anything else throws.
 */
export function parseGatewayPrincipalEntry(
  name: string,
  value: string,
): GatewayPrincipalPolicy {
  const match = value.match(
    /^\{\s*model:\s*([A-Za-z0-9._/-]+),\s*requests_per_hour:\s*(\d+),\s*cost_per_day:\s*(\d+(?:\.\d+)?)(?:,\s*reads:\s*\[([A-Za-z0-9_,\s]*)\])?\s*\}$/,
  );
  if (match === null) {
    throw new Error(
      `policy: gateway.principals.${name} must be "{ model: <id>, requests_per_hour: <int>, cost_per_day: <number>[, reads: [source, …]] }" (got '${value}')`,
    );
  }
  const requestsPerHour = Number(match[2]);
  const costPerDay = Number(match[3]);
  if (requestsPerHour <= 0 || costPerDay <= 0) {
    throw new Error(`policy: gateway.principals.${name} caps must be positive`);
  }
  const reads = (match[4] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const source of reads) {
    if (!(READ_SOURCES as readonly string[]).includes(source)) {
      throw new Error(
        `policy: gateway.principals.${name} reads: unknown source '${source}' (valid: ${READ_SOURCES.join(", ")})`,
      );
    }
  }
  return { model: match[1]!, requestsPerHour, costPerDay, reads: [...new Set(reads)] };
}

const URGENCY_VALUES = ["low", "medium", "high", "critical", "blocker"] as const;

function parseFlowStringList(key: string, value: string): readonly string[] {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw new Error(`policy: notifications.${key} must be a ["a", "b"] style list`);
  }
  const inner = value.slice(1, -1).trim();
  if (inner === "") throw new Error(`policy: notifications.${key} must not be empty`);
  const items: string[] = [];
  for (const raw of inner.split(",")) {
    const token = raw.trim();
    if (!/^"[^"]*"$/.test(token) || token.slice(1, -1).length === 0) {
      throw new Error(`policy: notifications.${key} entries must be non-empty double-quoted strings`);
    }
    items.push(token.slice(1, -1));
  }
  if (new Set(items).size !== items.length) {
    throw new Error(`policy: notifications.${key} contains duplicates`);
  }
  return items;
}

function parseNotificationsSection(
  entries: Array<{ key: string; value: string }>,
): NotificationsPolicyV1 {
  const section: Partial<NotificationsPolicyV1> = {};
  for (const { key, value } of entries) {
    if (key === "autoApproveKinds") {
      if (section.autoApproveKinds !== undefined) {
        throw new Error("policy: duplicate notifications.autoApproveKinds key");
      }
      section.autoApproveKinds = parseFlowStringList(key, value);
    } else if (key === "escalationMinUrgency") {
      if (section.escalationMinUrgency !== undefined) {
        throw new Error("policy: duplicate notifications.escalationMinUrgency key");
      }
      if (!(URGENCY_VALUES as readonly string[]).includes(value)) {
        throw new Error(`policy: invalid urgency '${value}' for notifications.escalationMinUrgency`);
      }
      section.escalationMinUrgency = value as NotificationsPolicyV1["escalationMinUrgency"];
    } else if (key === "defaultTtlMinutes") {
      if (section.defaultTtlMinutes !== undefined) {
        throw new Error("policy: duplicate notifications.defaultTtlMinutes key");
      }
      if (!/^\d+$/.test(value) || Number(value) <= 0) {
        throw new Error("policy: notifications.defaultTtlMinutes must be a positive integer");
      }
      section.defaultTtlMinutes = Number(value);
    } else {
      throw new Error(`policy: unknown notifications key '${key}'`);
    }
  }
  return {
    autoApproveKinds: section.autoApproveKinds ?? ["brief"],
    escalationMinUrgency: section.escalationMinUrgency ?? "high",
    defaultTtlMinutes: section.defaultTtlMinutes ?? 240,
  };
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
  let section: "autonomy_ceiling" | "notifications" | "gateway" | null = null;
  let sawCeiling = false;
  let sawNotifications = false;
  let sawGateway = false;
  let inGatewayPrincipals = false;
  const notificationEntries: Array<{ key: string; value: string }> = [];
  const gatewayPrincipals: Record<string, GatewayPrincipalPolicy> = {};
  const gatewayCapture: { value: GatewayCapturePolicy | null } = { value: null };
  const gatewayReview: { value: GatewayReviewPolicy | null } = { value: null };
  const gatewayActions: { value: GatewayActionsPolicy | null } = { value: null };

  for (const rawLine of text.split("\n")) {
    const line = stripComment(rawLine);
    if (line.trim() === "") continue;

    const indented = line.startsWith(" ");
    const [rawKey, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const key = rawKey?.trim() ?? "";

    if (!indented) {
      section = null;
      inGatewayPrincipals = false;
      if (key === "version") {
        if (version !== undefined) throw new Error("policy: duplicate version key");
        if (value !== "1") throw new Error(`policy: unsupported version ${String(value)}`);
        version = 1;
      } else if (key === "autonomy_ceiling") {
        if (value !== "") throw new Error("policy: autonomy_ceiling must be a mapping");
        if (sawCeiling) throw new Error("policy: duplicate autonomy_ceiling key");
        sawCeiling = true;
        section = "autonomy_ceiling";
      } else if (key === "notifications") {
        if (value !== "") throw new Error("policy: notifications must be a mapping");
        if (sawNotifications) throw new Error("policy: duplicate notifications key");
        sawNotifications = true;
        section = "notifications";
      } else if (key === "gateway") {
        if (value !== "") throw new Error("policy: gateway must be a mapping");
        if (sawGateway) throw new Error("policy: duplicate gateway key");
        sawGateway = true;
        section = "gateway";
      } else {
        throw new Error(`policy: unknown top-level key '${key}'`);
      }
      continue;
    }

    if (section === null) {
      throw new Error(`policy: unexpected indented line '${line.trim()}'`);
    }
    if (section === "notifications") {
      notificationEntries.push({ key, value });
      continue;
    }
    if (section === "gateway") {
      if (inGatewayPrincipals) {
        if (key === "principals") throw new Error("policy: duplicate gateway.principals key");
        if (gatewayPrincipals[key] !== undefined) {
          throw new Error(`policy: duplicate gateway principal '${key}'`);
        }
        gatewayPrincipals[key] = parseGatewayPrincipalEntry(key, value);
        continue;
      }
      if (key === "principals") {
        if (value !== "") throw new Error("policy: gateway.principals must be a mapping");
        inGatewayPrincipals = true;
        continue;
      }
      if (key === "capture") {
        if (gatewayCapture.value !== null) throw new Error("policy: duplicate gateway.capture key");
        gatewayCapture.value = parseGatewayCaptureEntry(value);
        continue;
      }
      if (key === "review") {
        if (gatewayReview.value !== null) throw new Error("policy: duplicate gateway.review key");
        gatewayReview.value = parseGatewayReviewEntry(value);
        continue;
      }
      if (key === "actions") {
        if (gatewayActions.value !== null) throw new Error("policy: duplicate gateway.actions key");
        gatewayActions.value = parseGatewayActionsEntry(value);
        continue;
      }
      throw new Error(`policy: unknown gateway key '${key}'`);
    }
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
  const policy: PolicyV1 = { version: 1, autonomy_ceiling: ceiling as Record<ActionType, AutonomyLevel> };
  if (notificationEntries.length > 0) {
    policy.notifications = parseNotificationsSection(notificationEntries);
  }
  if (sawGateway) {
    policy.gateway = {
      principals: gatewayPrincipals,
      ...(gatewayCapture.value !== null ? { capture: gatewayCapture.value } : {}),
      ...(gatewayReview.value !== null ? { review: gatewayReview.value } : {}),
      ...(gatewayActions.value !== null ? { actions: gatewayActions.value } : {}),
    };
  }
  return policy;
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
