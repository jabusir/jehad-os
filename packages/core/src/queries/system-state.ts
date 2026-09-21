import { type QueryExecutor } from "./executor.js";
import { UUID_RE } from "../events/envelope.js";
import { imessageFreshness, sourceFreshness, type SourceFreshness } from "./staleness.js";

export const SYSTEM_STATE_COVERAGE =
  "runtime introspection over connected sources, active grants, policy reads, model-ledger costs, and calibration misses; never message or email content, never credentials, read-only";

export const SYSTEM_STATE_LIMITATIONS_VERSION = 1;

export const SYSTEM_STATE_LIMITATIONS = [
  "cannot read attachments or files shared in messages",
  "no work sources: work email, chat, and employer systems are not connected (personal-domain Gmail only)",
  "calendar items are plans, not verified occurrences: what actually happened is marked only when corroborated",
  "iMessage is the only conversation surface",
  "no voice and no general computer control",
] as const;

export type SystemStateSourceName = "calendar" | "gmail" | "imessage";

export interface SystemStateSourceStatus {
  readonly source: SystemStateSourceName;
  readonly connected: boolean;
  readonly lastSyncAt: string | null;
  readonly stale: boolean;
  readonly ageText: string | null;
}

export interface SystemStateGrants {
  readonly count: number;
  readonly capabilityNames: readonly string[];
}

export interface SystemStateCapabilities {
  readonly reads: readonly string[] | null;
  readonly grants: SystemStateGrants;
  readonly actions: boolean | null;
}

export interface SystemStateVersion {
  readonly gitSha: string | null;
  readonly node: string;
  readonly deployedAt: string | null;
}

export interface SystemStateModelUsage {
  readonly model: string;
  readonly calls: number;
  readonly usd: number;
}

export interface SystemStateCost {
  readonly monthToDateUsd: number;
  readonly callsMonthToDate: number;
  readonly byModelTop3: readonly SystemStateModelUsage[];
}

export interface SystemStateCoverageGap {
  readonly source: string;
  readonly missCount: number;
}

export interface SystemStateData {
  readonly principalId: string;
  readonly now: string;
  readonly sources: readonly SystemStateSourceStatus[];
  readonly capabilities: SystemStateCapabilities;
  readonly version: SystemStateVersion;
  readonly cost: SystemStateCost;
  readonly coverageGaps: readonly SystemStateCoverageGap[];
  readonly knownLimitations: readonly string[];
}

export interface CollectSystemStateInput {
  readonly principalId: string;
  readonly now?: () => Date;
  readonly policyReads?: readonly string[];
  readonly actionsEnabled?: boolean | null;
  readonly env?: Record<string, string | undefined>;
}

const ACTIVE_GRANTS_SQL = `
  SELECT capability, count(*)::int AS n
  FROM capability_grants
  WHERE principal_id = $1::uuid
    AND revoked_at IS NULL
    AND expires_at > $2::timestamptz
  GROUP BY capability
  ORDER BY capability ASC
`;

const MODEL_COST_SQL = `
  SELECT mc.model AS model, count(*)::int AS calls, sum(mc.cost_usd) AS usd
  FROM model_calls mc
  JOIN runs r ON r.id = mc.run_id
  WHERE r.principal_id = $1::uuid
    AND mc.created_at >= $2::timestamptz
  GROUP BY mc.model
  ORDER BY usd DESC, calls DESC, model ASC
`;

const COVERAGE_GAPS_SQL = `
  SELECT source_attribution, count(*)::int AS n
  FROM feedback
  WHERE item_type = 'calibration'
    AND verdict = 'missed'
    AND created_by = $1
    AND created_at >= $2::timestamptz
    AND created_at < $3::timestamptz
  GROUP BY source_attribution
  ORDER BY source_attribution ASC
`;

const MS_PER_DAY = 86_400_000;
const COVERAGE_GAP_WINDOW_DAYS = 30;
const COST_TOP_MODELS = 3;

function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function toSourceStatus(f: SourceFreshness): SystemStateSourceStatus {
  return {
    source: f.source,
    connected: f.lastSyncedAt !== null,
    lastSyncAt: f.lastSyncedAt,
    stale: f.stale,
    ageText: f.ageText,
  };
}

function envString(env: Record<string, string | undefined>, key: string): string | null {
  const value = (env[key] ?? "").trim();
  return value.length > 0 ? value : null;
}

