/**
 * Terminal rendering for `josctl metrics` (plan §14). Pure string formatting
 * of a MetricsReport — no ANSI codes, no deps; output is stable for golden
 * tests. Every line is trailing-whitespace-trimmed.
 */

import type { MetricsReport } from "./compute.js";

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.max(Math.floor(ms), 0)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${totalSeconds % 60}s`;
  }
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatPerDay(perDay: number): string {
  return `${perDay.toFixed(2)}/day`;
}

/** Run ids are verbose; tables show the first 8 chars. */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

interface Column {
  readonly header: string;
  readonly align: "left" | "right";
}

function tableLines(
  indent: string,
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
): string[] {
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const render = (cells: readonly string[]): string =>
    indent +
    cells
      .map((cell, index) =>
        columns[index]!.align === "right" ? cell.padStart(widths[index]!) : cell.padEnd(widths[index]!),
      )
      .join("  ");
  return [render(columns.map((column) => column.header)), ...rows.map(render)];
}

function blank(): string {
  return "";
}

/** Renders the §14 rollup as clean terminal tables. */
export function renderMetricsText(metrics: MetricsReport): string {
  const lines: string[] = [];

  const windowLine =
    metrics.window.since === null
      ? `Jehad OS metrics — all time, generated ${metrics.window.generatedAt}`
      : `Jehad OS metrics — window since ${metrics.window.since}, generated ${metrics.window.generatedAt}`;
  lines.push(windowLine, blank());

  // -- human blocked time ---------------------------------------------------
  lines.push("human blocked time (derived from human_waits — plan §14)");
  lines.push(
    `  total blocked: ${formatMs(metrics.humanBlocked.totalMs)}` +
      `  (open waits now: ${metrics.humanBlocked.openWaits})`,
  );
  lines.push("  by escalation reason:");
  if (metrics.humanBlocked.byReason.length === 0) {
    lines.push("    no resolved waits in window");
  } else {
    lines.push(
      ...tableLines(
        "    ",
        [
          { header: "reason", align: "left" },
          { header: "waits", align: "right" },
          { header: "total", align: "right" },
          { header: "p50", align: "right" },
          { header: "p90", align: "right" },
          { header: "p99", align: "right" },
        ],
        metrics.humanBlocked.byReason.map((row) => [
          row.reason,
          String(row.waits),
          formatMs(row.totalMs),
          formatMs(row.percentiles.p50),
          formatMs(row.percentiles.p90),
          formatMs(row.percentiles.p99),
        ]),
      ),
    );
  }
  lines.push("  runs by blocked time (top 5):");
  if (metrics.humanBlocked.perRun.length === 0) {
    lines.push("    no blocked runs in window");
  } else {
    lines.push(
      ...tableLines(
        "    ",
        [
          { header: "run", align: "left" },
          { header: "waits", align: "right" },
          { header: "blocked", align: "right" },
        ],
        metrics.humanBlocked.perRun.slice(0, 5).map((row) => [
          shortRunId(row.runId),
          String(row.waits),
          formatMs(row.totalMs),
        ]),
      ),
    );
  }
  lines.push(blank());

  // -- interruptions --------------------------------------------------------
  lines.push("interruptions");
  if (metrics.interruptions.total === 0) {
    lines.push("  resolved waits: 0, interruptive verdicts: 0 (nothing in window)");
  } else {
    lines.push(
      `  resolved waits ${metrics.interruptions.resolvedWaits}` +
        ` + interruptive verdicts ${metrics.interruptions.interruptiveVerdicts}` +
        ` = ${metrics.interruptions.total} over ${metrics.interruptions.distinctDays} distinct days` +
        ` → ${formatPerDay(metrics.interruptions.perDay)}`,
    );
  }
  lines.push(blank());

  // -- signal quality (dogfooding feedback) ---------------------------------
  lines.push("signal quality (dogfooding feedback — plan: signal, not parsing)");
  if (metrics.signalQuality === null) {
    lines.push("  no feedback recorded in window (rates null, not zero)");
  } else {
    const sq = metrics.signalQuality;
    lines.push(
      `  verdicts: ${sq.total}` +
        ` (useful ${sq.counts.useful}, noise ${sq.counts.noise}, missed ${sq.counts.missed},` +
        ` incorrect ${sq.counts.incorrect}, interruptive ${sq.counts.interruptive})`,
    );
    lines.push(
      `  rates: useful ${formatPercent(sq.rates.useful ?? 0)}` +
        ` · noise ${formatPercent(sq.rates.noise ?? 0)}` +
        ` · missed ${formatPercent(sq.rates.missed ?? 0)}` +
        ` · incorrect ${formatPercent(sq.rates.incorrect ?? 0)}` +
        ` · interruptive ${formatPercent(sq.rates.interruptive ?? 0)}`,
    );
    if (sq.falseAttentionRate === null) {
      lines.push("  false attention rate: n/a (no noise/useful verdicts on notification or attention items)");
    } else {
      lines.push(
        `  false attention rate: ${formatPercent(sq.falseAttentionRate)}` +
          " (noise / (noise + useful) on notification/attention items)",
      );
    }
    lines.push("  by item type:");
    lines.push(
      ...tableLines(
        "    ",
        [
          { header: "item_type", align: "left" },
          { header: "total", align: "right" },
          { header: "useful", align: "right" },
          { header: "noise", align: "right" },
          { header: "missed", align: "right" },
          { header: "incorrect", align: "right" },
          { header: "interruptive", align: "right" },
        ],
        sq.byItemType.map((row) => [
          row.itemType,
          String(row.total),
          String(row.counts.useful),
          String(row.counts.noise),
          String(row.counts.missed),
          String(row.counts.incorrect),
          String(row.counts.interruptive),
        ]),
      ),
    );
  }
  lines.push(blank());

  // -- autonomous completion ------------------------------------------------
  lines.push("autonomous completion");
  lines.push(
    `  completed ${metrics.autonomousCompletion.completedRuns}` +
      ` / ${metrics.autonomousCompletion.endedRuns} ended runs` +
      ` (${metrics.autonomousCompletion.cancelledExcluded} cancelled excluded)` +
      ` → ${formatPercent(metrics.autonomousCompletion.rate)}`,
  );
  lines.push(blank());

  // -- false escalations ----------------------------------------------------
  lines.push("false escalations");
  lines.push(
    `  not_needed ${metrics.falseEscalation.notNeeded}` +
      ` / ${metrics.falseEscalation.resolved} resolved` +
      ` → ${formatPercent(metrics.falseEscalation.rate)}`,
  );
  lines.push(blank());

  // -- model cost -----------------------------------------------------------
  lines.push("model cost");
  lines.push(`  total: ${formatUsd(metrics.modelCost.totalUsd)} across ${metrics.modelCost.calls} calls`);
  lines.push("  by provider/model:");
  if (metrics.modelCost.byProviderModel.length === 0) {
    lines.push("    no model calls in window");
  } else {
    lines.push(
      ...tableLines(
        "    ",
        [
          { header: "provider", align: "left" },
          { header: "model", align: "left" },
          { header: "calls", align: "right" },
          { header: "cost", align: "right" },
        ],
        metrics.modelCost.byProviderModel.map((row) => [
          row.provider,
          row.model,
          String(row.calls),
          formatUsd(row.costUsd),
        ]),
      ),
    );
  }
  lines.push("  top runs by spend:");
  if (metrics.modelCost.topRuns.length === 0) {
    lines.push("    no spend in window");
  } else {
    lines.push(
      ...tableLines(
        "    ",
        [
          { header: "run", align: "left" },
          { header: "cost", align: "right" },
        ],
        metrics.modelCost.topRuns.map((row) => [shortRunId(row.runId), formatUsd(row.costUsd)]),
      ),
    );
  }
  lines.push(blank());

  // -- runs by status (snapshot) --------------------------------------------
  lines.push("runs by status (snapshot — current state, unwindowed)");
  if (metrics.workflowStatus.statuses.length === 0) {
    lines.push("  no runs");
  } else {
    lines.push(
      ...tableLines(
        "  ",
        [
          { header: "status", align: "left" },
          { header: "runs", align: "right" },
        ],
        metrics.workflowStatus.statuses.map((row) => [row.status, String(row.runs)]),
      ),
    );
  }
  lines.push(blank());

  // -- failures -------------------------------------------------------------
  lines.push("failures");
  lines.push(
    `  action attempts: ${metrics.failures.actionAttempts.failed} failed,` +
      ` ${metrics.failures.actionAttempts.unknown} unknown`,
  );
  lines.push("  outbox error signatures:");
  if (metrics.failures.outboxErrors.length === 0) {
    lines.push("    no failed outbox rows in window");
  } else {
    lines.push(
      ...tableLines(
        "    ",
        [
          { header: "count", align: "right" },
          { header: "signature", align: "left" },
        ],
        metrics.failures.outboxErrors.map((row) => [String(row.count), row.signature]),
      ),
    );
  }

  return lines.map((line) => line.trimEnd()).join("\n") + "\n";
}
