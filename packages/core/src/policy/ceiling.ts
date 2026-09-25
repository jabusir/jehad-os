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
  /**
   * Sensor config (GMAIL; plan gmail-sensor-contracts §5/§10.3). Absent →
   * module defaults with enabled:false (fail-safe: the kill switch holds
   * until the owner ratifies the section).
   */
  sensors?: SensorsPolicyV1;
  /**
   * Calibration domain config (Lane C1 — the daily accuracy check). Absent
   * → module default with enabled:false + no principals (fail-safe: no
   * daily check until the owner ratifies the section).
   */
  calibration?: CalibrationPolicy;
  /** `outcomes:` (D0, roadmap §5; ADR-0017). */
  outcomes?: OutcomesPolicy;
  /** `workers:` (D1, roadmap §8): the worker contract's autonomy ceiling. */
  workers?: WorkersPolicy;
  /**
   * W4 interaction-profile config — the SECURITY/DEFAULT LAYER ONLY
   * (jarvis-v1.md §7 W4 rev2 R2; §5 invariant 2): the on/off flag and the
   * principals allowed to hold conversation profiles. Deliberately nothing
   * else — no prompt text, no register/brevity/address content; profile
   * content is versioned data in interaction_profiles. Absent → disabled
   * + empty principals (profiles stay inert).
   */
  personas?: PersonasPolicy;
}

/**
 * The `sensors:` section — per-sensor policy keyed by sensor name. Strict
 * fail-closed parse like every other section: unknown sensor keys throw.
 */
export interface SensorsPolicyV1 {
  /** `sensors.gmail` (§5 sender policy, §10.3 shape). */
  readonly gmail?: GmailSensorPolicy;
}

/**
 * policy.yaml `sensors.gmail` (gmail-sensor-contracts §5/§10.3): metadata
 * ingest for ALL senders; DETERMINISTIC extraction only for senders
 * matching `extract_senders` globs over the From address. Defaults are
 * fail-safe: disabled, no extraction senders, owner-ratifiable caps.
 */
export interface GmailSensorPolicy {
  /** Kill switch (§9.4): false halts the sensor without touching credentials. */
  readonly enabled: boolean;
  /**
   * Poll cadence (cron). OWNED BY THE WORKFLOW LANE (G3) — core ignores it;
   * null = the workflow's own default cadence applies.
   */
  readonly pollCron: string | null;
  /** Bootstrap window in days (§3.4 / ESCALATE-3; default 30). */
  readonly bootstrapDays: number;
  /** Extraction allowlist globs over the From address (§5.1; default none). */
  readonly extractSenders: readonly string[];
  /** Flood/quota cap per poll (§9.3; default 50). */
  readonly maxMessagesPerPoll: number;
  /** Candidate-lane flood cap per UTC day (§6.6; default 20). */
  readonly maxCandidatesPerDay: number;
  /**
   * `gmail.content` class (ADR-0016): bounded body ingestion. Fail-safe
   * default OFF; retention window + byte cap ride along (O-9 default 14d).
   */
  readonly contentEnabled: boolean;
  readonly contentRetentionDays: number;
  readonly contentMaxBodyBytes: number;
}

/** §10.3 defaults — fail-safe (disabled) until the owner ratifies. */
export const DEFAULT_GMAIL_SENSOR_POLICY: GmailSensorPolicy = {
  enabled: false,
  pollCron: null,
  bootstrapDays: 30,
  extractSenders: [],
  maxMessagesPerPoll: 50,
  maxCandidatesPerDay: 20,
  contentEnabled: false,
  contentRetentionDays: 7,
  contentMaxBodyBytes: 256 * 1024,
};

/**
 * The `calibration:` section (Lane C1): `{ enabled: <bool>, principals:
 * [name, …], prompt_local_hour: <int 0-23> }` — whether the daily accuracy
 * check runs, for whom, and at what owner-local hour the prompt is sent.
 * Copy (prompt text) lives in code, deliberately not in policy. Defaults
 * are fail-safe: disabled, no principals (the kill switch holds until the
 * owner ratifies the section).
 */
