// Calibration service (Lane C1 — the owner's CALIBRATION spec): the daily
// accuracy check. Source-agnostic and additive — it READS the world model
// (calendar projection, commitments, sensor events), renders ONE bounded
// deterministic prompt (spec §5 shape; no telemetry, §16), persists one
// OPEN calibration item per (principal, owner-local civil day, surface),
// and stores the owner's 1-5 rating + free-text misses. Misses land in the
// EXISTING append-only feedback table (verdict 'missed') behind
// redactContent — and NEVER touch memory/candidates (§20: a miss is a
// signal-quality verdict, not a promotion candidate). No LLM anywhere.
//
// Time semantics: period_date is the OWNER-LOCAL civil day (BRIEF_TIMEZONE,
// DST-safe via localDayBounds) — the day the owner is asked about, not the
// UTC day. Audits are metadata-only (§21): ids, counts, ratings — never
// feedback text.

import { recordAudit, type SqlExecutor } from "../actions/audit.js";
import { UUID_RE } from "../events/envelope.js";
import { redactContent } from "../imessage/redact.js";
import { getGmailSyncState } from "../gmail/sync.js";
import { BRIEF_TIMEZONE } from "../briefs/timezone.js";
import { localDayBounds } from "../calendar/projection.js";
import { planDivergence } from "../briefs/divergence.js";
import { createNotification } from "../notifications/service.js";
import { workflowNotificationsConfig } from "../notifications/config.js";
import type { QueryExecutor } from "../queries/executor.js";

/** Everything this service needs from pg.Pool (structural subset). */
export type CalibrationDb = QueryExecutor & SqlExecutor;

// ------------------------------------------------------------- day helpers

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The owner-local civil date (YYYY-MM-DD) of an instant. */
export function civilDateOf(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BRIEF_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * [dayStart, dayEnd) UTC bounds of an owner-local civil date (DST-safe).
 * localDayBounds resolves from a probe instant inside the day; the probe
 * must land on the requested civil date (it always does for offsets within
 * ±12h of UTC — BRIEF_TIMEZONE is UTC-7/-8), else fail honest.
 */
export function civilDayBounds(day: string): { dayStart: Date; dayEnd: Date } {
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new CalibrationInputError(`day must be a YYYY-MM-DD date, got '${day}'`);
  }
  const probe = new Date(`${day}T12:00:00.000Z`);
  const bounds = localDayBounds(probe, BRIEF_TIMEZONE);
  if (civilDateOf(bounds.dayStart) !== day) {
    throw new Error(`civilDayBounds: probe for ${day} resolved to ${civilDateOf(bounds.dayStart)}`);
  }
  return bounds;
}

export class CalibrationInputError extends Error {
  readonly code = "CALIBRATION_INPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "CalibrationInputError";
  }
}

// ---------------------------------------------------------------- summary

/** One connected source's observed counts — lines only, never raw content. */
export interface CalibrationSummaryEntry {
  readonly sourceKey: string;
  readonly label: string;
  readonly lines: readonly string[];
}

/** Source-aware counts snapshot for one owner-local day. */
export interface CalibrationSummary {
  readonly kind: "calibration";
  readonly day: string;
  readonly entries: readonly CalibrationSummaryEntry[];
}

const DOMAIN_KEY = "personal";

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

