// M6A structured queries — the §13/§40 item-5 questions over canonical
// state only, plus the review §17 derived-stalled variant and the review §25
// graph-backed leverage query. Deterministic SQL + fixed graph walks; no
// model calls anywhere. Everything here is read-only against canonical
// tables (fixtures.ts is the test-only seeder and intentionally NOT
// re-exported).

export type {
  CommitmentListItem,
  WaitingOptions,
  WaitsOnMeItem,
  WaitsOnMeOptions,
} from "./waiting.js";
export { whatAmIWaitingFor, whatWaitsOnMe } from "./waiting.js";

export type {
  ChangedCommitment,
  ChangedDecision,
  ChangedEvent,
  ChangedEventGroup,
  ChangedRelationship,
  WhatChangedOptions,
  WhatChangedResult,
} from "./changed.js";
export { whatChanged } from "./changed.js";

export type {
  BlockedByEdge,
  BlockedItem,
  StalledItem,
  StalledThresholds,
  WhatIsBlockedOptions,
  WhatIsBlockedResult,
} from "./blocked.js";
export { whatIsBlocked } from "./blocked.js";

export type {
  BlockedItemSummary,
  LeverageDecision,
  LeverageOptions,
} from "./leverage.js";
export { highestLeverageDecision } from "./leverage.js";

export type {
  DayStateData,
  DayStateEscalationSummary,
  DayStateOptions,
} from "./day-state.js";
export { collectDayState, DAY_STATE_COVERAGE, renderDayStateText } from "./day-state.js";

export type {
  FreshnessSource,
  SourceFreshness,
  SourceFreshnessOptions,
} from "./staleness.js";
export {
  freshnessLines,
  imessageFreshness,
  sourceFreshness,
  STALE_AFTER_HOURS,
} from "./staleness.js";

export type {
  CollectSystemStateInput,
  SystemStateCapabilities,
  SystemStateCost,
  SystemStateCoverageGap,
  SystemStateData,
  SystemStateGrants,
  SystemStateModelUsage,
  SystemStateSourceName,
  SystemStateSourceStatus,
  SystemStateVersion,
} from "./system-state.js";
export {
  collectSystemState,
  renderSystemStateText,
  SYSTEM_STATE_COVERAGE,
  SYSTEM_STATE_LIMITATIONS,
  SYSTEM_STATE_LIMITATIONS_VERSION,
} from "./system-state.js";
