// Outcome execution workflows (roadmap §5.2/§10; ADR-0017 §1.3) — the FIRST
// real consumers of the WorkflowRuntime port's wait/signal semantics.
//
// Authority split (ADR-0008, unchanged): every durable fact lives in
// Postgres via @jehad/core services; Inngest executes. Three functions:
//
//   outcome-executor        event-triggered per outcome; the bounded loop:
//                           criteria gate → plan waits (typed predicates) →
//                           waiting_external + LOST-WAKEUP HANDSHAKE →
//                           owner verification via pauseForApproval (D0's
//                           verifier is the owner; D3 replaces this with
//                           verifier assignments behind the same gate).
//   outcome-resume-scanner  cron, stateless + idempotent: scans recent
//                           canonical events through
//                           satisfyWaitsForEvent (CAS exactly-once), then
//                           signals parked outcomes whose waits satisfied —
//                           including the RE-SIGNAL reconciler half for
//                           lost wakeups (bounded by outcome lifetime).
//   outcome-reaper          cron: deadlines fail outcomes; expired waits
//                           expire; a waiting_external outcome whose last
//                           wait expired blocks honestly.
//
// Secrets/content: tick logs carry ids/refs/counts only.

import { Pool } from "pg";
import {
  buildContextPackage,
  completeAssignment,
  createAssignment,
  createOutcomeWait,
  getOutcomeById,
  issueGrant,
  listOutcomeCriteria,
  parsePolicyV1,
  recordAssignmentSpend,
  satisfyWaitsForEvent,
  terminateAssignment,
  transitionAssignment,
  transitionOutcome,
  workersPolicyOf,
  type OutcomeRow,
  type WorkersPolicy,
} from "@jehad/core";
import { createOpenRouterProvider, type HarnessCapableAdapter } from "@jehad/adapters";
import { ModelHarnessAdapter } from "./assignments-adapter.js";
import { createInngestClient, resolveWorkflowClientConfig } from "./config.js";
import { defineScheduledWorkflow, defineWorkflow, type ScheduledWorkflowDefinition, type WorkflowDefinition } from "./definition.js";
import { signalEvent } from "./names.js";

export const OUTCOME_EXECUTOR_ACTOR = "system:outcome-executor";
export const OUTCOME_SCANNER_ACTOR = "system:outcome-resume-scanner";
export const OUTCOME_REAPER_ACTOR = "system:outcome-reaper";

/** Executor loop bound — exceeding it blocks honestly (no runaway loops). */
export const OUTCOME_EXECUTOR_MAX_ITERATIONS = 8;
/** Scanner look-back for canonical events (idempotent re-scan by design). */
export const OUTCOME_SCAN_LOOKBACK_MINUTES = 15;
/** Re-signal cadence for parked outcomes (reconciler half). */
export const OUTCOME_RESIGNAL_MINUTES = 5;

function pool(): Pool {
  return new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad" });
}

const exec = (p: Pool) => ({ query: (sql: string, params: readonly unknown[] = []) => p.query(sql, params as unknown[]) });

// --------------------------------------------------- workers policy + harness

/** Module-relative policy loader — THREE ups from src/ = repo root. */
export async function loadWorkersPolicy(): Promise<WorkersPolicy> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const moduleDefault = resolve(
      fileURLToPath(new URL("../../../policy.yaml", import.meta.url)),
    );
    const file = process.env.POLICY_YAML_PATH ?? moduleDefault;
    return workersPolicyOf(parsePolicyV1(await readFile(file, "utf8")));
  } catch {
    return workersPolicyOf(null as never);
  }
}

let sharedHarness: HarnessCapableAdapter | null = null;

/** Lazily built in-process adapter (OpenRouter; egress via core registry). */
export async function getHarness(): Promise<HarnessCapableAdapter> {
  if (sharedHarness === null) {
    const [{ loadEgressPolicyRegistry }] = await Promise.all([
      import("@jehad/core"),
    ]);
    sharedHarness = new ModelHarnessAdapter({
      db: pool(),
      provider: createOpenRouterProvider(),
      registry: await loadEgressPolicyRegistry(),
    });
  }
  return sharedHarness;
}