export interface CalibrationPolicy {
  readonly enabled: boolean;
  readonly principals: readonly string[];
  /** Owner-local hour (0-23, BRIEF_TIMEZONE) the daily prompt is sent. */
  readonly promptLocalHour: number;
}

/** Fail-safe defaults — disabled + empty principals. */
export const DEFAULT_CALIBRATION_POLICY: CalibrationPolicy = {
  enabled: false,
  principals: [],
  promptLocalHour: 19,
};

/**
 * The `outcomes:` section (D0; roadmap §5; ADR-0017): intake + executor
 * gating and per-principal bounds. Exactly the four keys in that order
 * (strict shape; the calibration.daily pattern). Defaults are fail-safe:
 * disabled — the owner ratifies the section to open Delegate intake.
 */
export interface OutcomesPolicy {
  readonly enabled: boolean;
  readonly maxActivePerPrincipal: number;
  readonly defaultBudgetUsd: number;
  readonly defaultDeadlineDays: number;
}

/** Fail-safe defaults — disabled; conservative bounds when enabled. */
export const DEFAULT_OUTCOMES_POLICY: OutcomesPolicy = {
  enabled: false,
  maxActivePerPrincipal: 3,
  defaultBudgetUsd: 5,
  defaultDeadlineDays: 14,
};

/**
 * `outcomes` flow-mapping parse — exactly
 * `{ enabled: <bool>, max_active_per_principal: <int>, default_budget_usd: <int>, default_deadline_days: <int> }`.
 * Caps must be positive; anything else throws (fail closed).
 */
export function parseOutcomesEntry(value: string): OutcomesPolicy {
  const m = value.match(
    /^\{\s*enabled:\s*(true|false),\s*max_active_per_principal:\s*(\d+),\s*default_budget_usd:\s*(\d+),\s*default_deadline_days:\s*(\d+)\s*\}$/,
  );
  if (m === null) {
    throw new Error(
      `policy: outcomes must be "{ enabled: <bool>, max_active_per_principal: <int>, default_budget_usd: <int>, default_deadline_days: <int> }" (got '${value}')`,
    );
  }
  const [maxActive, budget, deadline] = [Number(m[2]), Number(m[3]), Number(m[4])];
  if (maxActive <= 0 || budget <= 0 || deadline <= 0) {
    throw new Error("policy: outcomes caps must be positive");
  }
  return { enabled: m[1] === "true", maxActivePerPrincipal: maxActive, defaultBudgetUsd: budget, defaultDeadlineDays: deadline };
}

/**
 * The `workers:` section (D1; roadmap §8): the worker contract ceiling.
 * `roles` maps role name → { model, max_budget_usd, default_deadline_minutes,
 * reads }. Fail-closed: disabled until the owner ratifies; unknown roles are
 * denied at dispatch (the parser stores exactly what the yaml says — the
 * dispatcher consults it per role, absent role = deny).
 */
export interface WorkerRolePolicy {
  readonly model: string;
  readonly maxBudgetUsd: number;
  readonly defaultDeadlineMinutes: number;
  /** Read-capability allowlist for the context-package builder. */
  readonly reads: readonly string[];
}

export interface WorkersPolicy {
  readonly enabled: boolean;
  readonly roles: Readonly<Record<string, WorkerRolePolicy>>;
}

/** Fail-safe defaults — disabled until the owner ratifies the section. */
export const DEFAULT_WORKERS_POLICY: WorkersPolicy = { enabled: false, roles: {} };

/**
 * Parse ONE flow-mapping role entry:
 * `{ model: <id>, max_budget_usd: <num>, default_deadline_minutes: <int>, reads: [a, b] }`.
 * Throws on any deviation (fail closed — a malformed role entry refuses the
 * whole section, refusing the whole worker fleet).
 */
