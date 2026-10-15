// Research executor tests (mission-execution v1) against an isolated
// migrated database: the web grant travels on the spec only when the role
// policy ratifies it, the deadline pre-check never spends a model call, web
// citations survive only mechanical annotation corroboration (public-URL
// guard included), budget/deadline denials block honestly, the plan is
// consumed exactly once, and owner-judgment criteria never dispatch a
// verifier. Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../tests/isolated-db.js";
import { createOutcome, type WorkersPolicy } from "@jehad/core";
import type {
  HarnessCapableAdapter,
  HarnessRunSpec,
  ServerToolUse,
  WebCitation,
} from "@jehad/adapters";
import {
  runOutcomeExecutor,
  type OutcomeExecutorPrimitives,
} from "./outcome-workflows.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-23T12:00:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)("research executor (mission-execution v1: web, citations, gates)", () => {
  let db: IsolatedDb;
  let principalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "resweb");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'research-exec-owner') RETURNING id`,
    );
    principalId = String(row.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  const exec = {
    query: (sql: string, params: readonly unknown[] = []) => db.pool.query(sql, params as unknown[]),
  };

  async function q(sql: string, params: readonly unknown[] = []): Promise<Array<Record<string, unknown>>> {
    return (await db.pool.query(sql, params as unknown[])).rows as Array<Record<string, unknown>>;
  }

  const DIRECTIVE = "Research VendorX's EU data residency posture and answer with current sources";
  const TASK = "Research the delegated question";

  const WEB_ROLE = {
    model: "fake/research-model",
    maxBudgetUsd: 0.05,
    defaultDeadlineMinutes: 30,
    reads: [] as string[],
    web: { enabled: true, maxSearches: 6, maxFetches: 8, maxSourceContentTokens: 12000 },
  };

  const WEB_POLICY: WorkersPolicy = { enabled: true, roles: { research: WEB_ROLE } };
  const NO_WEB_POLICY: WorkersPolicy = {
    enabled: true,
    roles: {
      research: { model: "fake/research-model", maxBudgetUsd: 0.05, defaultDeadlineMinutes: 30, reads: [] },
    },
  };
  const WEB_AND_VERIFIER_POLICY: WorkersPolicy = {
    enabled: true,
    roles: {
      research: WEB_ROLE,
      verifier: { model: "fake/verifier-model", maxBudgetUsd: 0.05, defaultDeadlineMinutes: 15, reads: [] },
    },
  };

  interface ScriptedRun {
    readonly ok: boolean;
    readonly text: string;
    readonly costUsd: number;
    readonly annotations?: readonly WebCitation[];
    readonly serverToolUse?: ServerToolUse;
    readonly denial?: "deadline_exceeded" | "provider_error" | "empty_output";
  }

  /** Captures the FULL spec (incl. web) and replays scripted runs; any start
   *  beyond the script throws (plan-consumed / never-called assertions). */
  function fakeWebHarness(script: readonly ScriptedRun[]): {
    readonly specs: HarnessRunSpec[];
    readonly adapter: HarnessCapableAdapter;
  } {
    const specs: HarnessRunSpec[] = [];
    const adapter: HarnessCapableAdapter = {
      id: "fake-web-harness",
      capabilities: () => ["model:call"],
      start: async (spec) => {
        specs.push(spec);
        if (specs.length > script.length) {
          throw new Error("fake harness: unexpected extra start call");
        }
        const scripted = script[specs.length - 1]!;
        return {
          ok: scripted.ok,
          text: scripted.text,
          costUsd: scripted.costUsd,
          latencyMs: 5,
          ...(scripted.annotations !== undefined ? { annotations: scripted.annotations } : {}),
          ...(scripted.serverToolUse !== undefined ? { serverToolUse: scripted.serverToolUse } : {}),
          ...(scripted.denial !== undefined ? { denial: scripted.denial } : {}),
        };
      },
      status: (runKey: string) => ({ runKey, state: "unknown" as const, latencyMs: null }),
      cancel: async (runKey: string) => ({ cancelled: false, reason: `n/a ${runKey}` }),
      artifacts: async () => ({ text: null }),
    };
    return { specs, adapter };
  }

  const PARKING_PRIMITIVES: OutcomeExecutorPrimitives = {
    waitForSignal: async () => undefined,
    pauseForApproval: async () => {
      throw new Error("owner has not replied yet");
    },
  };
  const APPROVING_PRIMITIVES: OutcomeExecutorPrimitives = {
    waitForSignal: async () => undefined,
    pauseForApproval: async () => ({ approved: true }),
  };

  function researchEnvelope(citations: readonly Record<string, string>[]): string {
    return JSON.stringify({
      summary: "The delegated question is answered with current sources.",
      artifact: { title: "Research findings", body: "Grounded synthesis from the loaded sources." },
      citations,
      confidence: 0.8,
      open_questions: ["paywalled archive sources"],
      costUsd: 0,
    });
  }

  async function seedResearchOutcome(
    options: {
      readonly criteria?: readonly {
        readonly criterion: string;
        readonly verificationMethod?: Record<string, unknown>;
      }[];
      readonly constraints?: readonly string[];
    } = {},
  ): Promise<{ id: string; ref: string }> {
    const created = await createOutcome(
      exec,
      {
        principalId,
        title: "VendorX data residency",
        directive: DIRECTIVE,
        criteria: options.criteria ?? [{ criterion: "the answer cites current sources" }],
        constraints: (options.constraints ?? []).map((text) => ({ text })),
        createdBy: "josctl",
      },
      { now: NOW, actor: "system:outcome-test" },
    );
    await db.pool.query(`UPDATE outcomes SET plan = $2::jsonb WHERE id = $1::uuid`, [
      created.outcome.id,
      JSON.stringify([{ assign: { role: "research", task: TASK } }]),
    ]);
    return { id: created.outcome.id, ref: created.outcome.ref };
  }

  it("web-granted role: spec.web carries the policy caps, promptVersion research-v2-web, mission block in the prompt", async () => {
    const { id, ref } = await seedResearchOutcome({
      criteria: [{ criterion: "the answer cites current sources" }],
      constraints: ["no purchases, read-only research"],
    });
    const harness = fakeWebHarness([
      {
        ok: true,
        text: researchEnvelope([{ ref: "source-1", url: "https://good.example/a" }]),
        costUsd: 0.002,
        annotations: [{ url: "https://good.example/a", title: "Good" }],
      },
    ]);
    await expect(
      runOutcomeExecutor(
        db.pool, { outcomeId: id, ref }, `run-${randomUUID()}`, PARKING_PRIMITIVES,
        { harness: harness.adapter, workersPolicy: WEB_POLICY },
      ),
    ).rejects.toThrow("owner has not replied yet");
    expect(harness.specs).toHaveLength(1);
    const spec = harness.specs[0]!;
    expect(spec.web).toEqual({ maxSearches: 6, maxFetches: 8, maxSourceContentTokens: 12000 });
    expect(spec.promptVersion).toBe("research-v2-web");
    expect(spec.model).toBe("fake/research-model");
    expect(spec.prompt).toContain("ACTUALLY RESEARCH");
    expect(spec.prompt).toContain("READ ONLY");
    expect(spec.prompt).toContain(`Directive: ${DIRECTIVE}`);
    expect(spec.prompt).toContain("Done means:");
    expect(spec.prompt).toContain("- the answer cites current sources");
    expect(spec.prompt).toContain("Constraints:");
    expect(spec.prompt).toContain("- no purchases, read-only research");
    expect(spec.prompt).toContain("Respond with ONLY one JSON object");
    expect(spec.assignmentId).not.toBeNull();
  });

  it("no web grant: spec.web absent, promptVersion research-v1, context-only stance", async () => {
    const { id, ref } = await seedResearchOutcome();
    const harness = fakeWebHarness([
      { ok: true, text: researchEnvelope([{ ref: "gmail.metadata.recent — billing@acme.com" }]), costUsd: 0.001 },
    ]);
    await expect(
      runOutcomeExecutor(
        db.pool, { outcomeId: id, ref }, `run-${randomUUID()}`, PARKING_PRIMITIVES,
        { harness: harness.adapter, workersPolicy: NO_WEB_POLICY },
      ),
    ).rejects.toThrow("owner has not replied yet");
    expect(harness.specs).toHaveLength(1);
    expect(harness.specs[0]!.web).toBeUndefined();
    expect(harness.specs[0]!.promptVersion).toBe("research-v1");
    expect(harness.specs[0]!.prompt).toContain("synthesize ONLY from the context package");
    expect(harness.specs[0]!.prompt).not.toContain("ACTUALLY RESEARCH");
  });

  it("deadline pre-check: an already-passed deadline fails the assignment BEFORE any harness call", async () => {
    const { id, ref } = await seedResearchOutcome();
    const harness = fakeWebHarness([]); // throws on ANY start call
    let tick = NOW.getTime();
    const nowFn = (): Date => {
      const current = tick;
      tick += 61_000;
      return new Date(current);
    };
    const result = await runOutcomeExecutor(
      db.pool, { outcomeId: id, ref }, `run-${randomUUID()}`, APPROVING_PRIMITIVES,
      {
        harness: harness.adapter,
        workersPolicy: {
          enabled: true,
          roles: { research: { ...WEB_ROLE, defaultDeadlineMinutes: 1 } },
        },
        nowFn,
      },
    );
    expect(result.completed).toBe(false);
    expect(result.status).toBe("blocked");
    expect(harness.specs).toHaveLength(0);
    const assignment = await q(`SELECT status, failure_reason FROM assignments WHERE outcome_id = $1::uuid`, [id]);
    expect(assignment).toHaveLength(1);
    expect(String(assignment[0]!.status)).toBe("failed");
    expect(String(assignment[0]!.failure_reason)).toContain("deadline");
    const outcome = await q(`SELECT status, failure_reason FROM outcomes WHERE id = $1::uuid`, [id]);
    expect(String(outcome[0]!.status)).toBe("blocked");
    expect(String(outcome[0]!.failure_reason)).toContain("deadline");
  });

  it("citation corroboration: only the annotation-matched citation lands, with the annotation title backfilled; audit counts kept/dropped", async () => {
    const { id, ref } = await seedResearchOutcome();
    const harness = fakeWebHarness([
      {
        ok: true,
        text: researchEnvelope([
          { ref: "source-1", url: "https://good.example/a" },
          { ref: "source-2", url: "https://invented.example/b" },
        ]),
        costUsd: 0.002,
        annotations: [{ url: "https://good.example/a", title: "Good" }],
        serverToolUse: { webSearchRequests: 2, webFetchRequests: 1 },
      },
    ]);
    await expect(
      runOutcomeExecutor(
        db.pool, { outcomeId: id, ref }, `run-${randomUUID()}`, PARKING_PRIMITIVES,
        { harness: harness.adapter, workersPolicy: WEB_POLICY },
      ),
    ).rejects.toThrow("owner has not replied yet");
    const assignments = await q(`SELECT id, status, result FROM assignments WHERE outcome_id = $1::uuid`, [id]);
    expect(assignments).toHaveLength(1);
    expect(String(assignments[0]!.status)).toBe("succeeded");
    const result = assignments[0]!.result as { citations: Array<{ ref: string; url?: string; title?: string }> };
    expect(result.citations).toEqual([
      { ref: "source-1", url: "https://good.example/a", title: "Good" },
    ]);
    // The corroborated URL landed as real provenance (source_type='url').
    const evidence = await q(
      `SELECT source_ref FROM evidence WHERE source_type = 'url' AND metadata->>'assignmentId' = $1`,
      [String(assignments[0]!.id)],
    );
    expect(evidence.map((row) => String(row.source_ref))).toEqual(["https://good.example/a"]);
    const auditRows = await q(`SELECT outputs_ref FROM audit_log WHERE action = 'assignment.web_tools'`);
    const mine = auditRows
      .map((row) => JSON.parse(String(row.outputs_ref)) as {
        assignmentId?: string;
        citationsKept?: number;
        citationsDropped?: number;
        webSearchRequests?: number | null;
      })
      .find((outputs) => outputs.assignmentId === String(assignments[0]!.id));
    expect(mine).toBeDefined();
    expect(mine!.citationsKept).toBe(1);
    expect(mine!.citationsDropped).toBe(1);
    expect(mine!.webSearchRequests).toBe(2);
  });

  it("all citations uncorroborated → assignment blocked (mechanical_failure) → outcome blocked", async () => {
    const { id, ref } = await seedResearchOutcome();
    const harness = fakeWebHarness([
      {
        ok: true,
        text: researchEnvelope([
          { ref: "source-1", url: "https://invented.example/a" },
          { ref: "source-2", url: "https://also-invented.example/b" },
        ]),
        costUsd: 0.002,
        annotations: [{ url: "https://unrelated.example/other" }],
      },
    ]);
    const result = await runOutcomeExecutor(
      db.pool, { outcomeId: id, ref }, `run-${randomUUID()}`, APPROVING_PRIMITIVES,
      { harness: harness.adapter, workersPolicy: WEB_POLICY },
    );
    expect(result.completed).toBe(false);
    expect(result.status).toBe("blocked");
    const assignment = await q(`SELECT status, failure_reason, blocker FROM assignments WHERE outcome_id = $1::uuid`, [id]);
    expect(String(assignment[0]!.status)).toBe("blocked");
    expect(String(assignment[0]!.failure_reason)).toContain("citation discipline");
    expect((assignment[0]!.blocker as { kind: string }).kind).toBe("mechanical_failure");
    const outcome = await q(`SELECT status FROM outcomes WHERE id = $1::uuid`, [id]);
    expect(String(outcome[0]!.status)).toBe("blocked");
  });

  it("private-URL hostile: an annotation-corroborated link-local citation still fails the public-URL guard → assignment failed → outcome blocked", async () => {
    const { id, ref } = await seedResearchOutcome();
    const harness = fakeWebHarness([
      {
        ok: true,
        text: researchEnvelope([{ ref: "source-1", url: "http://169.254.169.254/latest" }]),
        costUsd: 0.002,
        annotations: [{ url: "http://169.254.169.254/latest", title: "Metadata service" }],
      },
    ]);
    const result = await runOutcomeExecutor(
      db.pool, { outcomeId: id, ref }, `run-${randomUUID()}`, APPROVING_PRIMITIVES,
      { harness: harness.adapter, workersPolicy: WEB_POLICY },
    );
    expect(result.completed).toBe(false);
    expect(result.status).toBe("blocked");
    const assignment = await q(`SELECT status, failure_reason FROM assignments WHERE outcome_id = $1::uuid`, [id]);
    expect(String(assignment[0]!.status)).toBe("failed");
    expect(String(assignment[0]!.failure_reason)).toContain("public http(s) web URL");
    const outcome = await q(`SELECT status FROM outcomes WHERE id = $1::uuid`, [id]);
    expect(String(outcome[0]!.status)).toBe("blocked");
  });

  it("harness run ok:false → assignment failed → outcome blocked", async () => {
    const { id, ref } = await seedResearchOutcome();
    const harness = fakeWebHarness([
      { ok: false, text: "", costUsd: 0.001, denial: "provider_error" },
    ]);
    const result = await runOutcomeExecutor(
      db.pool, { outcomeId: id, ref }, `run-${randomUUID()}`, APPROVING_PRIMITIVES,
      { harness: harness.adapter, workersPolicy: WEB_POLICY },
    );
    expect(result.status).toBe("blocked");
    const assignment = await q(`SELECT status, failure_reason FROM assignments WHERE outcome_id = $1::uuid`, [id]);
    expect(String(assignment[0]!.status)).toBe("failed");
    expect(String(assignment[0]!.failure_reason)).toContain("provider_error");
    const outcome = await q(`SELECT status FROM outcomes WHERE id = $1::uuid`, [id]);
    expect(String(outcome[0]!.status)).toBe("blocked");
  });

  it("costUsd over the role max_budget_usd → assignment failed (exceeded) → outcome blocked, nothing lands", async () => {
    const { id, ref } = await seedResearchOutcome();
    const harness = fakeWebHarness([
      {
        ok: true,
        text: researchEnvelope([{ ref: "source-1", url: "https://good.example/a" }]),
        costUsd: 0.5,
        annotations: [{ url: "https://good.example/a", title: "Good" }],
      },
    ]);
    const result = await runOutcomeExecutor(
      db.pool, { outcomeId: id, ref }, `run-${randomUUID()}`, APPROVING_PRIMITIVES,
      { harness: harness.adapter, workersPolicy: WEB_POLICY },
    );
    expect(result.status).toBe("blocked");
    const assignment = await q(`SELECT id, status, failure_reason, spent_usd FROM assignments WHERE outcome_id = $1::uuid`, [id]);
    expect(String(assignment[0]!.status)).toBe("failed");
    expect(String(assignment[0]!.failure_reason)).toContain("exceeded");
    expect(Number(assignment[0]!.spent_usd)).toBe(0);
    const evidence = await q(
      `SELECT count(*)::int AS n FROM evidence WHERE metadata->>'assignmentId' = $1`,
      [String(assignment[0]!.id)],
    );
    expect(Number(evidence[0]!.n)).toBe(0);
    const outcome = await q(`SELECT status FROM outcomes WHERE id = $1::uuid`, [id]);
    expect(String(outcome[0]!.status)).toBe("blocked");
  });

  it("plan consumed exactly once: after a successful run the replay creates NO second assignment", async () => {
    const { id, ref } = await seedResearchOutcome();
    const harness = fakeWebHarness([
      {
        ok: true,
        text: researchEnvelope([{ ref: "source-1", url: "https://good.example/a" }]),
        costUsd: 0.002,
        annotations: [{ url: "https://good.example/a", title: "Good" }],
      },
    ]);
    const runOpts = { harness: harness.adapter, workersPolicy: WEB_POLICY };
    await expect(
      runOutcomeExecutor(db.pool, { outcomeId: id, ref }, `run-${randomUUID()}`, PARKING_PRIMITIVES, runOpts),
    ).rejects.toThrow("owner has not replied yet");
    const plan = await q(`SELECT plan FROM outcomes WHERE id = $1::uuid`, [id]);
    expect(plan[0]!.plan).toEqual([]);
    expect(harness.specs).toHaveLength(1);

    // Replay: the assign entry is gone — the executor must NOT start the
    // harness again (it would throw); it re-parks on the owner instead.
    await expect(
      runOutcomeExecutor(db.pool, { outcomeId: id, ref }, `run-${randomUUID()}`, PARKING_PRIMITIVES, runOpts),
    ).rejects.toThrow("owner has not replied yet");
    expect(harness.specs).toHaveLength(1);
    const assignments = await q(`SELECT count(*)::int AS n FROM assignments WHERE outcome_id = $1::uuid`, [id]);
    expect(Number(assignments[0]!.n)).toBe(1);
    const outcome = await q(`SELECT status FROM outcomes WHERE id = $1::uuid`, [id]);
    expect(String(outcome[0]!.status)).toBe("waiting_user");
  });

  it("verifier honesty gate: all-owner_judgment criteria + succeeded research → NO verifier assignment (outcome parks on the owner)", async () => {
    const { id, ref } = await seedResearchOutcome({
      criteria: [
        { criterion: "the answer cites current sources", verificationMethod: { kind: "owner_judgment" } },
        { criterion: "no fabricated URLs", verificationMethod: { kind: "owner_judgment" } },
      ],
    });
    const harness = fakeWebHarness([
      {
        ok: true,
        text: researchEnvelope([{ ref: "source-1", url: "https://good.example/a" }]),
        costUsd: 0.002,
        annotations: [{ url: "https://good.example/a", title: "Good" }],
      },
    ]);
    await expect(
      runOutcomeExecutor(
        db.pool, { outcomeId: id, ref }, `run-${randomUUID()}`, PARKING_PRIMITIVES,
        { harness: harness.adapter, workersPolicy: WEB_AND_VERIFIER_POLICY },
      ),
    ).rejects.toThrow("owner has not replied yet");
    expect(harness.specs).toHaveLength(1); // research only — the verifier lane never fired
    const verifier = await q(
      `SELECT count(*)::int AS n FROM assignments WHERE outcome_id = $1::uuid AND role = 'verifier'`,
      [id],
    );
    expect(Number(verifier[0]!.n)).toBe(0);
    const criteria = await q(`SELECT status FROM outcome_criteria WHERE outcome_id = $1::uuid ORDER BY ordinal`, [id]);
    expect(criteria.map((row) => String(row.status))).toEqual(["pending", "pending"]);
    const outcome = await q(`SELECT status FROM outcomes WHERE id = $1::uuid`, [id]);
    expect(String(outcome[0]!.status)).toBe("waiting_user");
  });

  it("production replay regression: a failed research pass consumes the plan at mint — the Inngest-style re-attempt NEVER re-mints, and a blocked outcome never re-parks", async () => {
    // Attempt 1 (the real production shape): the model overshoots the
    // summary bound → envelope rejected → assignment failed → outcome blocked.
    const { id, ref } = await seedResearchOutcome();
    const oversized = JSON.stringify({
      summary: "x".repeat(501),
      artifact: { title: "t", body: "b" },
      citations: [{ ref: "source-1", url: "https://good.example/a" }],
      costUsd: 0,
    });
    const first = fakeWebHarness([{ ok: true, text: oversized, costUsd: 0.002 }]);
    const r1 = await runOutcomeExecutor(
      db.pool, { outcomeId: id, ref }, `run-${randomUUID()}`, PARKING_PRIMITIVES,
      { harness: first.adapter, workersPolicy: WEB_POLICY },
    );
    expect(r1.completed).toBe(false);
    expect(r1.status).toBe("blocked");
    expect(first.specs).toHaveLength(1);

    // Attempt 2 (Inngest-style retry after a late failure): a harness that
    // refuses ANY call — the replay must not spend another model call.
    const refusing = fakeWebHarness([]);
    const r2 = await runOutcomeExecutor(
      db.pool, { outcomeId: id, ref }, `run-${randomUUID()}`, PARKING_PRIMITIVES,
      { harness: refusing.adapter, workersPolicy: WEB_POLICY },
    );
    expect(refusing.specs).toHaveLength(0); // no re-mint, no spend
    expect(r2.completed).toBe(false);
    expect(r2.status).toBe("blocked"); // blocked stays blocked — never re-parked as owner work
    const assignments = await q(`SELECT count(*)::int AS n FROM assignments WHERE outcome_id = $1::uuid`, [id]);
    expect(Number(assignments[0]!.n)).toBe(1);
  });
});