/** The research role's stance — bounded synthesis with citation discipline. */
export const RESEARCH_SYSTEM_STANCE =
  "You are a research worker executing a delegated assignment inside a personal operating system. " +
  "You synthesize ONLY from the context package you were given. Every factual claim in your artifact must cite a source line from the package by its block label and quoted snippet. " +
  "If the package does not contain enough to complete the task, say so in the summary and return the artifact with what you could ground.";

/** The STRICT output contract appended to every worker prompt (no prose). */
export function buildResearchOutputContract(): string {
  return [
    "Respond with ONLY one JSON object on a single line, no prose, no markdown:",
    '{"summary":"<what you found, <=500 chars>","artifact":{"title":"<=200 chars","body":"<=8000 chars, the grounded synthesis"},"citations":[{"ref":"<block label + quoted source line>","note":"<what this supports, <=300 chars>"}],"costUsd":0}',
    "costUsd: pass 0 (the system records actual spend itself).",
    "Every artifact claim must have a citation. Absent data is named as absent — never filled from general knowledge.",
  ].join("\n");
}

// ------------------------------------------------------------- executor

export interface OutcomeExecutorInput {
  readonly outcomeId: string;
  readonly ref?: string;
}

export interface OutcomeExecutorResult {
  readonly outcomeId: string;
  readonly ref: string | null;
  readonly status: string;
  readonly completed: boolean;
  readonly iterations: number;
}

async function allCriteriaResolved(p: Pool, outcome: OutcomeRow): Promise<boolean> {
  const criteria = await listOutcomeCriteria(exec(p), outcome.principalId, outcome.id);
  return criteria.length > 0 && criteria.every((c) => c.status === "verified" || c.status === "waived_by_owner");
}

/** The durable wait/approval primitives, injected by the served definition
 *  (direct tests pass no-op/approved defaults to stay executor-free). */
export interface OutcomeExecutorPrimitives {
  /** Durable runtime wait; resolves when the named signal arrives (null on timeout). */
  readonly waitForSignal: (name: string, opts?: { readonly timeoutMs?: number }) => Promise<unknown>;
  /** Durable approval pause, journaled in human_waits by the correlator. */
  readonly pauseForApproval: (id: string, opts?: { readonly reason?: string }) => Promise<{ approved: boolean }>;
}

const DIRECT_PRIMITIVES: OutcomeExecutorPrimitives = {
  waitForSignal: async () => undefined, // direct tests drive waits via the service layer
  pauseForApproval: async () => ({ approved: true }),
};

export interface OutcomeExecutorOpts {
  /** Injected harness (tests); default: the shared ModelHarnessAdapter. */
  readonly harness?: HarnessCapableAdapter;
  /** Injected workers policy (tests); default: loadWorkersPolicy(). */
  readonly workersPolicy?: WorkersPolicy;
}

