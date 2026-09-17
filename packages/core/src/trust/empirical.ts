/**
 * Empirical trust (owner directive 2026-09-17): model_confidence is
 * UNCALIBRATED evidence. policy_confidence is derived from empirical eval
 * history — the observed precision of past predictions — and the empirical
 * number CAPS the model's claim; it never raises it.
 *
 * Two source shapes are understood (either satisfies `empiricalPrecisionPath`):
 *
 *  - `evals/.last-live.json` — the live-eval runner's output; the empirical
 *    caps are derived from `run.report` (action-driving precision for the
 *    commitment class, overall detection precision otherwise).
 *  - `evals/.empirical-precision.json` — the simple `{ updatedAt, byClass,
 *    byState? }` file the eval runner (W6B) writes.
 *
 * Fail-closed rules: a missing file yields NO caps (callers decide — action
 * contexts cap at FAIL_CLOSED_ACTION_PRECISION, display contexts are
 * uncapped); a malformed file THROWS. Never silently fall back to trusting
 * the model's number.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Conservative precision assumed when no empirical history exists (action contexts). */
export const FAIL_CLOSED_ACTION_PRECISION = 0.5;

/** Thrown for a malformed empirical source — fail closed, never silently. */
export class EmpiricalPrecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmpiricalPrecisionError";
  }
}

/** The validated shape of evals/.empirical-precision.json. */
export interface EmpiricalPrecision {
  readonly updatedAt: string;
  /** Observed precision per proposed class ([0, 1]) — caps, never boosts. */
  readonly byClass: Readonly<Record<string, number>>;
  readonly byState?: Readonly<Record<string, number>>;
  /** Where the numbers came from (file path or "report"). */
  readonly source: string;
}

function requireUnitInterval(where: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new EmpiricalPrecisionError(`${where} must be a number in [0, 1]`);
  }
  return value;
}

function parsePrecisionRecord(value: unknown, where: string): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EmpiricalPrecisionError(`${where} must be an object`);
  }
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = requireUnitInterval(`${where}.${key}`, raw);
  }
  return out;
}

/**
 * Parses/validates the simple `.empirical-precision.json` shape. Unknown
 * extra keys are ignored (forward compatibility); known keys must be valid.
 */
export function parseEmpiricalPrecision(json: unknown, source: string): EmpiricalPrecision {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new EmpiricalPrecisionError(`${source}: empirical precision file must be a JSON object`);
  }
  const obj = json as Record<string, unknown>;
  if (typeof obj.updatedAt !== "string" || obj.updatedAt.length === 0) {
    throw new EmpiricalPrecisionError(`${source}: updatedAt must be a non-empty ISO timestamp`);
  }
  const byClass = parsePrecisionRecord(obj.byClass, `${source}: byClass`);
  const byState =
    obj.byState === undefined ? undefined : parsePrecisionRecord(obj.byState, `${source}: byState`);
  return { updatedAt: obj.updatedAt, byClass, ...(byState === undefined ? {} : { byState }), source };
}

/** Reads a number from a live-run report, tolerating precision|accuracy key variants. */
function reportPrecision(node: Record<string, unknown>, where: string): number | null {
  const raw = node.accuracy ?? node.precision;
  return raw === undefined || raw === null ? null : requireUnitInterval(where, raw);
}

/**
 * Derives the empirical caps from a live-eval run report (the parsed
 * `evals/.last-live.json`). Honest about what a report can measure:
 * commitment → action-driving precision (high-confidence predictions that
 * were real); every other class → overall detection precision. Richer
 * per-class numbers come from the dedicated runner file.
 */
export function empiricalPrecisionFromReport(reportJson: unknown): EmpiricalPrecision {
  const root = reportJson as Record<string, unknown>;
  const run = root?.run;
  if (typeof run !== "object" || run === null) {
    throw new EmpiricalPrecisionError("report: expected a live-run file with a `run` object");
  }
  const report = (run as Record<string, unknown>).report;
  if (typeof report !== "object" || report === null) {
    throw new EmpiricalPrecisionError("report: expected `run.report` (was the live run skipped?)");
  }
  const detection = (report as Record<string, unknown>).detection;
  const actionDriving = (report as Record<string, unknown>).actionDriving;
  if (typeof detection !== "object" || detection === null) {
    throw new EmpiricalPrecisionError("report: run.report.detection is missing");
  }
  const overall = reportPrecision(detection as Record<string, unknown>, "report: detection precision");
  if (overall === null) {
    throw new EmpiricalPrecisionError("report: run.report.detection has no precision");
  }
  const byClass: Record<string, number> = { default: overall };
  if (typeof actionDriving === "object" && actionDriving !== null) {
    const action = reportPrecision(
      actionDriving as Record<string, unknown>,
      "report: actionDriving precision",
    );
    if (action !== null) byClass.commitment = action;
  }
  const ranAt =
    typeof (run as Record<string, unknown>).meta === "object" &&
    (run as Record<string, unknown>).meta !== null &&
    typeof ((run as Record<string, unknown>).meta as Record<string, unknown>).ranAt === "string"
      ? ((run as Record<string, unknown>).meta as Record<string, unknown>).ranAt as string
      : new Date().toISOString();
  return { updatedAt: ranAt, byClass, source: "report" };
}

