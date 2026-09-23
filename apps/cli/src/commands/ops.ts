/**
 * josctl delegate + josctl ops — the D0 intake path and CR0 (roadmap §16/§19;
 * ADR-0017). Phase-1 pattern: canonical DB read/writes via a local pg pool,
 * executor dispatch through the WorkflowRuntime port (its first `start()`
 * caller).
 *
 *   josctl delegate "<directive>"          — confirm-gated upstream (CLI is
 *                                            the confirm); creates the
 *                                            accepted outcome + starts the
 *                                            executor.
 *   josctl ops now                         — "what is the system doing?"
 *   josctl ops outcome <ref>               — one outcome: status, criteria,
 *                                            waits, waiting_on.
 *   josctl ops criterion <ref> <n> verify|waive
 *                                          — owner verification (D0's
 *                                            verifier is the owner).
 *   josctl ops decide <ref> approve        — signal a parked executor
 *                                            (waiting_user approval resume).
 */

import type { Writable } from "node:stream";
import { Pool } from "pg";
import {
  delegateOutcome,
  getOutcomeByRef,
  listActiveOutcomes,
  listOutcomeCriteria,
  outcomesPolicyOf,
  parsePolicyV1,
  setCriterionStatus,
  type OutcomeRow,
} from "@jehad/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkflowRuntime } from "@jehad/workflow";

export const OPS_USAGE =
  "usage: josctl delegate \"<directive>\"\n" +
  "       josctl ops now\n" +
  "       josctl ops outcome <ref>\n" +
  "       josctl ops criterion <ref> <ordinal> verify|waive\n" +
  "       josctl ops decide <ref> approve\n";