export function parseWorkerRoleEntry(value: string): WorkerRolePolicy {
  const m = value.match(
    /^\{\s*model:\s*([\w./-]+),\s*max_budget_usd:\s*([\d.]+),\s*default_deadline_minutes:\s*(\d+),\s*reads:\s*\[([^\]]*)\]\s*\}$/,
  );
  if (m === null) throw new Error(`policy: malformed workers role entry: ${value.slice(0, 120)}`);
  const maxBudgetUsd = Number(m[2]);
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 50) {
    throw new Error(`policy: workers max_budget_usd out of range: ${m[2]}`);
  }
  const defaultDeadlineMinutes = Number(m[3]);
  if (!Number.isInteger(defaultDeadlineMinutes) || defaultDeadlineMinutes < 1 || defaultDeadlineMinutes > 24 * 60) {
    throw new Error(`policy: workers default_deadline_minutes out of range: ${m[3]}`);
  }
  const reads = m[4]!.trim()
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  return {
    model: m[1]!,
    maxBudgetUsd,
    defaultDeadlineMinutes,
    reads,
  };
}

/**
 * Parse the whole `workers:` block body (the indented lines collected by
 * parsePolicyV1): `enabled: <bool>` plus one flow-mapping line per role.
 */
export function parseWorkersBody(lines: readonly string[]): WorkersPolicy {
  let enabled: boolean | undefined;
  const roles: Record<string, WorkerRolePolicy> = {};
  for (const line of lines) {
    const m = line.match(/^(enabled|([a-z_]+)):\s*(.*)$/);
    if (m === null) throw new Error(`policy: malformed workers line: ${line.slice(0, 120)}`);
    if (m[1] === "enabled") {
      if (m[3] !== "true" && m[3] !== "false") throw new Error("policy: workers.enabled must be true|false");
      if (enabled !== undefined) throw new Error("policy: duplicate workers.enabled");
      enabled = m[3] === "true";
    } else {
      const role = m[2]!;
      if (roles[role] !== undefined) throw new Error(`policy: duplicate workers role '${role}'`);
      roles[role] = parseWorkerRoleEntry(m[3]!);
    }
  }
  if (enabled === undefined) throw new Error("policy: workers block missing enabled");
  return { enabled, roles };
}

/**
 * The `personas:` section (W4): `{ enabled: <bool>, principals: [name, …] }`
 * — EXACTLY those two keys in that order (the gateway.context strict-shape
 * pattern). This is the security/default layer only: the flag + allowlist
 * that gate whether conversation profiles are consulted at all. Prompt
 * text, register, brevity, or address values are structurally unparseable
 * here — fail closed. Defaults: disabled, no principals.
 */
export interface PersonasPolicy {
  readonly enabled: boolean;
  readonly principals: readonly string[];
}

/** Fail-safe defaults — disabled + empty principals (profiles stay inert). */
export const DEFAULT_PERSONAS_POLICY: PersonasPolicy = {
  enabled: false,
  principals: [],
};

export function parsePersonasEntry(value: string): PersonasPolicy {
  const m = value.match(
    /^\{\s*enabled:\s*(true|false),\s*principals:\s*\[([A-Za-z0-9_,\s]*)\]\s*\}$/,
  );
  if (m === null) {
    throw new Error(
      `policy: personas must be "{ enabled: <bool>, principals: [name, …] }" — and nothing else; no prompt text lives in policy (got '${value}')`,
    );
  }
  return {
    enabled: m[1] === "true",
    principals: [...new Set((m[2] ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0))],
  };
}

/**
 * `calibration.daily` flow-mapping parse — exactly
 * `{ enabled: <bool>, principals: [name, …], prompt_local_hour: <int> }`
 * in that key order (strict shape; the gateway.capture pattern). The hour
 * must land in 0-23; anything else throws (fail closed).
 */
