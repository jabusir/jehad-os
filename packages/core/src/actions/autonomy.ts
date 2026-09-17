// Autonomy ceiling (policy-model.md §4; plan §9). Policy is data, not model
// judgment: per action type, from versioned policy.yaml (the §35 pattern).
//
// The ceiling is loaded from the repo-root policy.yaml (single source of
// truth, ADR-0003/ADR-0007) via ActionService; the V1_AUTONOMY_POLICY
// constant below is only a FALLBACK used when the file is missing (with a
// warning). ceiling.test.ts asserts file == fallback so the two can never
// drift silently.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicyFile, type PolicyV1 } from "../policy/ceiling.js";

export type AutonomyLevel = "autonomous" | "gated" | "approval_required" | "prohibited";

export type ExternalActionType =
  | "read"
  | "propose"
  | "write_canonical"
  | "external_side_effect"
  | "money_and_contracts";

export interface AutonomyPolicy {
  actions: Record<ExternalActionType, AutonomyLevel>;
}

export class ActionProhibitedError extends Error {
  constructor(actionType: ExternalActionType) {
    super(`action type '${actionType}' is prohibited by the autonomy ceiling`);
    this.name = "ActionProhibitedError";
  }
}

/** Fallback ONLY — used when policy.yaml is missing (with a warning). */
export const V1_AUTONOMY_POLICY: AutonomyPolicy = {
  actions: {
    read: "autonomous",
    propose: "autonomous",
    write_canonical: "gated",
    external_side_effect: "approval_required",
    money_and_contracts: "prohibited",
  },
};

/** Repo-root policy.yaml — same depth from src/ and dist/. */
export function defaultPolicyYamlPath(): string {
  return path.resolve(fileURLToPath(new URL("../../../../policy.yaml", import.meta.url)));
}

/** Projects the parsed policy.yaml onto the ActionService policy shape. */
export function autonomyPolicyFromPolicyV1(policy: PolicyV1): AutonomyPolicy {
  return {
    actions: { ...policy.autonomy_ceiling } as Record<ExternalActionType, AutonomyLevel>,
  };
}

/**
 * The v1 single source of the ceiling: policy.yaml (ADR-0003). A missing
 * file falls back to the hardcoded v1 ceiling WITH a warning; a malformed
 * file THROWS fail-closed — policy can never silently degrade.
 */
export async function resolveAutonomyPolicy(
  filePath?: string,
  opts: { warn?: (message: string) => void } = {},
): Promise<AutonomyPolicy> {
  const file = filePath ?? defaultPolicyYamlPath();
  const warn = opts.warn ?? ((message: string) => console.warn(`[jehad] ${message}`));
  try {
    return autonomyPolicyFromPolicyV1(await loadPolicyFile(file));
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      warn(`policy.yaml not found at ${file}; falling back to the hardcoded v1 autonomy ceiling`);
      return V1_AUTONOMY_POLICY;
    }
    throw err;
  }
}

export function assertAllowedByCeiling(
  policy: AutonomyPolicy,
  actionType: ExternalActionType,
): void {
  if (policy.actions[actionType] === "prohibited") {
    throw new ActionProhibitedError(actionType);
  }
}
