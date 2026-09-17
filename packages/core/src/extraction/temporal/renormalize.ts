/**
 * Re-normalization without re-extraction (extraction v3; owner temporal
 * directive 2026-09-17): re-runs the CURRENT deterministic normalizer over
 * stored commitments' temporal.rawExpression + anchorTime, refreshing
 * normalizedTime/due_at and the normalizer version stamp. The stored
 * EXPRESSION and anchor are immutable provenance — only the resolution is
 * recomputed, so a normalizer rule fix heals every stored commitment without
 * paying for a single model call.
 */

import type { TemporalProvenance } from "../../memory/candidate-contract.js";
import {
  DEFAULT_ANCHOR_TIMEZONE,
  NORMALIZER_VERSION,
  normalizeTemporalExpression,
  normalizedTimeToInstant,
} from "./normalizer.js";

/** Structural slice of a pg Pool/client — no pg import in core. */
export interface RenormalizeSql {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface RenormalizeResult {
  /** Commitments rows carrying a temporal block with a raw expression. */
  readonly scanned: number;
  /** Rows whose recomputed temporal block (or due_at) actually changed. */
  readonly updated: number;
}

function storedTimezone(temporal: Record<string, unknown>): string {
  const tz = temporal.anchorTimezone;
  return typeof tz === "string" && tz.trim().length > 0 ? tz : DEFAULT_ANCHOR_TIMEZONE;
}

function dueAtFor(fresh: TemporalProvenance): string | null {
  if (fresh.resolutionStatus !== "resolved" || fresh.normalizedTime === null) return null;
  // due_at only ever carries a NORMALIZED, resolved date — ambiguous or
  // unsupported expressions land null, never a fabricated date.
  return normalizedTimeToInstant(fresh.normalizedTime, fresh.anchorTimezone);
}

/**
 * Re-runs the current normalizer (NORMALIZER_VERSION) over every stored
 * commitment that has a temporal expression. Rows already at the current
 * version with identical output are skipped (update count reflects real
 * changes); rows resolved by a NEW rule or fixed rule heal in place.
 */
export async function renormalizeTemporal(db: RenormalizeSql): Promise<RenormalizeResult> {
  const result = await db.query(
    `SELECT id, temporal, due_at FROM commitments
     WHERE temporal IS NOT NULL AND temporal->>'rawExpression' IS NOT NULL
     ORDER BY created_at`,
  );

  let updated = 0;
  for (const row of result.rows) {
    const stored = row.temporal as Record<string, unknown>;
    const rawExpression = typeof stored.rawExpression === "string" ? stored.rawExpression : null;
    const anchorTime = typeof stored.anchorTime === "string" ? stored.anchorTime : "";
    if (rawExpression === null || anchorTime === "") continue;

    const fresh = normalizeTemporalExpression({
      expression: rawExpression,
      anchorTime,
      anchorTimezone: storedTimezone(stored),
    });
    const dueAt = dueAtFor(fresh);

    const changed =
      (stored.normalizerVersion as string | undefined) !== NORMALIZER_VERSION ||
      (stored.normalizedTime as string | null | undefined) !== fresh.normalizedTime ||
      (stored.resolutionStatus as string | undefined) !== fresh.resolutionStatus ||
      (stored.resolutionMethod as string | null | undefined) !== fresh.resolutionMethod ||
      (row.due_at === null) !== (dueAt === null) ||
      (dueAt !== null && row.due_at !== null && new Date(row.due_at as string).getTime() !== new Date(dueAt).getTime());
    if (!changed) continue;

    await db.query(
      `UPDATE commitments
       SET temporal = $2::jsonb, due_at = $3::timestamptz, updated_at = now()
       WHERE id = $1::uuid`,
      [String(row.id), JSON.stringify(fresh), dueAt],
    );
    updated += 1;
  }

  return { scanned: result.rows.length, updated };
}