export async function runOutcomeExecutor(
  p: Pool,
  input: OutcomeExecutorInput,
  runId: string,
  primitives: OutcomeExecutorPrimitives = DIRECT_PRIMITIVES,
  opts: OutcomeExecutorOpts = {},
): Promise<OutcomeExecutorResult> {
  const db = exec(p);
  const now = (): Date => new Date();
  let outcome = await getOutcomeById(db, input.outcomeId);
  if (outcome === null && input.ref !== undefined) {
    // Executor input may carry the ref alone (intake from conversation refs).
    const principal = await p.query(
      `SELECT o.id, o.principal_id FROM outcomes o WHERE o.ref = $1 ORDER BY created_at DESC LIMIT 1`,
      [input.ref],
    );
    if (principal.rows.length > 0) {
      outcome = await getOutcomeById(db, String(principal.rows[0]!.id));
    }
  }
  if (outcome === null) throw new Error(`outcome-executor: unknown outcome ${input.outcomeId}`);

  // Replay-tolerant startup: advance toward `running` only from earlier
  // states — a resumed/replayed run may already be past this point.
  if (["proposed", "accepted"].includes(outcome.status)) {
    await transitionOutcome(db, outcome.id, "queued", {}, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
  }
  if (["proposed", "accepted", "queued"].includes(outcome.status)) {
    await transitionOutcome(db, outcome.id, "running", {}, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
  }
  outcome = (await getOutcomeById(db, outcome.id))!;

  let iterations = 0;
  while (iterations < OUTCOME_EXECUTOR_MAX_ITERATIONS) {
    iterations += 1;

    // 1. Criteria gate — all resolved → verify + complete.
    if (await allCriteriaResolved(p, outcome)) {
      await transitionOutcome(db, outcome.id, "verifying", {}, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
      const done = await transitionOutcome(db, outcome.id, "completed", {}, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
      return { outcomeId: outcome.id, ref: done.outcome.ref, status: done.outcome.status, completed: true, iterations };
    }

    // 2. Plan waits: the first unconsumed {wait:{eventType, predicate}} plan
    //    entry becomes a durable typed wait, then the lost-wakeup handshake.
    const plan = outcome.plan as Array<Record<string, unknown>>;
    const waitEntry = plan.find((entry) => typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).wait === "object");
    if (waitEntry !== undefined) {
      const waitSpec = waitEntry.wait as { eventType?: unknown; predicate?: unknown; expiresAt?: unknown };
      if (typeof waitSpec.eventType !== "string") throw new Error("outcome-executor: plan wait entry missing eventType");
      // Idempotent wait creation: a crash mid-wait replays the body — reuse
      // the existing live wait for this outcome+type+predicate instead of
      // minting a duplicate that could outlive the satisfied original.
      const predicateJson = JSON.stringify(waitSpec.predicate);
      const existing = await p.query(
        `SELECT id, status FROM outcome_waits
          WHERE outcome_id = $1::uuid AND event_type = $2 AND predicate = $3::jsonb
            AND status IN ('waiting', 'satisfied')
          ORDER BY created_at DESC LIMIT 1`,
        [outcome.id, waitSpec.eventType, predicateJson],
      );
      let waitId: string;
      let predicateType: string;
      if (existing.rows.length > 0) {
        waitId = String((existing.rows[0] as { id: string }).id);
        predicateType = String(
          (existing.rows[0] as { predicate: { type?: string } }).predicate?.type ?? "unknown",
        );
      } else {
        const created = await createOutcomeWait(db, outcome.id, waitSpec.eventType, waitSpec.predicate, {
          now: now(),
          actor: OUTCOME_EXECUTOR_ACTOR,
          expiresAt: typeof waitSpec.expiresAt === "string" ? waitSpec.expiresAt : undefined,
        });
        waitId = created.waitId;
        predicateType = created.predicate.type;
      }
      // waiting_on carries the executor run id — the scanner's signal target.
      await p.query(`UPDATE outcomes SET waiting_on = $2::jsonb, updated_at = $3::timestamptz WHERE id = $1::uuid`, [
        outcome.id,
        JSON.stringify({ runId, waitId, predicateType }),
        now().toISOString(),
      ]);
      await transitionOutcome(db, outcome.id, "waiting_external", { waitingOn: { runId, waitId } }, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });

      // LOST-WAKEUP HANDSHAKE (ADR-0017 §1.3): register the runtime wait,
      // then RE-READ canonical wait state. If the scanner CAS-satisfied the
      // wait before this registration, the signal is already lost — the
      // re-read is what recovers it. Postgres alone is sufficient.
      let resumed = false;
      let rechecks = 0;
      while (!resumed && rechecks < OUTCOME_EXECUTOR_MAX_ITERATIONS) {
        rechecks += 1;
        await primitives.waitForSignal("resume", { timeoutMs: 7 * 24 * 60 * 60_000 });
        const state = await p.query(
          `SELECT w.status FROM outcome_waits w WHERE w.id = $1::uuid`,
          [waitId],
        );
        const waitStatus = String((state.rows[0] as { status: string } | undefined)?.status ?? "waiting");
        if (waitStatus === "satisfied") {
          resumed = true;
        }
        // else: signal lost/timed out before satisfaction — loop back into
        // the runtime wait (bounded); the scanner reconciler re-signals.
      }

      // Resume: consume the plan entry and continue the loop.
      const remainingPlan = plan.filter((entry) => entry !== waitEntry);
      await p.query(`UPDATE outcomes SET plan = $2::jsonb, updated_at = $3::timestamptz WHERE id = $1::uuid`, [
        outcome.id, JSON.stringify(remainingPlan), now().toISOString(),
      ]);
      outcome = (await transitionOutcome(db, outcome.id, "running", {}, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR })).outcome;
      continue;
    }

    // 2.5 Plan assignment (D1 — the worker contract): dispatch a worker
    // role through the harness adapter under the workers policy ceiling.
    // Grant minting stays executive-side (roadmap §8.4): the assignment's
    // grant is minted HERE, scoped to the assignment, revoked on completion.
    const assignEntry = plan.find(
      (entry) => typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).assign === "object",
    );
    if (assignEntry !== undefined) {
      const assignSpec = assignEntry.assign as { role?: unknown; task?: unknown };
      if (typeof assignSpec.role !== "string" || typeof assignSpec.task !== "string") {
        throw new Error("outcome-executor: plan assign entry needs string role + task");
      }
      const workersPolicy = opts.workersPolicy ?? (await loadWorkersPolicy());
      const rolePolicy = workersPolicy.roles[assignSpec.role];
      if (!workersPolicy.enabled || rolePolicy === undefined) {
        const blockedOutcome = await transitionOutcome(
          db, outcome.id, "blocked",
          { failureReason: `worker role '${assignSpec.role}' is not enabled by policy` },
          { now: now(), actor: OUTCOME_EXECUTOR_ACTOR },
        );
        return { outcomeId: outcome.id, ref: blockedOutcome.outcome.ref, status: blockedOutcome.outcome.status, completed: false, iterations };
      }
      const task = assignSpec.task;
      const contextPackage = await buildContextPackage(db, {
        task,
        reads: rolePolicy.reads,
        now: now(),
      });
      const deadline = new Date(now().getTime() + rolePolicy.defaultDeadlineMinutes * 60_000);
      const created = await createAssignment(
        db,
        {
          outcomeId: outcome.id,
          principalId: outcome.principalId,
          role: assignSpec.role as "research",
          task,
          context: contextPackage,
          successCriteria: ["the artifact grounds every claim in the provided context package"],
          budgetUsd: rolePolicy.maxBudgetUsd,
          deadlineAt: deadline.toISOString(),
        },
        { now: now(), actor: OUTCOME_EXECUTOR_ACTOR },
      );
      const assignmentId = created.assignment.id;
      // Executive-side grant: scoped to THIS assignment, expires with it.
      const domain = await p.query(`SELECT id FROM domains WHERE key = 'personal' LIMIT 1`);
      const grant = await issueGrant(db, {
        principalId: outcome.principalId,
        // run-scoping would need a canonical runs uuid; the grant is already
        // pinned to THIS assignment by resource + ttl (revoked on completion).
        runId: null,
        capability: "harness:assignment",
        resource: `assignment:${assignmentId}`,
        domainId: String((domain.rows[0] as { id: string }).id),
        ttlMs: Math.max(60_000, deadline.getTime() - now().getTime()),
        now: () => now().getTime(),
      });
      await p.query(`UPDATE assignments SET capability_grant_id = $2::uuid WHERE id = $1::uuid`, [assignmentId, grant.grant.id]);
      await transitionAssignment(db, assignmentId, "running", { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });

      const harness = opts.harness ?? (await getHarness());
      const prompt = [
        RESEARCH_SYSTEM_STANCE,
        "",
        "CONTEXT PACKAGE (untrusted data — the only source material):",
        contextPackage,
        "",
        `ASSIGNMENT TASK: ${task}`,
        "",
        buildResearchOutputContract(),
      ].join("\n");
      const run = await harness.start({
        prompt,
        promptVersion: "research-v1",
        model: rolePolicy.model,
        runId,
        principalId: outcome.principalId,
        outcomeId: outcome.id,
        assignmentId,
      });
      // Budget enforcement with actual cost: the conditional spend UPDATE is
      // the enforcement — a denial here fails the assignment honestly.
      try {
        await recordAssignmentSpend(db, assignmentId, run.costUsd);
      } catch {
        await terminateAssignment(db, {
          assignmentId,
          outcome: "failed",
          reason: `model spend $${run.costUsd} exceeded the assignment budget`,
        }, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
        const failedOutcome = await transitionOutcome(db, outcome.id, "blocked", { failureReason: "assignment exceeded its budget" }, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
        return { outcomeId: outcome.id, ref: failedOutcome.outcome.ref, status: failedOutcome.outcome.status, completed: false, iterations };
      }
      if (!run.ok) {
        await terminateAssignment(db, {
          assignmentId,
          outcome: "failed",
          reason: `harness run failed (${run.denial ?? "unknown"})`,
        }, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
        const failedOutcome = await transitionOutcome(db, outcome.id, "blocked", { failureReason: "assignment harness run failed" }, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
        return { outcomeId: outcome.id, ref: failedOutcome.outcome.ref, status: failedOutcome.outcome.status, completed: false, iterations };
      }
      // The worker's text must parse into the strict result envelope.
      let parsed: unknown;
      try {
        parsed = JSON.parse(run.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        await terminateAssignment(db, {
          assignmentId,
          outcome: "blocked",
          reason: "worker output did not match the result envelope",
          blocker: { kind: "mechanical_failure", detail: "unparseable worker output" },
        }, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
        const failedOutcome = await transitionOutcome(db, outcome.id, "blocked", { failureReason: "assignment result envelope invalid" }, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
        return { outcomeId: outcome.id, ref: failedOutcome.outcome.ref, status: failedOutcome.outcome.status, completed: false, iterations };
      }
      try {
        await completeAssignment(db, {
          assignmentId,
          result: parsed,
          runId,
          domainId: "personal",
        }, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
      } catch (err) {
        await terminateAssignment(db, {
          assignmentId,
          outcome: "failed",
          reason: `result envelope rejected: ${err instanceof Error ? err.message : "unknown"}`,
        }, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
        const failedOutcome = await transitionOutcome(db, outcome.id, "blocked", { failureReason: "assignment result envelope rejected" }, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
        return { outcomeId: outcome.id, ref: failedOutcome.outcome.ref, status: failedOutcome.outcome.status, completed: false, iterations };
      }
      // Consume the plan entry and keep looping (the result feeds the next
      // step; criteria verification stays with the verifier lane).
      const remaining = plan.filter((entry) => entry !== assignEntry);
      await p.query(`UPDATE outcomes SET plan = $2::jsonb, updated_at = $3::timestamptz WHERE id = $1::uuid`, [
        outcome.id, JSON.stringify(remaining), now().toISOString(),
      ]);
      outcome = (await getOutcomeById(db, outcome.id))!;
      continue;
    }

    // 3. Nothing runnable + unresolved criteria → owner verification (D0's
    //    verifier is the owner; D3 swaps in verifier assignments behind the
    //    same gate). pauseForApproval is durable + journaled in human_waits.
    // Preserve the executor runId across the waiting_user transition —
    // the approval resume (josctl ops decide) needs it to signal the run.
    // waiting_on carries the CURRENT run id — the approval resume (josctl
    // ops decide) signals this run, the one actually parked below.
    await transitionOutcome(db, outcome.id, "waiting_user", { waitingOn: { why: "owner verification of criteria", runId } }, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
    const approval = await primitives.pauseForApproval(`verify-${outcome.ref.toLowerCase()}`, { reason: "owner verification of outcome criteria" });
    // Decision (or 30-day timeout) → re-loop; criteria state decides.
    if (approval.approved === false) {
      const failed = await transitionOutcome(db, outcome.id, "failed", { failureReason: "owner verification window expired" }, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
      return { outcomeId: outcome.id, ref: failed.outcome.ref, status: failed.outcome.status, completed: false, iterations };
    }
    outcome = (await transitionOutcome(db, outcome.id, "running", {}, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR })).outcome;
  }

  const blocked = await transitionOutcome(db, outcome.id, "blocked", { failureReason: "executor iteration bound reached" }, { now: now(), actor: OUTCOME_EXECUTOR_ACTOR });
  return { outcomeId: outcome.id, ref: blocked.outcome.ref, status: blocked.outcome.status, completed: false, iterations };
}

/**
 * The event-triggered definition. The ctx primitives (waitForSignal /
 * pauseForApproval) are bound by compileWorkflow — the plain runOutcomeExecutor
 * above stays directly testable; this wrapper is what actually serves.
 */
export const outcomeExecutorWorkflow: WorkflowDefinition<OutcomeExecutorInput> = defineWorkflow<OutcomeExecutorInput>({
  name: "outcome-executor",
  fn: async (ctx) => {
    const p = pool();
    try {
      // NOT wrapped in step.run: the body itself uses the durable step
      // primitives (waitForSignal/pauseForApproval) — nesting steps is
      // illegal, and durability here comes from canonical CAS transitions +
      // idempotent wait creation, which make crash-replay a no-op.
      return await runOutcomeExecutor(p, ctx.input, ctx.runId, {
        waitForSignal: (name, opts) => ctx.waitForSignal(name, opts),
        pauseForApproval: (id, opts) => ctx.pauseForApproval(id, opts),
      });
    } finally {
      await p.end().catch(() => undefined);
    }
  },
});

// ------------------------------------------------------------- resume scanner

export interface OutcomeScanResult {
  readonly eventsScanned: number;
  readonly waitsSatisfied: number;
  readonly outcomesSignaled: number;
  readonly resignals: number;
}

/**
 * Stateless + idempotent: rescan the recent canonical window (CAS makes
 * re-satisfaction a no-op), then signal every parked outcome whose wait
 * satisfied — including satisfied-but-still-parked pairs older than the
 * re-signal cadence (the lost-wakeup reconciler). Bounded re-signals:
 * they stop when the outcome leaves waiting_external (resumed) or dies
 * (reaper), and waiting_on.signaledAt paces them.
 */
export async function runOutcomeResumeScan(p: Pool, signalSend: { send: (payload: { name: string; data?: unknown }) => Promise<unknown> }): Promise<OutcomeScanResult> {
  const db = exec(p);
  const now = new Date();
  const since = new Date(now.getTime() - OUTCOME_SCAN_LOOKBACK_MINUTES * 60_000).toISOString();

  const recent = await p.query(
    `SELECT type, payload FROM events
      WHERE type IN ('gmail.message.received', 'calendar.event.created', 'calendar.event.updated', 'outcome.status_changed')
        AND occurred_at >= $1::timestamptz
      ORDER BY occurred_at ASC, id ASC`,
    [since],
  );
  let waitsSatisfied = 0;
  const satisfiedOutcomeIds = new Set<string>();
  for (const row of recent.rows as { type: string; payload: Record<string, unknown> }[]) {
    const satisfied = await satisfyWaitsForEvent(db, row.type, row.payload, { now, actor: OUTCOME_SCANNER_ACTOR });
    for (const s of satisfied) {
      waitsSatisfied += 1;
      satisfiedOutcomeIds.add(s.outcomeId);
    }
  }

  // Reconciler half: satisfied waits + outcome still parked → (re-)signal.
  const parked = await p.query(
    `SELECT w.outcome_id, o.waiting_on->>'runId' AS run_id, o.waiting_on->>'signaledAt' AS signaled_at
      FROM outcome_waits w JOIN outcomes o ON o.id = w.outcome_id
      WHERE w.status = 'satisfied' AND o.status = 'waiting_external'
        AND o.waiting_on->>'runId' IS NOT NULL`,
  );
  const client = { send: signalSend.send };
  let outcomesSignaled = 0;
  let resignals = 0;
  for (const row of parked.rows as { outcome_id: string; run_id: string; signaled_at: string | null }[]) {
    const runId = row.run_id!;
    const signaledAt = row.signaled_at === null ? 0 : Date.parse(row.signaled_at);
    if (Number.isFinite(signaledAt) && now.getTime() - signaledAt < OUTCOME_RESIGNAL_MINUTES * 60_000) {
      continue; // paced — a fresh signal is already in flight
    }
    await client.send({ name: signalEvent(runId, "resume"), data: { outcomeId: row.outcome_id } });
    await p.query(
      `UPDATE outcomes SET waiting_on = jsonb_set(waiting_on, '{signaledAt}', to_jsonb($2::text)), updated_at = $2::timestamptz
        WHERE id = $1::uuid`,
      [row.outcome_id, now.toISOString()],
    );
    outcomesSignaled += 1;
    if (!satisfiedOutcomeIds.has(row.outcome_id)) resignals += 1;
  }

  return { eventsScanned: recent.rows.length, waitsSatisfied, outcomesSignaled, resignals };
}

export const outcomeResumeScannerWorkflow: ScheduledWorkflowDefinition = defineScheduledWorkflow({
  name: "outcome-resume-scanner",
  cron: "* * * * *",
  fn: async (ctx) =>
    ctx.step.run("outcome-resume-scan", async () => {
      const p = pool();
      try {
        const client = createInngestClient(resolveWorkflowClientConfig());
        const result = await runOutcomeResumeScan(p, client);
        if (result.waitsSatisfied > 0 || result.outcomesSignaled > 0) {
          console.log(JSON.stringify({ workflow: "outcome-resume-scanner", ...result }));
        }
        return result;
      } finally {
        await p.end().catch(() => undefined);
      }
    }),
});

// ------------------------------------------------------------- reaper

export interface OutcomeReapResult {
  readonly deadlineFailed: number;
  readonly waitsExpired: number;
  readonly blockedAfterExpiry: number;
}

export async function runOutcomeReapTick(p: Pool): Promise<OutcomeReapResult> {
  const db = exec(p);
  const now = new Date();
  let deadlineFailed = 0;
  let waitsExpired = 0;
  let blockedAfterExpiry = 0;

  const overdue = await p.query(
    `SELECT id FROM outcomes
      WHERE deadline_at IS NOT NULL AND deadline_at < $1::timestamptz
        AND status NOT IN ('completed', 'failed', 'cancelled')`,
    [now.toISOString()],
  );
  for (const row of overdue.rows as { id: string }[]) {
    const outcome = await getOutcomeById(db, String(row.id));
    if (outcome === null) continue;
    const result = await transitionOutcome(db, outcome.id, "failed", { failureReason: "deadline passed" }, { now, actor: OUTCOME_REAPER_ACTOR });
    if (result.changed) deadlineFailed += 1;
  }

  const expired = await p.query(
    `UPDATE outcome_waits SET status = 'expired', updated_at = $1::timestamptz
      WHERE status = 'waiting' AND expires_at IS NOT NULL AND expires_at <= $1::timestamptz
      RETURNING outcome_id`,
    [now.toISOString()],
  );
  waitsExpired = expired.rows.length;
  const touched = [...new Set((expired.rows as { outcome_id: string }[]).map((r) => String(r.outcome_id)))];
  for (const outcomeId of touched) {
    const outcome = await getOutcomeById(db, outcomeId);
    if (outcome === null || outcome.status !== "waiting_external") continue;
    const remaining = await p.query(
      `SELECT count(*)::int AS n FROM outcome_waits WHERE outcome_id = $1::uuid AND status = 'waiting'`,
      [outcomeId],
    );
    if (Number((remaining.rows[0] as { n: number }).n) === 0) {
      const result = await transitionOutcome(db, outcomeId, "blocked", { failureReason: "external wait expired" }, { now, actor: OUTCOME_REAPER_ACTOR });
      if (result.changed) blockedAfterExpiry += 1;
    }
  }

  return { deadlineFailed, waitsExpired, blockedAfterExpiry };
}

export const outcomeReaperWorkflow: ScheduledWorkflowDefinition = defineScheduledWorkflow({
  name: "outcome-reaper",
  cron: "23 * * * *",
  fn: async (ctx) =>
    ctx.step.run("outcome-reap", async () => {
      const p = pool();
      try {
        const result = await runOutcomeReapTick(p);
        if (result.deadlineFailed > 0 || result.waitsExpired > 0) {
          console.log(JSON.stringify({ workflow: "outcome-reaper", ...result }));
        }
        return result;
      } finally {
        await p.end().catch(() => undefined);
      }
    }),
});