export function parseCalibrationEntry(value: string): CalibrationPolicy {
  const m = value.match(
    /^\{\s*enabled:\s*(true|false),\s*principals:\s*\[([A-Za-z0-9_,\s]*)\],\s*prompt_local_hour:\s*(\d+)\s*\}$/,
  );
  if (m === null) {
    throw new Error(
      `policy: calibration.daily must be "{ enabled: <bool>, principals: [name, …], prompt_local_hour: <int 0-23> }" (got '${value}')`,
    );
  }
  const promptLocalHour = Number(m[3]);
  if (promptLocalHour > 23) {
    throw new Error("policy: calibration.daily prompt_local_hour must be an integer 0-23");
  }
  return {
    enabled: m[1] === "true",
    principals: [...new Set((m[2] ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0))],
    promptLocalHour,
  };
}

/** One extraction-sender glob: exactly one `@`, structured chars, `*` wild. */
const EXTRACT_SENDER_RE = /^[A-Za-z0-9_.%+-]*\*[A-Za-z0-9_.%+-]*@[A-Za-z0-9.*-]+|[A-Za-z0-9_.%+-]+@[A-Za-z0-9.*-]*\*[A-Za-z0-9.*-]*$/;

/**
 * `sensors.gmail` flow-mapping parse — either the original six-key shape
 * `{ enabled, poll_cron, bootstrap_window_days, extract_senders,
 * max_messages_per_poll, max_candidates_per_day }` or the ADR-0016 extended
 * shape appending `, content_enabled: <bool>, content_retention_days: <int>,
 * content_max_body_bytes: <int>` (§10.3 strict shape; the gateway.capture
 * pattern). Anything else throws (fail closed).
 */
export function parseSensorsGmailEntry(value: string): GmailSensorPolicy {
  const m = value.match(
    /^\{\s*enabled:\s*(true|false),\s*poll_cron:\s*"([^"]+)",\s*bootstrap_window_days:\s*(\d+),\s*extract_senders:\s*\[([A-Za-z0-9_@.*%+\s,-]*)\],\s*max_messages_per_poll:\s*(\d+),\s*max_candidates_per_day:\s*(\d+)\s*\}$/,
  );
  if (m !== null) {
    return buildSensorsGmail(m[1] === "true", m[2]!, Number(m[3]), m[4] ?? "", Number(m[5]), Number(m[6]), null);
  }
  const c = value.match(
    /^\{\s*enabled:\s*(true|false),\s*poll_cron:\s*"([^"]+)",\s*bootstrap_window_days:\s*(\d+),\s*extract_senders:\s*\[([A-Za-z0-9_@.*%+\s,-]*)\],\s*max_messages_per_poll:\s*(\d+),\s*max_candidates_per_day:\s*(\d+),\s*content_enabled:\s*(true|false),\s*content_retention_days:\s*(\d+),\s*content_max_body_bytes:\s*(\d+)\s*\}$/,
  );
  if (c !== null) {
    return buildSensorsGmail(
      c[1] === "true", c[2]!, Number(c[3]), c[4] ?? "", Number(c[5]), Number(c[6]),
      { enabled: c[7] === "true", retentionDays: Number(c[8]), maxBodyBytes: Number(c[9]) },
    );
  }
  throw new Error(
    `policy: sensors.gmail must be '{ enabled: <bool>, poll_cron: "<cron>", bootstrap_window_days: <int>, extract_senders: [glob, …], max_messages_per_poll: <int>, max_candidates_per_day: <int>[, content_enabled: <bool>, content_retention_days: <int>, content_max_body_bytes: <int>] }' (got '${value}')`,
  );
}