/**
 * Loads the empirical precision source at `file`. Returns null when the file
 * does not exist (callers fail closed per purpose); throws
 * EmpiricalPrecisionError when it exists but is malformed.
 */
export async function loadEmpiricalPrecision(file: string): Promise<EmpiricalPrecision | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new EmpiricalPrecisionError(`cannot read empirical precision file ${file}: ${String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new EmpiricalPrecisionError(`${file} is not valid JSON: ${String(err)}`);
  }
  // A live-run file (run.report) or the simple runner file (byClass).
  const looksLikeRun =
    typeof json === "object" && json !== null && "run" in (json as Record<string, unknown>);
  return looksLikeRun ? empiricalPrecisionFromReport(json) : parseEmpiricalPrecision(json, file);
}

/** How the capped number will be used — absent history only fails actions closed. */
export type ConfidencePurpose = "action" | "display";

export interface PolicyConfidenceInput {
  /** Proposed class the confidence is attached to (e.g. "commitment"). */
  readonly class: string;
  /**
   * The empirical source: parsed file, or null when absent (missing file /
   * no source configured). An absent source fails action decisions closed.
   */
  readonly empirical: EmpiricalPrecision | null;
  /** Action-driving decisions fail closed without history; display does not. */
  readonly purpose: ConfidencePurpose;
}

/**
 * policy_confidence = min(model_confidence, empiricalByClass ?? model_confidence).
 * The empirical precision CAPS the model's claim — never raises it. A class
 * the empirical source does not cover falls back to byClass.default when
 * present, else is uncapped (per the owner formula) — except that ACTION
 * decisions with no cover at all fail closed at FAIL_CLOSED_ACTION_PRECISION,
 * and a missing source caps action decisions there while leaving
 * display-only numbers untouched.
 */
export function policyConfidence(modelConfidence: number, input: PolicyConfidenceInput): number {
  if (typeof modelConfidence !== "number" || !Number.isFinite(modelConfidence) ||
      modelConfidence < 0 || modelConfidence > 1) {
    throw new RangeError(`modelConfidence must be a number in [0, 1], got ${String(modelConfidence)}`);
  }
  if (input.empirical === null) {
    return input.purpose === "display"
      ? modelConfidence
      : Math.min(modelConfidence, FAIL_CLOSED_ACTION_PRECISION);
  }
  const cap = input.empirical.byClass[input.class] ?? input.empirical.byClass.default;
  if (cap === undefined) {
    return input.purpose === "display"
      ? modelConfidence
      : Math.min(modelConfidence, FAIL_CLOSED_ACTION_PRECISION);
  }
  return Math.min(modelConfidence, cap);
}

/** Serializes an EmpiricalPrecision to the `.empirical-precision.json` shape. */
export function serializeEmpiricalPrecision(p: EmpiricalPrecision): string {
  return `${JSON.stringify(
    { updatedAt: p.updatedAt, byClass: p.byClass, ...(p.byState === undefined ? {} : { byState: p.byState }) },
    null,
    2,
  )}\n`;
}

/** Writes the runner file (future wiring for the W6B eval runner). */
export async function writeEmpiricalPrecision(file: string, p: EmpiricalPrecision): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeEmpiricalPrecision(p), "utf8");
}

/**
 * CLI-free helper for the eval runner: derives the caps from a parsed live-run
 * report and writes the `.empirical-precision.json` file in one step.
 */
export async function writeEmpiricalPrecisionFromReport(
  reportJson: unknown,
  file: string,
): Promise<EmpiricalPrecision> {
  const precision = empiricalPrecisionFromReport(reportJson);
  await writeEmpiricalPrecision(file, precision);
  return precision;
}