export interface OpsDb {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

function loadOutcomesPolicy() {
  // Module-relative like every other policy loader (cwd-independent).
  const moduleDefault = fileURLToPath(new URL("../../../../policy.yaml", import.meta.url));
  const file = process.env.POLICY_YAML_PATH ?? moduleDefault;
  return outcomesPolicyOf(parsePolicyV1(readFileSync(file, "utf8")));
}

async function ownerPrincipalId(db: OpsDb): Promise<string> {
  const row = await db.query(`SELECT id FROM principals WHERE name = 'josctl' LIMIT 1`);
  if (row.rows.length === 0) throw new Error("ops: josctl principal missing (run pnpm setup:db / migrate)");
  return String(row.rows[0]!.id);
}

function renderOutcome(o: OutcomeRow, criteria: Awaited<ReturnType<typeof listOutcomeCriteria>>): string[] {
  const lines = [
    `OUTCOME ${o.ref} — ${o.title}`,
    `  status:      ${o.status}`,
    `  directive:   ${o.directive}`,
    `  deadline:    ${o.deadlineAt ?? "none"}`,
    `  budget:      ${o.budgetUsd !== null ? `$${o.budgetUsd}` : "none"}`,
    `  waiting on:  ${o.waitingOn ? JSON.stringify(o.waitingOn) : "—"}`,
    `  failure:     ${o.failureReason ?? "—"}`,
    "  criteria:",
  ];
  for (const c of criteria) {
    lines.push(`    ${c.ordinal}. [${c.status}] ${c.criterion}`);
  }
  return lines;
}

export async function runOpsCommand(
  argv: readonly string[],
  opts: { readonly stdout: Writable },
): Promise<number> {
  const sub = argv[3];
  const db = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad" });
  try {
    if (sub === "now") {
      const principalId = await ownerPrincipalId(db);
      const active = await listActiveOutcomes(db, principalId);
      const waitingUser = active.filter((o) => o.status === "waiting_user");
      const waitingExternal = active.filter((o) => o.status === "waiting_external");
      const source = await db.query(`SELECT source, max(recorded_at) AS last FROM events WHERE source LIKE 'adapter:%' GROUP BY source`);
      const spend = await db.query(
        `SELECT COALESCE(sum(cost_usd), 0)::numeric(10, 4) AS c FROM model_calls WHERE created_at::date = now()::date`,
      );
      const lines = [
        "TODAY",
        `  active outcomes:      ${active.length}`,
        `  running/queued:       ${active.filter((o) => ["running", "queued", "verifying", "blocked"].includes(o.status)).length}`,
        `  waiting externally:   ${waitingExternal.length}`,
        `  needs you:            ${waitingUser.length}`,
      ];
      for (const o of waitingUser) lines.push(`    NEEDS YOU ${o.ref} — ${o.title}`);
      for (const o of waitingExternal) lines.push(`    waiting    ${o.ref} — ${o.title} (${JSON.stringify(o.waitingOn ?? {})})`);
      for (const r of source.rows as { source: string; last: string | Date }[]) {
        const hours = r.last === null ? null : (Date.now() - new Date(r.last).getTime()) / 3_600_000;
        lines.push(`  source ${r.source}: ${hours === null ? "never" : `${hours.toFixed(1)}h ago`}${hours !== null && hours > 6 ? "  [STALE]" : ""}`);
      }
      lines.push(`  model spend today: $${String((spend.rows[0] as { c: string }).c)}`);
      opts.stdout.write(lines.join("\n") + "\n");
      return 0;
    }

    if (sub === "outcome") {
      const ref = argv[4];
      if (ref === undefined) {
        opts.stdout.write(OPS_USAGE);
        return 1;
      }
      const principalId = await ownerPrincipalId(db);
      const outcome = await getOutcomeByRef(db, principalId, ref);
      if (outcome === null) {
        opts.stdout.write(`ops: no outcome ${ref}\n`);
        return 1;
      }
      const criteria = await listOutcomeCriteria(db, principalId, outcome.id);
      opts.stdout.write(renderOutcome(outcome, criteria).join("\n") + "\n");
      return 0;
    }

    if (sub === "criterion") {
      const ref = argv[4];
      const ordinal = Number(argv[5]);
      const verdict = argv[6];
      if (ref === undefined || !Number.isInteger(ordinal) || (verdict !== "verify" && verdict !== "waive")) {
        opts.stdout.write(OPS_USAGE);
        return 1;
      }
      const principalId = await ownerPrincipalId(db);
      const outcome = await getOutcomeByRef(db, principalId, ref);
      if (outcome === null) {
        opts.stdout.write(`ops: no outcome ${ref}\n`);
        return 1;
      }
      let evidenceRef: string | undefined;
      if (verdict === "verify") {
        const evidence = await db.query(
          `INSERT INTO evidence (domain_id, source_type, source_ref, claim, observed_at)
           SELECT d.id, 'owner_judgment', $1, $2, now() FROM domains d WHERE d.key = 'personal' RETURNING id`,
          [`outcome:${outcome.id}:criterion:${ordinal}:owner-verified`, `Owner verified criterion ${ordinal} of ${ref}`],
        );
        evidenceRef = String(evidence.rows[0]!.id);
      }
      await setCriterionStatus(
        db, outcome.id, ordinal,
        verdict === "verify" ? "verified" : "waived_by_owner",
        { now: new Date(), actor: "josctl:ops", evidenceRef },
      );
      opts.stdout.write(`criterion ${ordinal} ${verdict === "verify" ? "verified" : "waived"} on ${ref}\n`);
      return 0;
    }

    if (sub === "decide") {
      const ref = argv[4];
      const decision = argv[5];
      if (ref === undefined || decision !== "approve") {
        opts.stdout.write(OPS_USAGE);
        return 1;
      }
      const principalId = await ownerPrincipalId(db);
      const outcome = await getOutcomeByRef(db, principalId, ref);
      if (outcome === null) {
        opts.stdout.write(`ops: no outcome ${ref}\n`);
        return 1;
      }
      const waitingOn = outcome.waitingOn as { runId?: string } | null;
      if (waitingOn?.runId === undefined) {
        opts.stdout.write(`ops: outcome ${ref} is not parked on an executor wait (status ${outcome.status})\n`);
        return 1;
      }
      const runtime = createWorkflowRuntime();
      await runtime.signal({ runId: waitingOn.runId }, { name: `approve:verify:${ref}` });
      opts.stdout.write(`approval signaled for ${ref}\n`);
      return 0;
    }

    opts.stdout.write(OPS_USAGE);
    return 1;
  } finally {
    await db.end();
  }
}

export async function runDelegateCommand(
  argv: readonly string[],
  opts: { readonly stdout: Writable },
): Promise<number> {
  const directive = argv.slice(3).join(" ").trim();
  if (directive.length === 0) {
    opts.stdout.write('usage: josctl delegate "<directive>"\n');
    return 1;
  }
  const db = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad" });
  try {
    const principalId = await ownerPrincipalId(db);
    const created = await delegateOutcome(
      db,
      { principalId, principalName: "josctl", directive, policy: loadOutcomesPolicy() },
      { now: new Date(), actor: "josctl:delegate" },
    );
    // Dispatch the executor through the WorkflowRuntime port — start()'s
    // first real caller (roadmap D0).
    const runtime = createWorkflowRuntime();
    const handle = await runtime.start("outcome-executor", { outcomeId: created.outcome.id, ref: created.outcome.ref });
    opts.stdout.write(
      `outcome ${created.outcome.ref} accepted — executor dispatched (run ${handle.runId})\n` +
      `  criterion: ${created.criteria[0]!.criterion}\n` +
      `  check on it: josctl ops outcome ${created.outcome.ref}\n`,
    );
    return 0;
  } finally {
    await db.end();
  }
}
