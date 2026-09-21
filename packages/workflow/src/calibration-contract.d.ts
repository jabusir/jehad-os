// TEMPORARY lane-C2 contract seam — DELETE AT INTEGRATION.
//
// Lane C1 (packages/core calibration domain: openDailyCalibration /
// runWeeklyCalibrationRollup + the policy.calibration parser section) builds
// in a parallel worktree off main; until it merges, this augmentation
// declares the exports calibration-workflows.ts codes against. The
// orchestrator deletes this file once C1 lands (its real implementations
// replace these declarations) — keep the names here in sync with C1's
// report and reconcile at integration.
//
// Expected real signatures (lane C2 task contract):
//   - openDailyCalibration(db, { principalId, now }) — idempotent per
//     principal-day: returns the open calibration item, `created` telling
//     whether THIS call opened it (false → the workflow skips the send),
//     and the prompt content (delivered via the notification queue; NEVER
//     tick-logged).
//   - runWeeklyCalibrationRollup(db, { principalId, now }) — renders the
//     weekly rollup; content null means too little rated data (skip send).
//
// The notification enqueue itself intentionally uses the EXISTING
// notifications service (createNotification, kind=custom, sourceType=run)
// rather than a contract fn — see sendCalibrationNotification in
// calibration-workflows.ts for the reconciliation point.

// `export {}` makes this a module file so the block below is a module
// AUGMENTATION (additive) rather than shadowing ambient declarations.
export {};

declare module "@jehad/core" {
  export function openDailyCalibration(
    db: unknown,
    opts: { principalId: string; now?: Date | (() => Date) },
  ): Promise<{ itemId: string; created: boolean; prompt: string }>;
  export function runWeeklyCalibrationRollup(
    db: unknown,
    opts: { principalId: string; now?: Date | (() => Date) },
  ): Promise<{ content: string | null; daysRated: number }>;
}
