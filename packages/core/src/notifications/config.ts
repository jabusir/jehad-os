// Notification delivery policy (E4 OpenClaw attach). The queue sits BEHIND
// review/policy: creation status, the escalation urgency threshold, and the
// delivery window all come from the `notifications:` section of the repo-root
// policy.yaml — data, not judgment (same rule as the autonomy ceiling,
// ADR-0003/ADR-0007). Defaults are fail-safe: only briefs auto-approve,
// escalations notify from high upward, rows expire in four hours.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicyFile } from "../policy/ceiling.js";

export const NOTIFICATION_KINDS = [
  "brief", "escalation", "custom", "calendar-change", "reply", "calibration",
"grant-reminder",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Gateway §4: replies are approved by the conjunction rule, never a kind list. */
export const REPLY_NOTIFICATION_KIND: NotificationKind = "reply";

const KINDS = new Set<string>(NOTIFICATION_KINDS);

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && KINDS.has(value);
}

export interface NotificationsConfig {
  /** Kinds that land status=approved at creation; everything else is pending. */
  readonly autoApproveKinds: readonly NotificationKind[];
  /** Escalation raises enqueue a notification only at/above this urgency. */
  readonly escalationMinUrgency: string;
  /** Delivery window (minutes) stamped on new notifications as expires_at. */
  readonly defaultTtlMinutes: number;
}

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  autoApproveKinds: ["brief"],
  escalationMinUrgency: "high",
  defaultTtlMinutes: 240,
};

/** Projects the parsed policy section onto the config; unknown kinds drop out. */
export function notificationsConfigFromPolicyV1(
  policy: { notifications?: { autoApproveKinds: readonly string[] } } | null | undefined,
): NotificationsConfig {
  if (policy === null || policy === undefined || policy.notifications === undefined) {
    return DEFAULT_NOTIFICATIONS_CONFIG;
  }
  return {
    ...DEFAULT_NOTIFICATIONS_CONFIG,
    ...policy.notifications,
    // Guard (gateway §4, forbidden-everywhere rule): 'reply' is NEVER
    // auto-approved via the kind list — drop it even if policy declares it.
    autoApproveKinds: policy.notifications.autoApproveKinds
      .filter(isNotificationKind)
      .filter((kind) => kind !== REPLY_NOTIFICATION_KIND),
  };
}

/** Repo-root policy.yaml — same depth from src/ and dist/. */
function defaultPolicyYamlPath(): string {
  return path.resolve(fileURLToPath(new URL("../../../../policy.yaml", import.meta.url)));
}

let defaultConfig: Promise<NotificationsConfig> | null = null;

/**
 * The notification policy source: the repo-root policy.yaml, read once per
 * process. An explicit `file` always re-reads (tests); the default path is
 * cached like the egress registry. Malformed policy fails closed (the parser
 * throws); a missing file falls back to the defaults.
 */
export async function loadNotificationsConfig(
  file?: string,
): Promise<NotificationsConfig> {
  const resolved = file ?? defaultPolicyYamlPath();
  if (file === undefined) {
    defaultConfig ??= readConfig(resolved);
    return defaultConfig;
  }
  return readConfig(resolved);
}

/**
 * The workflow-path notification policy: the repo-root policy.yaml, through
 * the memoized default load (malformed policy THROWS; only ENOENT falls back
 * to the defaults). Every workflow-created notification MUST pass this to
 * createNotification — DEFAULT_NOTIFICATIONS_CONFIG is a fail-safe, never a
 * producer's policy (the Sep 16/21 calibration dead letters were exactly
 * that fallback).
 */
export function workflowNotificationsConfig(): Promise<NotificationsConfig> {
  return loadNotificationsConfig();
}

async function readConfig(resolved: string): Promise<NotificationsConfig> {
  try {
    return notificationsConfigFromPolicyV1(await loadPolicyFile(resolved));
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_NOTIFICATIONS_CONFIG;
    }
    throw err;
  }
}
