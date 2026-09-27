// Shell-trust R6 — the daily dogfood audit (docs/plans/shell-trust.md §8).
// Zero model calls; deterministic SQL joins over the prior day's live data.
//
//   tsx scripts/dogfood-audit.mts [--since 2026-09-27] [--db postgres://...]
//
// Trust flags (a flagged day resets the exit streak; "trust flag" = exactly
// F1–F6):
//   F1 ledger applied/parked/queued with no matching writer-side audit row
//      (operation.<type>.* within the window)
//   F2 a canonical writer audit row (operation.*) with no cognitive.turn
//      ledger entry behind it and no non-conversational provenance
//   F3 shipped reply whose cognitive.turn audit `verified` is outside the
//      sanctioned set {consistent, regenerated, degraded-recovered,
//      degraded-nonjson, availability-notice} — post-R3 anything else
//      shipping is a bug
//   F4 machinery vocabulary in an outbound reply (audit-side scan only;
//      the deleted runtime scan stays dead) — confirm tokens are exempt
//   F5 any policy.load_failed / cognitive.turn_failed /
//      cognitive.degrade_nonjson row
//   F6 a conversational operation executed against a principal other than
//      the conversational principal (cross-principal mutation)
import { readFileSync } from "node:fs";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgv(argv: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--since" || argv[i] === "--db") {
      options.set(argv[i]!.slice(2), argv[i + 1] ?? "");
      i += 1;
    }
  }
  return options;
}

const SANCTIONED_VERIFIED = new Set([
  "consistent",
  "regenerated",
  "degraded-recovered",
  "degraded-nonjson",
  "availability-notice",
]);

// F4: machinery vocabulary that must NEVER appear in a user-facing reply.
// Confirm tokens are the sanctioned exception (the system's own surface).
const MACHINERY_RE =
  /\b(envelope|ledger|mutation window|round results|read catalog|operations_requested|reads_requested|proposal_resolutions|system\.state|work\.status|cognitive|verify pass)\b/i;