function buildSensorsGmail(
  enabled: boolean,
  pollCron: string,
  bootstrapDays: number,
  sendersRaw: string,
  maxMessagesPerPoll: number,
  maxCandidatesPerDay: number,
  content: { readonly enabled: boolean; readonly retentionDays: number; readonly maxBodyBytes: number } | null,
): GmailSensorPolicy {
  if (bootstrapDays <= 0 || maxMessagesPerPoll <= 0 || maxCandidatesPerDay <= 0) {
    throw new Error("policy: sensors.gmail caps must be positive");
  }
  const senders = [...new Set(
    sendersRaw.split(",").map((x) => x.trim()).filter((x) => x.length > 0),
  )];
  for (const pattern of senders) {
    if (!EXTRACT_SENDER_RE.test(pattern)) {
      throw new Error(
        `policy: sensors.gmail extract_senders entry '${pattern}' must be a glob with exactly one '@' (e.g. billing@*, *@stripe.com, billing@acme.com)`,
      );
    }
  }
  if (content !== null && (content.retentionDays <= 0 || content.maxBodyBytes <= 0)) {
    throw new Error("policy: sensors.gmail content caps must be positive");
  }
  return {
    enabled,
    pollCron,
    bootstrapDays,
    extractSenders: senders,
    maxMessagesPerPoll,
    maxCandidatesPerDay,
    contentEnabled: content?.enabled ?? DEFAULT_GMAIL_SENSOR_POLICY.contentEnabled,
    contentRetentionDays: content?.retentionDays ?? DEFAULT_GMAIL_SENSOR_POLICY.contentRetentionDays,
    contentMaxBodyBytes: content?.maxBodyBytes ?? DEFAULT_GMAIL_SENSOR_POLICY.contentMaxBodyBytes,
  };
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
  /** Lane J1 context-assembler config (gateway.context); absent → module default. */
  readonly context?: GatewayContextPolicy;
  /** W6a turn-interpretation flag (gateway.interpret); absent → disabled. */
  readonly interpret?: GatewayInterpretPolicy;
  /** Lane R1 pass-model overrides (gateway.passes); absent → null (no overrides). */
  readonly passes: GatewayPassesPolicy | null;
  /** §22 turn orchestration flag (gateway.routing); absent → "legacy".
   * "single" = the single-author cognitive loop. */
  readonly routing?: "single" | "legacy";
}

/**
 * Model-routing pass overrides — `gateway.passes` (Lane R1 + W3 tiers):
 * optional per-pass model ids that override the principal's model for the
 * route and answer passes. `{}` = no overrides; an absent section parses to
 * null (identical semantics — every pass rides the principal model).
 * Strict like every gateway key, in this order only: route, answer,
 * answer_fast, answer_standard, answer_deep, answer_fallback,
 * route_fallback — each `{ model: <id> }`; anything else throws (fail
 * closed). W3 tier semantics: `answer` is the legacy single-answer pin
 * (honored as STANDARD's fallback), `answer_fast`/`answer_standard`/
 * `answer_deep` are the tier pins (DEEP falls back to STANDARD's
 * resolution), `answer_fallback` is the provider-failure retry model
 * (nullable in effect — absent means no retry).
 */
export interface GatewayPassesPolicy {
  readonly route?: { readonly model: string };
  readonly answer?: { readonly model: string };
  readonly answer_fast?: { readonly model: string };
  readonly answer_standard?: { readonly model: string };
  readonly answer_deep?: { readonly model: string };
  readonly answer_fallback?: { readonly model: string };
  readonly route_fallback?: { readonly model: string };
}

/** The only keys `gateway.passes` may carry, in the only legal order. */
const PASS_KEYS = [
  "route",
  "answer",
  "answer_fast",
  "answer_standard",
  "answer_deep",
  "answer_fallback",
  "route_fallback",
] as const;
type PassKey = (typeof PASS_KEYS)[number];

/** Model id charset (the gateway.principals model convention). */
const PASS_MODEL_RE = /^[A-Za-z0-9._/-]+$/;