function normalizeDeployedAt(raw: string | null): string | null {
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export async function collectSystemState(
  db: QueryExecutor,
  input: CollectSystemStateInput,
): Promise<SystemStateData> {
  if (!UUID_RE.test(input.principalId)) {
    throw new TypeError("principalId must be a uuid");
  }
  const now = input.now?.() ?? new Date();
  const nowFn = (): Date => now;
  const monthStart = utcMonthStart(now);
  const gapsSince = new Date(now.getTime() - COVERAGE_GAP_WINDOW_DAYS * MS_PER_DAY);

  const [freshness, imessage, grants, cost, gaps] = await Promise.all([
    sourceFreshness(db, input.principalId, { now: nowFn }),
    imessageFreshness(db, { now: nowFn }),
    db.query(ACTIVE_GRANTS_SQL, [input.principalId, now.toISOString()]),
    db.query(MODEL_COST_SQL, [input.principalId, monthStart.toISOString()]),
    db.query(COVERAGE_GAPS_SQL, [
      input.principalId,
      gapsSince.toISOString(),
      now.toISOString(),
    ]),
  ]);

  let grantCount = 0;
  const capabilityNames: string[] = [];
  for (const row of grants.rows) {
    grantCount += Number(row.n);
    capabilityNames.push(String(row.capability));
  }

  let callsMonthToDate = 0;
  let monthToDateUsd = 0;
  const byModel: SystemStateModelUsage[] = [];
  for (const row of cost.rows) {
    const calls = Number(row.calls);
    const usd = Number(row.usd);
    callsMonthToDate += calls;
    monthToDateUsd += usd;
    byModel.push({ model: String(row.model), calls, usd });
  }

  const env = input.env ?? process.env;

  return {
    principalId: input.principalId,
    now: now.toISOString(),
    sources: [...freshness.map(toSourceStatus), toSourceStatus(imessage)],
    capabilities: {
      reads: input.policyReads === undefined ? null : [...input.policyReads],
      grants: { count: grantCount, capabilityNames },
      actions: input.actionsEnabled === undefined ? null : input.actionsEnabled,
    },
    version: {
      gitSha: envString(env, "JEHAD_GIT_SHA"),
      node: process.version,
      deployedAt: normalizeDeployedAt(envString(env, "JEHAD_DEPLOYED_AT")),
    },
    cost: {
      monthToDateUsd,
      callsMonthToDate,
      byModelTop3: byModel.slice(0, COST_TOP_MODELS),
    },
    coverageGaps: gaps.rows.map((row) => ({
      source:
        row.source_attribution === null || row.source_attribution === undefined
          ? "other"
          : String(row.source_attribution),
      missCount: Number(row.n),
    })),
    knownLimitations: [...SYSTEM_STATE_LIMITATIONS],
  };
}

function agePhrase(ageText: string | null): string {
  if (ageText === null) return "under 1h";
  return ageText === "0h" ? "under 1h" : ageText;
}

function sourceLine(s: SystemStateSourceStatus): string {
  if (!s.connected) {
    return `- ${s.source}: not connected`;
  }
  const age = agePhrase(s.ageText);
  return s.stale
    ? `- ${s.source}: synced ${age} ago (stale)`
    : `- ${s.source}: synced ${age} ago`;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function callsPhrase(n: number): string {
  return `${n} call${n === 1 ? "" : "s"}`;
}

function sourceLines(data: SystemStateData): string[] {
  return ["SOURCES", ...data.sources.map(sourceLine)];
}

function capabilityLines(data: SystemStateData): string[] {
  const c = data.capabilities;
  const reads =
    c.reads === null ? "unknown (policy not loaded in this view)" : c.reads.join(", ");
  const grants =
    c.grants.count === 0
      ? "- grants: 0 active"
      : `- grants: ${c.grants.count} active — ${c.grants.capabilityNames.join(", ")}`;
  const actions = c.actions === null ? "unknown" : c.actions ? "enabled" : "disabled";
  return ["CAPABILITIES", `- reads: ${reads}`, grants, `- actions: ${actions}`];
}

function versionLines(data: SystemStateData): string[] {
  const v = data.version;
  return [
    "VERSION",
    `- git: ${v.gitSha ?? "unknown"}`,
    `- node: ${v.node}`,
    `- deployed: ${v.deployedAt ?? "unknown"}`,
  ];
}

function costLines(data: SystemStateData): string[] {
  if (data.cost.callsMonthToDate === 0) return [];
  return [
    "COST THIS MONTH",
    `- total: ${usd(data.cost.monthToDateUsd)} across ${callsPhrase(
      data.cost.callsMonthToDate,
    )} (scoped to this principal's runs)`,
    ...data.cost.byModelTop3.map(
      (m) => `- ${m.model}: ${callsPhrase(m.calls)}, ${usd(m.usd)}`,
    ),
  ];
}

function coverageGapLines(data: SystemStateData): string[] {
  if (data.coverageGaps.length === 0) return [];
  const total = data.coverageGaps.reduce((n, g) => n + g.missCount, 0);
  return [
    "COVERAGE GAPS",
    `- ${total} calibration miss${total === 1 ? "" : "es"} in the last 30 days:`,
    ...data.coverageGaps.map((g) => `- ${g.source} ×${g.missCount}`),
  ];
}

function limitationLines(data: SystemStateData): string[] {
  return ["LIMITS", ...data.knownLimitations.map((l) => `- ${l}`)];
}

export function renderSystemStateText(data: SystemStateData): string {
  const sections = [
    sourceLines(data),
    capabilityLines(data),
    versionLines(data),
    costLines(data),
    coverageGapLines(data),
    limitationLines(data),
  ].filter((section) => section.length > 0);

  const lines: string[] = [
    "System state",
    "",
    ...sections.flatMap((section) => [...section, ""]).slice(0, -1),
  ];
  return lines.map((line) => line.trimEnd()).join("\n") + "\n";
}