async function main(): Promise<void> {
  const options = parseArgv(process.argv.slice(2));
  const since =
    options.get("since") !== undefined
      ? new Date(`${options.get("since")}T00:00:00-07:00`).toISOString()
      : new Date(Date.now() - 24 * 3_600_000).toISOString();
  const connectionString = options.get("db") ?? "postgres://jejo@localhost:5432/jehad";
  const pool = new pg.Pool({ connectionString });

  const flags: string[] = [];
  const log = (...args: unknown[]): void => console.log(...args);
  log(`# dogfood audit — since ${since}`);
  log("");

  // The conversational turns of the window.
  const turns = await pool.query(
    `SELECT id, occurred_at, outputs_ref::jsonb AS o FROM audit_log
      WHERE action = 'cognitive.turn' AND occurred_at >= $1::timestamptz
      ORDER BY occurred_at`,
    [since],
  );
  log(`turns: ${turns.rows.length}`);

  // F3 + per-turn ledger collection (F1 input).
  const ledgerEntries: { opType: string; status: string; at: string }[] = [];
  for (const row of turns.rows) {
    const verified = String(row.o["verified"] ?? "");
    if (!SANCTIONED_VERIFIED.has(verified)) {
      flags.push(`F3 ${row.occurred_at}: verified="${verified}" shipped (notification ${String(row.o["notificationId"] ?? "?")})`);
    }
    for (const entry of (row.o["ledger"] ?? []) as { opType?: string; status?: string }[]) {
      if (typeof entry.opType === "string" && typeof entry.status === "string") {
        ledgerEntries.push({ opType: entry.opType, status: entry.status, at: String(row.occurred_at) });
      }
    }
  }

  // F1: every applied/parked/queued ledger entry needs a writer-side
  // operation audit row within ±60s.
  for (const entry of ledgerEntries) {
    if (entry.status !== "applied" && entry.status !== "parked" && entry.status !== "queued") continue;
    const writer = await pool.query(
      `SELECT 1 FROM audit_log
        WHERE action LIKE $1 AND occurred_at BETWEEN $2::timestamptz - interval '60 seconds'
                                            AND $2::timestamptz + interval '60 seconds'
        LIMIT 1`,
      [`operation.${entry.opType}.%`, entry.at],
    );
    if (writer.rows.length === 0) {
      flags.push(`F1 ${entry.at}: ledger ${entry.opType} ${entry.status} with NO writer-side audit row`);
    }
  }

  // F2: conversational writer rows with no cognitive turn behind them.
  const strayOps = await pool.query(
    `SELECT a.occurred_at, a.action, a.outputs_ref::jsonb AS o FROM audit_log a
      WHERE a.action LIKE 'operation.%' AND a.occurred_at >= $1::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM audit_log t
           WHERE t.action = 'cognitive.turn'
             AND t.occurred_at BETWEEN a.occurred_at - interval '120 seconds'
                                   AND a.occurred_at + interval '120 seconds'
        )
        AND NOT EXISTS (
          SELECT 1 FROM audit_log j
           WHERE j.action LIKE 'josctl.%' AND j.actor LIKE 'user:%'
             AND j.occurred_at BETWEEN a.occurred_at - interval '10 seconds'
                                   AND a.occurred_at + interval '10 seconds'
        )`,
    [since],
  );
  for (const row of strayOps.rows) {
    flags.push(`F2 ${row.occurred_at}: ${row.action} with no conversational turn or CLI provenance`);
  }

  // F4: machinery vocabulary in outbound replies (confirm tokens exempt —
  // the 5-char token alone never matches the vocabulary list).
  const replies = await pool.query(
    `SELECT id, created_at, payload->>'content' AS c, recipient FROM notifications
      WHERE kind = 'reply' AND created_at >= $1::timestamptz`,
    [since],
  );
  log(`replies: ${replies.rows.length}`);
  for (const row of replies.rows) {
    const content = String(row.c ?? "");
    if (MACHINERY_RE.test(content)) {
      flags.push(`F4 ${row.created_at} → ${row.recipient}: machinery vocabulary in reply: "${content.slice(0, 120)}"`);
    }
  }

  // F5: availability/degrade-class audit rows.
  const f5 = await pool.query(
    `SELECT occurred_at, action FROM audit_log
      WHERE action IN ('policy.load_failed', 'cognitive.turn_failed', 'cognitive.degrade_nonjson')
        AND occurred_at >= $1::timestamptz`,
    [since],
  );
  for (const row of f5.rows) {
    flags.push(`F5 ${row.occurred_at}: ${row.action}`);
  }

  // F6: conversational operations against a non-conversational principal.
  const owner = await pool.query(`SELECT id FROM principals WHERE name = 'josctl' LIMIT 1`);
  const ownerId = owner.rows[0] !== undefined ? String(owner.rows[0]!.id) : null;
  if (ownerId !== null) {
    const f6 = await pool.query(
      `SELECT occurred_at, action, outputs_ref::jsonb AS o FROM audit_log
        WHERE action LIKE 'operation.%' AND occurred_at >= $1::timestamptz
          AND outputs_ref::jsonb->>'principalId' IS NOT NULL
          AND outputs_ref::jsonb->>'principalId' <> $2`,
      [since, ownerId],
    );
    for (const row of f6.rows) {
      flags.push(`F6 ${row.occurred_at}: ${row.action} executed against principal ${String(row.o["principalId"] ?? "?")}`);
    }
  }

  // Summary.
  const replyTurns = turns.rows.length;
  const noticeTurns = turns.rows.filter(
    (row) => String(row.o["verified"] ?? "") === "availability-notice",
  ).length;
  log(`availability-notice turns: ${noticeTurns}/${Math.max(1, replyTurns)}`);
  log("");
  if (flags.length === 0) {
    log("## trust flags: NONE — the day counts (if the §8 volume/class bar is met)");
  } else {
    log(`## trust flags: ${flags.length} — the day RESETS the streak`);
    for (const flag of flags) log(`- ${flag}`);
  }
  await pool.end();
  process.exitCode = flags.length === 0 ? 0 : 1;
}

// The script is invoked directly (tsx scripts/dogfood-audit.mts).
if (process.argv[1] !== undefined && path.resolve(process.argv[1]!) === fileURLToPath(import.meta.url)) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
void readFileSync;
