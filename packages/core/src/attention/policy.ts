// Attention subsystem policy (W1.1 finding 4): `attention:` section of the
// repo-root policy.yaml, read through the same fail-closed loader as the
// notifications config. `enabled: false` is the subsystem kill switch:
//   - Outcome→Attention production stops (canonical outcomes unaffected)
//   - delivery enqueue stops with it (nothing new to deliver)
//   - attention-liveness stops (workflow-level gate)
// Existing canonical rows are never touched by the switch; restoring
// `enabled: true` (process restart re-reads the memoized policy, same
// lifecycle as the notifications config) resumes normal production.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicyFile } from "../policy/ceiling.js";

export interface AttentionPolicy {
  readonly enabled: boolean;
  readonly cooldownMinutes: number;
}

export const DEFAULT_ATTENTION_POLICY: AttentionPolicy = {
  enabled: true,
  cooldownMinutes: 60,
};

/** Projects the parsed policy section; unknown shapes fall back to defaults. */
export function attentionPolicyFromPolicyV1(
  policy: { attention?: { enabled?: boolean; cooldownMinutes?: number } } | null | undefined,
): AttentionPolicy {
  if (policy === null || policy === undefined || policy.attention === undefined) {
    return DEFAULT_ATTENTION_POLICY;
  }
  const { enabled, cooldownMinutes } = policy.attention;
  return {
    enabled: enabled !== false, // explicit false kills; missing/typo'd fails OPEN (liveness is a safety net)
    cooldownMinutes:
      typeof cooldownMinutes === "number" && Number.isFinite(cooldownMinutes) && cooldownMinutes > 0
        ? cooldownMinutes
        : DEFAULT_ATTENTION_POLICY.cooldownMinutes,
  };
}

function defaultPolicyYamlPath(): string {
  return path.resolve(fileURLToPath(new URL("../../../../policy.yaml", import.meta.url)));
}

let cached: Promise<AttentionPolicy> | null = null;

/**
 * The production policy source: repo-root policy.yaml, read once per process
 * (notifications-config lifecycle — a kill-switch flip takes effect on
 * process restart). Tests pass explicit config; production never rides the
 * default.
 */
export async function loadAttentionPolicy(file?: string): Promise<AttentionPolicy> {
  const resolved = file ?? defaultPolicyYamlPath();
  if (file === undefined) {
    cached ??= readPolicy(resolved);
    return cached;
  }
  return readPolicy(resolved);
}

async function readPolicy(resolved: string): Promise<AttentionPolicy> {
  try {
    return attentionPolicyFromPolicyV1(await loadPolicyFile(resolved));
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_ATTENTION_POLICY;
    }
    throw err;
  }
}
