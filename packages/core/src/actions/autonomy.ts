// Autonomy ceiling (policy-model.md §4; plan §9). Policy is data, not model
// judgment: per action type, from versioned policy.yaml (the §35 pattern).
//
// TODO(policy.yaml/M4A): read the ceiling from policy.yaml, shape
// { actions: { money_and_contracts: prohibited, ... } }, once M4A ships the
// file. It does not exist in this worktree yet, so the v1 ceiling is
// hardcoded below exactly as plan §9 specifies.

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

export const V1_AUTONOMY_POLICY: AutonomyPolicy = {
  actions: {
    read: "autonomous",
    propose: "autonomous",
    write_canonical: "gated",
    external_side_effect: "approval_required",
    money_and_contracts: "prohibited",
  },
};

export function assertAllowedByCeiling(
  policy: AutonomyPolicy,
  actionType: ExternalActionType,
): void {
  if (policy.actions[actionType] === "prohibited") {
    throw new ActionProhibitedError(actionType);
  }
}
