import { toIsoOrNull, type QueryExecutor } from "./executor.js";

export const STALE_AFTER_HOURS = 6;

const MS_PER_HOUR = 3_600_000;

export type FreshnessSource = "calendar" | "gmail" | "imessage";

export interface SourceFreshness {
  readonly source: FreshnessSource;
  readonly lastSyncedAt: string | null;
  readonly stale: boolean;
  readonly ageText: string | null;
}

export interface SourceFreshnessOptions {
  readonly now?: () => Date;
  readonly staleAfterHours?: number;
}

const CALENDAR_FRESHNESS_SQL = `
  SELECT last_synced_at FROM calendar_sync_state WHERE id = 1
`;

const GMAIL_FRESHNESS_SQL = `
  SELECT last_tick_at AS last_synced_at FROM gmail_sync_state WHERE id = 'singleton'
`;

const IMESSAGE_FRESHNESS_SQL = `
  SELECT updated_at AS last_synced_at FROM imessage_sensor_state WHERE singleton = true
`;

function parseStaleAfterHours(value: number | undefined): number {
  if (value === undefined) return STALE_AFTER_HOURS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`staleAfterHours must be a positive number, got ${String(value)}`);
  }
  return value;
}

function toFreshness(
  source: FreshnessSource,
  row: Record<string, unknown> | undefined,
  now: Date,
  staleAfterHours: number,
): SourceFreshness {
  const lastSyncedAt = row === undefined ? null : toIsoOrNull(row.last_synced_at, "last_synced_at");
  if (lastSyncedAt === null) {
    return { source, lastSyncedAt: null, stale: true, ageText: null };
  }
  const ageHours = (now.getTime() - Date.parse(lastSyncedAt)) / MS_PER_HOUR;
  return {
    source,
    lastSyncedAt,
    stale: ageHours > staleAfterHours,
    ageText: `${Math.max(0, Math.floor(ageHours))}h`,
  };
}

export async function sourceFreshness(
  db: QueryExecutor,
  principalId: string,
  opts: SourceFreshnessOptions = {},
): Promise<readonly SourceFreshness[]> {
  const now = opts.now?.() ?? new Date();
  const staleAfterHours = parseStaleAfterHours(opts.staleAfterHours);
  const [calendar, gmail] = await Promise.all([
    db.query(CALENDAR_FRESHNESS_SQL),
    db.query(GMAIL_FRESHNESS_SQL),
  ]);
  return [
    toFreshness("calendar", calendar.rows[0], now, staleAfterHours),
    toFreshness("gmail", gmail.rows[0], now, staleAfterHours),
  ];
}

export async function imessageFreshness(
  db: QueryExecutor,
  opts: SourceFreshnessOptions = {},
): Promise<SourceFreshness> {
  const now = opts.now?.() ?? new Date();
  const staleAfterHours = parseStaleAfterHours(opts.staleAfterHours);
  const result = await db.query(IMESSAGE_FRESHNESS_SQL);
  return toFreshness("imessage", result.rows[0], now, staleAfterHours);
}

export function freshnessLines(freshness: readonly SourceFreshness[]): string[] {
  const lines: string[] = [];
  for (const entry of freshness) {
    if (!entry.stale) continue;
    lines.push(
      entry.lastSyncedAt === null
        ? `${entry.source} has never synced`
        : `${entry.source} last synced ${entry.ageText} ago`,
    );
  }
  return lines;
}