export function parseGatewayPassesEntry(value: string): GatewayPassesPolicy {
  if (!value.startsWith("{") || !value.endsWith("}")) {
    throw new Error(
      `policy: gateway.passes must be "{ [route: { model: <id> }][, answer: { model: <id> }][, answer_fast: { model: <id> }][, answer_standard: { model: <id> }][, answer_deep: { model: <id> }][, answer_fallback: { model: <id> }][, route_fallback: { model: <id> }] }" (got '${value}')`,
    );
  }
  const inner = value.slice(1, -1).trim();
  const models: Partial<Record<PassKey, string>> = {};
  let lastOrder = -1;
  if (inner !== "") {
    for (const part of inner.split(",")) {
      const m = part.trim().match(
        /^(route|answer|answer_fast|answer_standard|answer_deep|answer_fallback|route_fallback):\s*\{\s*model:\s*([A-Za-z0-9._/-]+)\s*\}$/,
      );
      if (m === null) {
        throw new Error(
          `policy: gateway.passes entries must be 'route|answer|answer_fast|answer_standard|answer_deep|answer_fallback|route_fallback: { model: <id> }' in that key order (got '${part.trim()}')`,
        );
      }
      const id = m[2]!;
      if (
        !PASS_MODEL_RE.test(id) ||
        !/[A-Za-z]/.test(id) ||
        id === "true" || id === "false" || id === "null"
      ) {
        throw new Error(
          `policy: gateway.passes model must be a non-empty string model id (got '${id}')`,
        );
      }
      const key = m[1] as PassKey;
      if (models[key] !== undefined) {
        throw new Error(`policy: duplicate gateway.passes.${key} key`);
      }
      if (PASS_KEYS.indexOf(key) <= lastOrder) {
        throw new Error(
          "policy: gateway.passes keys must appear in order route, answer, answer_fast, answer_standard, answer_deep, answer_fallback, route_fallback",
        );
      }
      lastOrder = PASS_KEYS.indexOf(key);
      models[key] = id;
    }
  }
  return {
    ...(models.route !== undefined ? { route: { model: models.route } } : {}),
    ...(models.answer !== undefined ? { answer: { model: models.answer } } : {}),
    ...(models.answer_fast !== undefined ? { answer_fast: { model: models.answer_fast } } : {}),
    ...(models.answer_standard !== undefined
      ? { answer_standard: { model: models.answer_standard } }
      : {}),
    ...(models.answer_deep !== undefined ? { answer_deep: { model: models.answer_deep } } : {}),
    ...(models.answer_fallback !== undefined
      ? { answer_fallback: { model: models.answer_fallback } }
      : {}),
    ...(models.route_fallback !== undefined
      ? { route_fallback: { model: models.route_fallback } }
      : {}),
  };
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

/** Valid grounded-read sources (fail-closed parse: unknown names throw).
 *  `gmail` added additively by Phase GMAIL §8.3 (gmail.recent read tool). */
export const READ_SOURCES = ["calendar", "commitments", "gmail", "state", "memory", "system"] as const;

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

export interface GatewayContextPolicy {
  readonly enabled: boolean;
  readonly maxReadsPerTurn: 1 | 2 | 3;
  readonly perBlockTokenBudget: number;
}

export const DEFAULT_GATEWAY_CONTEXT_POLICY: GatewayContextPolicy = {
  enabled: false,
  maxReadsPerTurn: 1,
  perBlockTokenBudget: 1500,
};

export function parseGatewayContextEntry(value: string): GatewayContextPolicy {
  const m = value.match(
    /^\{\s*enabled:\s*(true|false),\s*max_reads_per_turn:\s*([123]),\s*per_block_token_budget:\s*(\d+)\s*\}$/,
  );
  if (m === null) {
    throw new Error(
      `policy: gateway.context must be "{ enabled: <bool>, max_reads_per_turn: <1|2|3>, per_block_token_budget: <int> }" (got '${value}')`,
    );
  }
  const perBlockTokenBudget = Number(m[3]);
  if (perBlockTokenBudget <= 0) {
    throw new Error("policy: gateway.context per_block_token_budget must be positive");
  }
  return {
    enabled: m[1] === "true",
    maxReadsPerTurn: Number(m[2]) as 1 | 2 | 3,
    perBlockTokenBudget,
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
  let section: "autonomy_ceiling" | "notifications" | "gateway" | "sensors" | "calibration" | "outcomes" | "workers" | null = null;
  let sawCeiling = false;
  let sawNotifications = false;
  let sawGateway = false;
  let sawSensors = false;
  let sawCalibration = false;
  let sawPersonas = false;
  let inGatewayPrincipals = false;
  const notificationEntries: Array<{ key: string; value: string }> = [];
  const gatewayPrincipals: Record<string, GatewayPrincipalPolicy> = {};
  const gatewayCapture: { value: GatewayCapturePolicy | null } = { value: null };
  const gatewayReview: { value: GatewayReviewPolicy | null } = { value: null };
  const gatewayActions: { value: GatewayActionsPolicy | null } = { value: null };
  const gatewayContext: { value: GatewayContextPolicy | null } = { value: null };
  const gatewayInterpret: { value: GatewayInterpretPolicy | null } = { value: null };
  const gatewayPasses: { value: GatewayPassesPolicy | null } = { value: null };
  let gatewayRouting: "single" | "legacy" | null = null;
  const sensorsGmail: { value: GmailSensorPolicy | null } = { value: null };
  const calibrationDaily: { value: CalibrationPolicy | null } = { value: null };
  const outcomesPolicy: { value: OutcomesPolicy | null } = { value: null };
  const workersLines: string[] = [];
  const personasPolicy: { value: PersonasPolicy | null } = { value: null };

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
      } else if (key === "sensors") {
        if (value !== "") throw new Error("policy: sensors must be a mapping");
        if (sawSensors) throw new Error("policy: duplicate sensors key");
        sawSensors = true;
        section = "sensors";
      } else if (key === "calibration") {
        if (value !== "") throw new Error("policy: calibration must be a mapping");
        if (sawCalibration) throw new Error("policy: duplicate calibration key");
        sawCalibration = true;
        section = "calibration";
      } else if (key === "outcomes") {
        if (value === "") throw new Error("policy: outcomes must be a flow mapping");
        if (outcomesPolicy.value !== null) throw new Error("policy: duplicate outcomes key");
        outcomesPolicy.value = parseOutcomesEntry(value);
        section = "outcomes";
      } else if (key === "workers") {
        if (value !== "") throw new Error("policy: workers must be a mapping block");
        if (workersLines.length > 0) throw new Error("policy: duplicate workers key");
        section = "workers";
      } else if (key === "personas") {
        if (sawPersonas) throw new Error("policy: duplicate personas key");
        sawPersonas = true;
        if (value === "") {
          throw new Error("policy: personas must be a flow mapping '{ enabled: <bool>, principals: [name, …] }'");
        }
        personasPolicy.value = parsePersonasEntry(value);
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
    if (section === "sensors") {
      if (key === "gmail") {
        if (sensorsGmail.value !== null) throw new Error("policy: duplicate sensors.gmail key");
        sensorsGmail.value = parseSensorsGmailEntry(value);
        continue;
      }
      throw new Error(`policy: unknown sensors key '${key}'`);
    }
    if (section === "calibration") {
      if (key === "daily") {
        if (calibrationDaily.value !== null) throw new Error("policy: duplicate calibration.daily key");
        calibrationDaily.value = parseCalibrationEntry(value);
        continue;
      }
      throw new Error(`policy: unknown calibration key '${key}'`);
    }
    if (section === "workers") {
      workersLines.push(line.trim());
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
      if (key === "context") {
        if (gatewayContext.value !== null) throw new Error("policy: duplicate gateway.context key");
        gatewayContext.value = parseGatewayContextEntry(value);
        continue;
      }
      if (key === "interpret") {
        if (gatewayInterpret.value !== null) throw new Error("policy: duplicate gateway.interpret key");
        gatewayInterpret.value = parseGatewayInterpretEntry(value);
        continue;
      }
      if (key === "passes") {
        if (gatewayPasses.value !== null) throw new Error("policy: duplicate gateway.passes key");
        gatewayPasses.value = parseGatewayPassesEntry(value);
        continue;
      }
      if (key === "routing") {
        if (value !== "single" && value !== "legacy") {
          throw new Error(`policy: gateway.routing must be 'single' or 'legacy', got '${value}'`);
        }
        if (gatewayRouting !== null) throw new Error("policy: duplicate gateway.routing key");
        gatewayRouting = value;
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
      ...(gatewayContext.value !== null ? { context: gatewayContext.value } : {}),
      ...(gatewayInterpret.value !== null ? { interpret: gatewayInterpret.value } : {}),
      ...(gatewayRouting !== null ? { routing: gatewayRouting } : {}),
      passes: gatewayPasses.value,
    };
  }
  if (sawSensors && sensorsGmail.value !== null) {
    policy.sensors = { gmail: sensorsGmail.value };
  }
  if (sawCalibration && calibrationDaily.value !== null) {
    policy.calibration = calibrationDaily.value;
  }
  if (outcomesPolicy.value !== null) {
    policy.outcomes = outcomesPolicy.value;
  }
  if (workersLines.length > 0) {
    policy.workers = parseWorkersBody(workersLines);
  }
  if (sawPersonas && personasPolicy.value !== null) {
    policy.personas = personasPolicy.value;
  }
  return policy;
}

/** Loads and parses a policy.yaml file from disk. Fails closed on any error. */
export async function loadPolicyFile(path: string | URL): Promise<PolicyV1> {
  return parsePolicyV1(await readFile(path, "utf8"));
}

/**
 * The effective sensors.gmail policy: the parsed section when present,
 * else the fail-safe defaults (enabled:false — §9.4 kill switch holds).
 */
export function gmailSensorPolicyOf(policy: PolicyV1): GmailSensorPolicy {
  return policy.sensors?.gmail ?? DEFAULT_GMAIL_SENSOR_POLICY;
}

/**
 * The effective calibration policy: the parsed section when present, else
 * the fail-safe defaults (enabled:false, no principals — the daily check
 * never runs until the owner ratifies the section).
 */
export function calibrationPolicyOf(policy: PolicyV1): CalibrationPolicy {
  return policy.calibration ?? DEFAULT_CALIBRATION_POLICY;
}

/** The effective outcomes policy: parsed section or fail-safe defaults. */
export function outcomesPolicyOf(policy: PolicyV1): OutcomesPolicy {
  return policy.outcomes ?? DEFAULT_OUTCOMES_POLICY;
}

/** The effective workers policy: parsed section or fail-safe (disabled). */
export function workersPolicyOf(policy: PolicyV1): WorkersPolicy {
  return policy.workers ?? DEFAULT_WORKERS_POLICY;
}

export interface GatewayInterpretPolicy {
  readonly enabled: boolean;
}

export const DEFAULT_GATEWAY_INTERPRET_POLICY: GatewayInterpretPolicy = { enabled: false };

export function parseGatewayInterpretEntry(value: string): GatewayInterpretPolicy {
  const m = value.match(/^\{ enabled: (true|false) \}$/);
  if (m === null) {
    throw new Error(`policy: gateway.interpret must be "{ enabled: <bool> }" (got '${value}')`);
  }
  return { enabled: m[1] === "true" };
}

export function interpretPolicyOf(policy: PolicyV1 | null): GatewayInterpretPolicy {
  if (policy === null) return DEFAULT_GATEWAY_INTERPRET_POLICY;
  return policy.gateway?.interpret ?? DEFAULT_GATEWAY_INTERPRET_POLICY;
}

export function gatewayContextPolicyOf(policy: PolicyV1): GatewayContextPolicy {
  return policy.gateway?.context ?? DEFAULT_GATEWAY_CONTEXT_POLICY;
}

/**
 * The effective personas policy: the parsed section when present, else the
 * fail-safe defaults (enabled:false, no principals — interaction profiles
 * stay inert until the owner ratifies the section and the seed profile).
 */
export function personasPolicyOf(policy: PolicyV1): PersonasPolicy {
  return policy.personas ?? DEFAULT_PERSONAS_POLICY;
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