async function countRows(db: CalibrationDb, sql: string, values: readonly unknown[]): Promise<number> {
  const result = await db.query(sql, values);
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * Collects the day's source-aware counts. CONNECTED sources only: the
 * calendar and gmail entries require their sync-state row to have synced
 * at least once (a sensor that has never run says nothing — and an
 * UNconnected source is NEVER listed, even by name); the world-model
 * commitments entry appears only when something changed. Zero-activity
 * sources are omitted — "I observed" lists what was observed, and a day
 * with no entries is the quiet day. Deterministic order: calendar,
 * commitments, gmail. Counts only — never event or message content.
 */
export async function collectCalibrationSummary(
  db: CalibrationDb,
  opts: { readonly principalId: string; readonly day: string; readonly now?: () => Date },
): Promise<CalibrationSummary> {
  const { dayStart, dayEnd } = civilDayBounds(opts.day);
  const startIso = dayStart.toISOString();
  const endIso = dayEnd.toISOString();
  const entries: CalibrationSummaryEntry[] = [];

  const calendarState = await db.query(
    `SELECT last_synced_at FROM calendar_sync_state WHERE id = 1`,
  );
  const calendarConnected = calendarState.rows[0]?.last_synced_at != null;
  if (calendarConnected) {
    const n = await countRows(
      db,
      `SELECT count(*)::int AS n FROM calendar_events
        WHERE status <> 'cancelled' AND start_time >= $1::timestamptz AND start_time < $2::timestamptz`,
      [startIso, endIso],
    );
    // W5(d) calibration context: same-day plan churn as a count line —
    // plan churn only, never a claim about the day (divergence wording
    // rules). Only when the summary is collected for the CURRENT civil
    // day (the live 20:00 path); later re-collection of a past day skips
    // it (the churn scan is same-day by definition).
    const now = opts.now?.() ?? new Date();
    const divergence =
      civilDateOf(now) === opts.day ? await planDivergence(db, { now, windowStart: dayStart }) : null;
    if (n > 0 || divergence !== null) {
      const lines: string[] = [];
      if (n > 0) lines.push(`${plural(n, "planned calendar item")}`);
      if (divergence !== null) {
        lines.push(`${plural(divergence.churnedCount, "block")} moved or cancelled same-day (plan churn)`);
      }
      entries.push({ sourceKey: "calendar", label: "Calendar", lines });
    }
  }

  const commitments = await countRows(
    db,
    `SELECT count(*)::int AS n FROM commitments c JOIN domains d ON d.id = c.domain_id
      WHERE d.key = $1 AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz`,
    [DOMAIN_KEY, startIso, endIso],
  );
  const completed = await countRows(
    db,
    `SELECT count(*)::int AS n FROM commitments c JOIN domains d ON d.id = c.domain_id
      WHERE d.key = $1 AND c.status = 'met'
        AND c.updated_at >= $2::timestamptz AND c.updated_at < $3::timestamptz`,
    [DOMAIN_KEY, startIso, endIso],
  );
  if (commitments + completed > 0) {
    entries.push({
      sourceKey: "commitments",
      label: "Commitments",
      lines: [`${plural(commitments, "new commitment")}, ${completed} completed`],
    });
  }

  const gmailState = await getGmailSyncState(db);
  if (gmailState !== null && gmailState.lastTickAt !== null) {
    const n = await countRows(
      db,
      `SELECT count(*)::int AS n FROM events ev JOIN domains d ON d.id = ev.domain_id
        WHERE d.key = $1 AND ev.type = 'gmail.message.received'
          AND ev.occurred_at >= $2::timestamptz AND ev.occurred_at < $3::timestamptz`,
      [DOMAIN_KEY, startIso, endIso],
    );
    if (n > 0) {
      entries.push({
        sourceKey: "gmail",
        label: "Gmail",
        lines: [`${n} email${n === 1 ? "" : "s"} received`],
      });
    }
  }

  return { kind: "calibration", day: opts.day, entries };
}

/** A quiet day: no connected source observed anything. */
export function isQuietCalibrationDay(summary: CalibrationSummary): boolean {
  return summary.entries.length === 0;
}

// ---------------------------------------------------------------- prompts

/** §5: single message, bounded. Both renders pin far under this. */
export const CALIBRATION_PROMPT_CHAR_BUDGET = 700;

/** The §5 rating line (both prompt shapes share it). */
export const CALIBRATION_RATING_LINE = "1 very inaccurate · 5 very accurate";

/**
 * The §5 daily-check prompt. Quiet day (no entries) renders the pinned
 * short shape; observed days list the counts as bullets. Pure — no DB, no
 * clock, no model calls; golden tests pin the exact strings.
 */
export function renderCalibrationPrompt(summary: CalibrationSummary): string {
  if (isQuietCalibrationDay(summary)) {
    const quiet = [
      "Jehad OS — daily check",
      "",
      "From my side, very little happened today. How accurate is that?",
      "",
      CALIBRATION_RATING_LINE,
    ].join("\n");
    if (quiet.length > CALIBRATION_PROMPT_CHAR_BUDGET) {
      throw new Error("renderCalibrationPrompt: quiet prompt exceeded the char budget");
    }
    return quiet;
  }
  const lines = [
    "Jehad OS — daily check",
    "",
    "From my side, today looked fairly quiet.",
    "",
    "I observed:",
  ];
  for (const entry of summary.entries) {
    for (const line of entry.lines) lines.push(`• ${line}`);
  }
  lines.push(
    "",
    "How accurate was my picture of your day?",
    CALIBRATION_RATING_LINE,
    "",
    "Anything important happen that I missed?",
  );
  const prompt = lines.map((line) => line.trimEnd()).join("\n");
  if (prompt.length > CALIBRATION_PROMPT_CHAR_BUDGET) {
    throw new Error("renderCalibrationPrompt: prompt exceeded the char budget");
  }
  return prompt;
}

// ------------------------------------------------------------------- rows

export type CalibrationSurface = string;

export interface CalibrationItemRow {
  readonly id: string;
  readonly principalId: string;
  readonly periodDate: string;
  readonly surface: CalibrationSurface;
  readonly status: "open" | "superseded";
  readonly summary: CalibrationSummary;
  readonly promptSentAt: string;
  readonly ratedAt: string | null;
  readonly rating: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const ITEM_COLUMNS = `id, principal_id, period_date, surface, status, summary,
       prompt_sent_at, rated_at, rating, created_at, updated_at`;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function rowToItem(row: Record<string, unknown>): CalibrationItemRow {
  const summary = row.summary;
  if (typeof summary !== "object" || summary === null || Array.isArray(summary)) {
    throw new Error("rowToItem: calibration row has no summary object");
  }
  return {
    id: String(row.id),
    principalId: String(row.principal_id),
    periodDate:
      row.period_date instanceof Date
        ? row.period_date.toISOString().slice(0, 10)
        : String(row.period_date),
    surface: String(row.surface),
    status: String(row.status) as CalibrationItemRow["status"],
    summary: summary as unknown as CalibrationSummary,
    promptSentAt: iso(row.prompt_sent_at),
    ratedAt: isoOrNull(row.rated_at),
    rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

// ------------------------------------------------------------ audit shape

const CALIBRATION_ACTOR = "service:calibration";

/** Metadata-only audit (§21): ids/counts/ratings — never feedback text. */
function calibrationAudit(
  db: CalibrationDb,
  action: "calibration.prompt_sent" | "calibration.rated" | "calibration.missed",
  outputs: Record<string, unknown>,
  at: Date,
): Promise<void> {
  return recordAudit(db, {
    actor: CALIBRATION_ACTOR,
    action,
    reversible: true,
    outputsRef: JSON.stringify({ ...outputs, at: at.toISOString() }),
  });
}

// ------------------------------------------------------------ notify path

const CALIBRATION_PRINCIPAL_UPSERT = `
  WITH ins AS (
    INSERT INTO principals (type, name) VALUES ('service', $1)
    ON CONFLICT (name) DO NOTHING
    RETURNING id
  )
  SELECT id FROM ins
  UNION ALL
  SELECT id FROM principals WHERE name = $1
  LIMIT 1
`;

async function resolveCalibrationServicePrincipal(db: CalibrationDb): Promise<string> {
  const upsert = await db.query(CALIBRATION_PRINCIPAL_UPSERT, ["service/calibration"]);
  const id = upsert.rows[0]?.id;
  if (id === undefined) {
    throw new Error("resolveCalibrationServicePrincipal: could not resolve the service principal");
  }
  return String(id);
}

/**
 * Notification enqueue — the briefs enqueue pattern (enqueueBriefNotification):
 * kind='calibration' next to the item, payload carries the rendered prompt
 * for the edge to deliver verbatim, provenance via sourceType/sourceId. The
 * repo-root policy config is loaded explicitly — the nightly prompt is born
 * approved and claimable (the Sep 16/21 dead letters were the default-config
 * fallback landing it pending).
 */
async function enqueueCalibrationNotification(
  db: CalibrationDb,
  input: {
    readonly item: CalibrationItemRow;
    readonly prompt: string;
    readonly now: Date;
  },
): Promise<void> {
  const domain = await db.query(`SELECT id FROM domains WHERE key = $1`, [DOMAIN_KEY]);
  const domainId = domain.rows[0]?.id;
  if (domainId === undefined) {
    throw new CalibrationInputError(`domain "${DOMAIN_KEY}" is not seeded`);
  }
  const createdBy = await resolveCalibrationServicePrincipal(db);
  await createNotification(
    db,
    {
      kind: "calibration",
      title: "Daily calibration check",
      payload: {
        calibrationItemId: input.item.id,
        periodDate: input.item.periodDate,
        surface: input.item.surface,
        content: input.prompt,
      },
      domainId: String(domainId),
      sourceType: "calibration",
      sourceId: input.item.id,
      createdBy,
    },
    { config: await workflowNotificationsConfig(), actor: CALIBRATION_ACTOR, now: () => input.now },
  );
}

// ------------------------------------------------------------ open (§ send)

export interface OpenCalibrationInput {
  readonly principalId: string;
  /** Owner-local civil day (YYYY-MM-DD). */
  readonly periodDate: string;
  readonly summary: CalibrationSummary;
  readonly surface?: CalibrationSurface;
  readonly now?: () => Date;
}

export interface OpenCalibrationOptions {
  /** E4: also enqueue a kind=calibration notification next to the item. */
  readonly notify?: boolean;
}

export interface OpenCalibrationResult {
  readonly item: CalibrationItemRow;
  /** False when an open item already existed for the period (idempotent). */
  readonly created: boolean;
  /** The rendered §5 prompt for this item (both paths). */
  readonly prompt: string;
}

/**
 * Opens (idempotently) the day's calibration item: one OPEN row per
 * (principal, period_date, surface) enforced by the partial unique index —
 * a repeat call returns the existing item unchanged (created=false, no new
 * notification, no prompt_sent audit). prompt_sent_at stamps the send.
 */
export async function openCalibrationItem(
  db: CalibrationDb,
  input: OpenCalibrationInput,
  opts: OpenCalibrationOptions = {},
): Promise<OpenCalibrationResult> {
  if (!UUID_RE.test(input.principalId)) {
    throw new CalibrationInputError("principalId must be a uuid");
  }
  civilDayBounds(input.periodDate); // validates the shape
  if (input.summary.day !== input.periodDate) {
    throw new CalibrationInputError("summary.day must equal periodDate");
  }
  const surface = input.surface ?? "imessage";
  if (surface.length === 0 || surface.length > 64) {
    throw new CalibrationInputError("surface must be 1..64 chars");
  }
  const now = input.now?.() ?? new Date();

  const existing = await db.query(
    `SELECT ${ITEM_COLUMNS} FROM calibration_items
      WHERE principal_id = $1::uuid AND period_date = $2::date AND surface = $3 AND status = 'open'
      LIMIT 1`,
    [input.principalId, input.periodDate, surface],
  );
  const prior = existing.rows[0];
  if (prior !== undefined) {
    return { item: rowToItem(prior), created: false, prompt: renderCalibrationPrompt(rowToItem(prior).summary) };
  }

  const prompt = renderCalibrationPrompt(input.summary);
  let item: CalibrationItemRow;
  try {
    const inserted = await db.query(
      `INSERT INTO calibration_items
         (principal_id, period_date, surface, summary, prompt_sent_at, created_at, updated_at)
       VALUES ($1::uuid, $2::date, $3, $4::jsonb, $5::timestamptz, $5::timestamptz, $5::timestamptz)
       RETURNING ${ITEM_COLUMNS}`,
      [input.principalId, input.periodDate, surface, JSON.stringify(input.summary), now.toISOString()],
    );
    item = rowToItem(inserted.rows[0]!);
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      // Concurrent open collapsed onto the winner's row (partial unique).
      const winner = await db.query(
        `SELECT ${ITEM_COLUMNS} FROM calibration_items
          WHERE principal_id = $1::uuid AND period_date = $2::date AND surface = $3 AND status = 'open'
          LIMIT 1`,
        [input.principalId, input.periodDate, surface],
      );
      const row = winner.rows[0];
      if (row === undefined) throw err;
      return { item: rowToItem(row), created: false, prompt: renderCalibrationPrompt(rowToItem(row).summary) };
    }
    throw err;
  }

  await calibrationAudit(
    db,
    "calibration.prompt_sent",
    {
      principalId: input.principalId,
      itemId: item.id,
      periodDate: item.periodDate,
      surface,
      entryCount: input.summary.entries.length,
      quiet: isQuietCalibrationDay(input.summary),
    },
    now,
  );
  if (opts.notify === true) {
    await enqueueCalibrationNotification(db, { item, prompt, now });
  }
  return { item, created: true, prompt };
}

// -------------------------------------------------------------- eligibility

export type CalibrationEligibility =
  | { readonly kind: "none" }
  | { readonly kind: "sole"; readonly item: CalibrationItemRow }
  | { readonly kind: "ambiguous"; readonly count: number };

/**
 * The structural ambiguity defense: an inbound rating/miss must resolve to
 * exactly ONE open item for the owner-local TODAY. 0 → none (nothing to
 * rate); 1 → sole; 2+ (e.g. two surfaces both open) → ambiguous — the
 * caller must disambiguate by surface, never guess.
 */
export async function eligibleCalibrationItem(
  db: CalibrationDb,
  opts: { readonly principalId: string; readonly now: Date | (() => Date) },
): Promise<CalibrationEligibility> {
  const now = opts.now instanceof Date ? opts.now : opts.now();
  const today = civilDateOf(now);
  const result = await db.query(
    `SELECT ${ITEM_COLUMNS} FROM calibration_items
      WHERE principal_id = $1::uuid AND period_date = $2::date AND status = 'open'
      ORDER BY surface ASC`,
    [opts.principalId, today],
  );
  const rows = result.rows;
  if (rows.length === 0) return { kind: "none" };
  if (rows.length === 1) return { kind: "sole", item: rowToItem(rows[0]!) };
  return { kind: "ambiguous", count: rows.length };
}

// ------------------------------------------------------------------ rating

export interface StoreRatingInput {
  readonly principalId: string;
  readonly itemId: string;
  /** 1-5 inclusive. */
  readonly rating: number;
  readonly surface?: CalibrationSurface;
  readonly now?: () => Date;
}

export interface StoreRatingResult {
  readonly item: CalibrationItemRow;
  /** The rating this row carried before the write (null on first rate). */
  readonly priorRating: number | null;
}

/**
 * Stores the owner's 1-5 accuracy rating: sets rating + rated_at on the
 * open item. Idempotent re-rate overwrites the SAME row (no append) — both
 * the initial rate and every re-rate audit (prior rating carried in the
 * metadata; ratings are numbers, never text — §21).
 */
export async function storeCalibrationRating(
  db: CalibrationDb,
  input: StoreRatingInput,
): Promise<StoreRatingResult> {
  if (!UUID_RE.test(input.principalId) || !UUID_RE.test(input.itemId)) {
    throw new CalibrationInputError("principalId and itemId must be uuids");
  }
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new CalibrationInputError("rating must be an integer 1-5");
  }
  const now = input.now?.() ?? new Date();

  const prior = await db.query(
    `SELECT rating FROM calibration_items
      WHERE id = $1::uuid AND principal_id = $2::uuid AND status = 'open'`,
    [input.itemId, input.principalId],
  );
  const priorRow = prior.rows[0];
  if (priorRow === undefined) {
    throw new CalibrationNotFoundError(input.itemId);
  }
  const priorRating =
    priorRow.rating === null || priorRow.rating === undefined ? null : Number(priorRow.rating);

  const updated = await db.query(
    `UPDATE calibration_items
       SET rating = $3::smallint, rated_at = $4::timestamptz, updated_at = $4::timestamptz
      WHERE id = $1::uuid AND principal_id = $2::uuid AND status = 'open'
      RETURNING ${ITEM_COLUMNS}`,
    [input.itemId, input.principalId, input.rating, now.toISOString()],
  );
  const row = updated.rows[0];
  if (row === undefined) throw new CalibrationNotFoundError(input.itemId);
  const item = rowToItem(row);

  await calibrationAudit(
    db,
    "calibration.rated",
    {
      principalId: input.principalId,
      itemId: item.id,
      periodDate: item.periodDate,
      rating: input.rating,
      priorRating,
      rerate: priorRating !== null,
      ...(input.surface !== undefined ? { surface: input.surface } : {}),
    },
    now,
  );
  return { item, priorRating };
}

export class CalibrationNotFoundError extends Error {
  readonly code = "CALIBRATION_NOT_FOUND";
  constructor(readonly itemId: string) {
    super(`open calibration item ${itemId} not found for this principal`);
    this.name = "CalibrationNotFoundError";
  }
}

// ------------------------------------------------------------------- miss

/** Free-text miss bound (input), applied BEFORE redaction. */
export const MISSED_TEXT_LIMIT = 500;

/**
 * Known-unconnected source names (fixed list — the sources this deployment
 * has no sensor for). Conservative: a miss mentioning one of these
 * classifies 'source_not_connected'; everything else is 'unknown'.
 */
export const UNCONNECTED_SOURCE_NAMES = [
  "granola", "slack", "github", "linear", "whatsapp", "notion",
] as const;

export type MissCategory = "source_not_connected" | "unknown";

const UNCONNECTED_WORD_RE = new RegExp(
  `\\b(?:${UNCONNECTED_SOURCE_NAMES.join("|")})\\b`,
  "i",
);

/** Pure, deterministic miss classification. */
export function classifyMiss(text: string): MissCategory {
  return UNCONNECTED_WORD_RE.test(text) ? "source_not_connected" : "unknown";
}

export interface StoreMissedFeedbackInput {
  readonly principalId: string;
  /** Null = a whole-day miss (no item linkage). */
  readonly itemId: string | null;
  readonly text: string;
  readonly surface?: CalibrationSurface;
  readonly now?: () => Date;
}

export interface StoreMissedFeedbackResult {
  readonly feedbackId: string;
  readonly category: MissCategory;
  readonly targetType: "whole_day" | "specific_item";
  readonly redacted: boolean;
}

/**
 * Stores one "missed" verdict through the EXISTING append-only feedback
 * path: item_type='calibration', verdict='missed', note = redactContent of
 * the 500-char-bounded text. Target whole_day (itemId null; item_id keys
 * the owner-local day) or specific_item (item-linked). The classifyMiss
 * category lands in source_attribution (documented deviation: no connected
 * source feeds a miss, so the column carries the miss category; the
 * delivery surface rides the audit metadata + calibration_item_id linkage,
 * created_at is the provenance timestamp). NEVER touches memory/candidates
 * (§20) — no candidate row is created anywhere in this module.
 */
export async function storeMissedFeedback(
  db: CalibrationDb,
  input: StoreMissedFeedbackInput,
): Promise<StoreMissedFeedbackResult> {
  if (!UUID_RE.test(input.principalId)) {
    throw new CalibrationInputError("principalId must be a uuid");
  }
  if (input.itemId !== null && !UUID_RE.test(input.itemId)) {
    throw new CalibrationInputError("itemId must be a uuid or null");
  }
  const text = input.text.trim();
  if (text.length === 0) {
    throw new CalibrationInputError("text must be non-empty");
  }
  const bounded = text.slice(0, MISSED_TEXT_LIMIT);
  const redacted = redactContent(bounded);
  const category = classifyMiss(bounded);
  const now = input.now?.() ?? new Date();
  const targetType: StoreMissedFeedbackResult["targetType"] =
    input.itemId === null ? "whole_day" : "specific_item";
  const itemIdKey =
    input.itemId ?? `whole_day:${civilDateOf(now)}`;

  const inserted = await db.query(
    `INSERT INTO feedback
       (item_type, item_id, verdict, note, created_by, created_at,
        target_type, target_ref, source_attribution, calibration_item_id)
     VALUES ('calibration', $1, 'missed', $2, $3, $4::timestamptz,
             $5, $6, $7, $8::uuid)
     RETURNING id`,
    [
      itemIdKey,
      redacted,
      input.principalId,
      now.toISOString(),
      targetType,
      input.itemId,
      category,
      input.itemId,
    ],
  );
  const feedbackId = String(inserted.rows[0]!.id);

  await calibrationAudit(
    db,
    "calibration.missed",
    {
      principalId: input.principalId,
      feedbackId,
      itemId: input.itemId,
      targetType,
      category,
      redacted: redacted !== bounded,
      ...(input.surface !== undefined ? { surface: input.surface } : {}),
    },
    now,
  );
  return {
    feedbackId,
    category,
    targetType,
    redacted: redacted !== bounded,
  };
}

// ------------------------------------------------------------ weekly rollup

export interface WeeklyRollupInput {
  readonly principalId: string;
  /** Inclusive first civil day (YYYY-MM-DD) of the rollup week. */
  readonly weekStart: string;
}

export interface WeeklyRollup {
  readonly weekStart: string;
  /** Mean of the week's ratings; null when 0 days rated. */
  readonly avgRating: number | null;
  readonly daysRated: number;
  readonly missCount: number;
  readonly missCategories: readonly { readonly category: MissCategory | "other"; readonly count: number }[];
  readonly feedbackCounts: { readonly useful: number; readonly noise: number; readonly incorrect: number };
  /** The rendered §13 rollup text (honest small-sample wording). */
  readonly text: string;
}

/** Fewer rated days than this → "too little data" wording. */
export const ROLLUP_MIN_DAYS = 3;

function weekStamp(day: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00.000Z`));
}

/**
 * §13 weekly rollup: average accuracy (null with 0 days), days rated, miss
 * count + categories, and the useful/noise/incorrect counts from the
 * existing feedback path — all principal-scoped over the 7-day window.
 * Small-sample honesty: under ROLLUP_MIN_DAYS rated days the text says too
 * little data instead of an average.
 */
export async function weeklyRollup(
  db: CalibrationDb,
  input: WeeklyRollupInput,
): Promise<WeeklyRollup> {
  if (!UUID_RE.test(input.principalId)) {
    throw new CalibrationInputError("principalId must be a uuid");
  }
  const { dayStart } = civilDayBounds(input.weekStart);
  const windowEnd = new Date(dayStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const weekEnd = civilDateOf(windowEnd);
  const windowStartIso = dayStart.toISOString();
  const windowEndIso = windowEnd.toISOString();

  const ratings = await db.query(
    `SELECT rating FROM calibration_items
      WHERE principal_id = $1::uuid AND rating IS NOT NULL
        AND period_date >= $2::date AND period_date < $3::date`,
    [input.principalId, input.weekStart, weekEnd],
  );
  const values = ratings.rows.map((row) => Number(row.rating));
  const daysRated = values.length;
  const avgRating =
    daysRated === 0
      ? null
      : values.reduce((sum, v) => sum + v, 0) / daysRated;

  const misses = await db.query(
    `SELECT source_attribution, count(*)::int AS n FROM feedback
      WHERE item_type = 'calibration' AND verdict = 'missed'
        AND created_by = $1
        AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
      GROUP BY source_attribution
      ORDER BY source_attribution ASC`,
    [input.principalId, windowStartIso, windowEndIso],
  );
  let missCount = 0;
  const byCategory = new Map<string, number>();
  for (const row of misses.rows) {
    const n = Number(row.n);
    missCount += n;
    const key = row.source_attribution === null || row.source_attribution === undefined ? "other" : String(row.source_attribution);
    byCategory.set(key, (byCategory.get(key) ?? 0) + n);
  }
  const missCategories = [...byCategory.entries()]
    .map(([category, count]) => ({ category: category as MissCategory | "other", count }))
    .sort((a, b) => (a.category < b.category ? -1 : 1));

  const verdicts = await db.query(
    `SELECT verdict, count(*)::int AS n FROM feedback
      WHERE created_by = $1
        AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
        AND verdict IN ('useful', 'noise', 'incorrect')
      GROUP BY verdict`,
    [input.principalId, windowStartIso, windowEndIso],
  );
  const verdictMap = new Map(verdicts.rows.map((row) => [String(row.verdict), Number(row.n)]));
  const feedbackCounts = {
    useful: verdictMap.get("useful") ?? 0,
    noise: verdictMap.get("noise") ?? 0,
    incorrect: verdictMap.get("incorrect") ?? 0,
  };

  return {
    weekStart: input.weekStart,
    avgRating,
    daysRated,
    missCount,
    missCategories,
    feedbackCounts,
    text: renderWeeklyRollup({
      weekStart: input.weekStart,
      avgRating,
      daysRated,
      missCount,
      missCategories,
      feedbackCounts,
    }),
  };
}

/** The §13 rollup text — pure (golden-testable), honest on small samples. */
export function renderWeeklyRollup(
  rollup: Omit<WeeklyRollup, "text">,
): string {
  const lines = [`Calibration — week of ${weekStamp(rollup.weekStart)}`];
  if (rollup.daysRated === 0) {
    lines.push("0 days rated — too little data yet.");
  } else if (rollup.daysRated < ROLLUP_MIN_DAYS) {
    lines.push(`${rollup.daysRated} day${rollup.daysRated === 1 ? "" : "s"} rated — too little data for an average yet.`);
  } else {
    lines.push(
      `${rollup.daysRated} days rated, average accuracy ${rollup.avgRating!.toFixed(1)}/5`,
    );
  }
  if (rollup.missCount === 0) {
    lines.push("Nothing missed.");
  } else {
    const cats = rollup.missCategories.map((c) => `${c.count} ${c.category}`).join(", ");
    lines.push(`${rollup.missCount} missed (${cats})`);
  }
  lines.push(
    `Feedback: ${rollup.feedbackCounts.useful} useful · ${rollup.feedbackCounts.noise} noise · ${rollup.feedbackCounts.incorrect} incorrect`,
  );
  return lines.map((line) => line.trimEnd()).join("\n");
}
