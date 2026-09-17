// ActionService integration tests (ADR-0011; plan §15 M4 proving tests).
// Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set. Uses an
// isolated per-file database. Hermetic: the only provider is the in-memory
// fake — no real external calls (plan §13).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeActionProvider } from "@jehad/adapters";
import { migrateUp } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { issueGrant } from "../policy/grants.js";
import {
  ActionService,
  GrantDeniedError,
  InvalidAttemptTransitionError,
  InvalidIntentTransitionError,
  MissingProviderRefError,
  type ActionIntentRecord,
} from "./action-service.js";
import { ActionProhibitedError } from "./autonomy.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("ActionService (integration)", () => {
  let db: IsolatedDb;
  let domainId: string;
  let principalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "actions");
    await migrateUp(db.pool);
    const domain = await db.pool.query(
      `INSERT INTO domains (key, name, sensitivity, retention_class)
       VALUES ('personal', 'Personal', 'normal', 'default') RETURNING id`,
    );
    domainId = String(domain.rows[0]!.id);
    const principal = await db.pool.query(
      `INSERT INTO principals (type, name, credential_hash)
       VALUES ('user', 'm4b-test', NULL) RETURNING id`,
    );
    principalId = String(principal.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function newRun(): Promise<string> {
    const run = await db.pool.query(
      `INSERT INTO runs (kind, status, domain_id, principal_id)
       VALUES ('workflow', 'running', $1, $2) RETURNING id`,
      [domainId, principalId],
    );
    return String(run.rows[0]!.id);
  }

  function service(behavior: ConstructorParameters<typeof FakeActionProvider>[0] = "succeed") {
    const provider = new FakeActionProvider(behavior);
    return { provider, svc: new ActionService(db.pool, provider) };
  }

  async function preparedIntent(
    svc: ActionService,
    runId: string,
    capability = "act:fake",
  ): Promise<ActionIntentRecord> {
    const intent = await svc.createIntent({
      runId,
      actionType: "external_side_effect",
      capability,
      resource: "fake:send",
      domainId,
      payload: { note: "hello" },
      actor: "user:m4b-test",
    });
    await svc.approveIntent({ intentId: intent.id, actor: "user:m4b-test" });
    return svc.prepareIntent({ intentId: intent.id, actor: "user:m4b-test" });
  }

  /** Mints a live capability grant for the fake provider (plan §15 M4). */
  async function grantTokenFor(
    intent: ActionIntentRecord,
    overrides: Partial<Parameters<typeof issueGrant>[1]> = {},
  ): Promise<string> {
    const issued = await issueGrant(db.pool, {
      principalId,
      runId: null,
      capability: "act:fake",
      resource: intent.resource,
      domainId: intent.domainId,
      ttlMs: 60_000,
      ...overrides,
    });
    return issued.token;
  }

  async function dispatch(svc: ActionService, intent: ActionIntentRecord, grantToken: string) {
    return svc.startAttempt({
      intentId: intent.id,
      actor: "user:m4b-test",
      grantToken,
      principalId,
    });
  }

  async function auditFor(intentId: string) {
    const result = await db.pool.query(
      "SELECT actor, action, inputs_ref, outputs_ref, action_intent_id, action_attempt_id, reversible FROM audit_log WHERE action_intent_id = $1 ORDER BY created_at, id",
      [intentId],
    );
    return result.rows;
  }

  it("timeout-after-dispatch → outcome unknown; audit never claims success", async () => {
    const runId = await newRun();
    const { provider, svc } = service("timeout-after-dispatch");
    const intent = await preparedIntent(svc, runId);

    const attempt = await dispatch(svc, intent, await grantTokenFor(intent));

    expect(attempt.outcome).toBe("unknown");
    expect(attempt.error).toContain("response lost");
    expect(provider.effects).toHaveLength(1); // the effect DID happen provider-side
    const after = await svc.getIntent(intent.id);
    expect(after.status).toBe("prepared"); // intents never hold execution state

    const rows = await auditFor(intent.id);
    const preEffect = rows.find((r) => r.action === "action.attempt.pre_effect");
    expect(preEffect).toBeDefined();
    expect(preEffect!.action_intent_id).toBe(intent.id);
    expect(preEffect!.action_attempt_id).toBeNull(); // pre-effect records intent only
    const outcomeRow = rows.find((r) => r.action === "action.attempt.outcome");
    expect(outcomeRow).toBeDefined();
    expect(outcomeRow!.action_intent_id).toBe(intent.id);
    expect(outcomeRow!.action_attempt_id).toBe(attempt.id);
    expect(String(outcomeRow!.outputs_ref)).toContain('"outcome":"unknown"');

    for (const row of rows) {
      const text = `${row.action} ${row.inputs_ref ?? ""} ${row.outputs_ref ?? ""}`;
      expect(text).not.toContain("succeeded"); // nothing claims unobserved success
    }
  });

  it("one intent → many attempts; earlier ambiguous history preserved after retry", async () => {
    const runId = await newRun();
    const { provider, svc } = service("timeout-after-dispatch");
    const intent = await preparedIntent(svc, runId);

    const first = await dispatch(svc, intent, await grantTokenFor(intent));
    expect(first.outcome).toBe("unknown");

    provider.behavior = "succeed";
    const second = await dispatch(svc, intent, await grantTokenFor(intent));
    expect(second.outcome).toBe("succeeded");

    const history = await svc.listAttempts(intent.id);
    expect(history).toHaveLength(2);
    expect(history[0]!.id).toBe(first.id);
    expect(history[0]!.outcome).toBe("unknown"); // never overwritten
    expect(history[0]!.providerRef).toBeNull();
    expect(history[1]!.outcome).toBe("succeeded");
    expect(provider.effects).toHaveLength(1); // retry reused the key: no double effect
  });

  it("reconciliation: unknown → reconciled with provider_ref recorded", async () => {
    const runId = await newRun();
    const { provider, svc } = service("timeout-after-dispatch");
    const intent = await preparedIntent(svc, runId);
    const attempt = await dispatch(svc, intent, await grantTokenFor(intent));
    expect(attempt.outcome).toBe("unknown");

    const status = provider.statusForKey(attempt.idempotencyKey!);
    expect(status?.status).toBe("succeeded"); // provider-side truth via provider ref

    const reconciled = await svc.reconcileAttempt({
      intentId: intent.id,
      attemptId: attempt.id,
      actor: "user:m4b-test",
      providerRef: status!.providerRef!,
    });
    expect(reconciled.outcome).toBe("reconciled");
    expect(reconciled.providerRef).toBe(status!.providerRef);

    const rows = await auditFor(intent.id);
    const reconciledRow = rows.find((r) => r.action === "action.attempt.reconciled");
    expect(reconciledRow!.action_attempt_id).toBe(attempt.id);
    expect(String(reconciledRow!.outputs_ref)).toContain(status!.providerRef!);

    await expect(
      svc.reconcileAttempt({
        intentId: intent.id,
        attemptId: attempt.id,
        actor: "user:m4b-test",
        providerRef: "ref-again",
      }),
    ).rejects.toBeInstanceOf(InvalidAttemptTransitionError);
  });

  it("R2 regression: recordOutcome(succeeded) without a providerRef is a typed rejection", async () => {
    const runId = await newRun();
    const { svc } = service("succeed");
    const intent = await preparedIntent(svc, runId);
    // An attempt still 'executing' (direct insert — the raw state a provider
    // callback would find). Before R2 the service happily recorded
    // succeeded with a NULL providerRef; audit could then lie.
    const inserted = await db.pool.query(
      `INSERT INTO action_attempts (intent_id, provider, idempotency_key, started_at, outcome)
       VALUES ($1, 'fake', $2, now(), 'executing') RETURNING id`,
      [intent.id, `idem_${randomUUID()}`],
    );
    const attemptId = String(inserted.rows[0]!.id);

    await expect(
      svc.recordOutcome({ intentId: intent.id, attemptId, actor: "user:m4b-test", outcome: "succeeded" }),
    ).rejects.toBeInstanceOf(MissingProviderRefError);
    await expect(
      svc.recordOutcome({ intentId: intent.id, attemptId, actor: "user:m4b-test", outcome: "succeeded", providerRef: "" }),
    ).rejects.toBeInstanceOf(MissingProviderRefError);

    // The attempt is untouched — no outcome row, no audit claim.
    const rows = await db.pool.query("SELECT outcome FROM action_attempts WHERE id = $1", [attemptId]);
    expect(rows.rows[0]!.outcome).toBe("executing");
    const audits = await auditFor(intent.id);
    expect(audits.find((r) => r.action === "action.attempt.outcome")).toBeUndefined();

    // failed still needs no ref; with a ref it is accepted.
    const failed = await svc.recordOutcome({
      intentId: intent.id, attemptId, actor: "user:m4b-test", outcome: "failed", error: "boom",
    });
    expect(failed.outcome).toBe("failed");
  });

  it("R2 regression: reconcileAttempt with an empty providerRef is a typed rejection", async () => {
    const runId = await newRun();
    const { svc } = service("timeout-after-dispatch");
    const intent = await preparedIntent(svc, runId);
    const attempt = await dispatch(svc, intent, await grantTokenFor(intent));
    expect(attempt.outcome).toBe("unknown");

    await expect(
      svc.reconcileAttempt({ intentId: intent.id, attemptId: attempt.id, actor: "user:m4b-test", providerRef: "" }),
    ).rejects.toBeInstanceOf(MissingProviderRefError);
    await expect(
      svc.reconcileAttempt({ intentId: intent.id, attemptId: attempt.id, actor: "user:m4b-test", providerRef: "   " }),
    ).rejects.toBeInstanceOf(MissingProviderRefError);
    expect((await svc.listAttempts(intent.id))[0]!.outcome).toBe("unknown"); // untouched
  });

  describe("R9: grant possession at dispatch (plan §15 M4)", () => {
    it("no/garbage token → typed GrantDeniedError, audit row, no attempt, no dispatch", async () => {
      const runId = await newRun();
      const { provider, svc } = service("succeed");
      const intent = await preparedIntent(svc, runId);

      for (const badToken of ["", "not-a-token"]) {
        await expect(dispatch(svc, intent, badToken)).rejects.toBeInstanceOf(GrantDeniedError);
      }
      expect(provider.requests).toHaveLength(0); // provider never invoked
      expect(await svc.listAttempts(intent.id)).toHaveLength(0); // no attempt row

      const denials = await db.pool.query(
        "SELECT action, outputs_ref FROM audit_log WHERE action_intent_id = $1 AND action = 'action.attempt.grant_denied'",
        [intent.id],
      );
      expect(denials.rows).toHaveLength(2);
      expect(String(denials.rows[0]!.outputs_ref)).toContain("malformed_token");
      expect(String(denials.rows[0]!.outputs_ref)).toContain('"act:fake"');
    });

    it("grant scoped to another capability/resource/domain → denied", async () => {
      const runId = await newRun();
      const { svc } = service("succeed");
      const intent = await preparedIntent(svc, runId);

      const wrongCapability = await grantTokenFor(intent, { capability: "act:other" });
      await expect(dispatch(svc, intent, wrongCapability)).rejects.toMatchObject({
        name: "GrantDeniedError",
        reason: "wrong_capability",
      });

      const wrongResource = await grantTokenFor(intent, { resource: "fake:elsewhere" });
      await expect(dispatch(svc, intent, wrongResource)).rejects.toMatchObject({
        name: "GrantDeniedError",
        reason: "wrong_resource",
      });

      const otherDomain = await db.pool.query(
        `INSERT INTO domains (key, name, sensitivity, retention_class)
         VALUES ('research', 'Research', 'normal', 'default') RETURNING id`,
      );
      const wrongDomain = await grantTokenFor(intent, {
        domainId: String(otherDomain.rows[0]!.id),
      });
      await expect(dispatch(svc, intent, wrongDomain)).rejects.toMatchObject({
        name: "GrantDeniedError",
        reason: "wrong_domain",
      });
      expect(await svc.listAttempts(intent.id)).toHaveLength(0);
    });

    it("an expired grant denies", async () => {
      const runId = await newRun();
      const { svc } = service("succeed");
      const intent = await preparedIntent(svc, runId);

      const expired = await issueGrant(db.pool, {
        principalId, runId: null, capability: "act:fake", resource: intent.resource,
        domainId: intent.domainId, ttlMs: 1, now: () => Date.now() - 10_000,
      });
      await expect(dispatch(svc, intent, expired.token)).rejects.toMatchObject({
        name: "GrantDeniedError",
        reason: "expired",
      });
    });

    it("a valid grant dispatches and links the grant onto the intent", async () => {
      const runId = await newRun();
      const { svc } = service("succeed");
      const intent = await preparedIntent(svc, runId);
      const token = await grantTokenFor(intent);

      const attempt = await dispatch(svc, intent, token);
      expect(attempt.outcome).toBe("succeeded");

      const linked = await db.pool.query("SELECT grant_id FROM action_intents WHERE id = $1", [intent.id]);
      expect(linked.rows[0]!.grant_id).not.toBeNull();
    });
  });

  it("enforces the intent state machine; executing lives on the attempt", async () => {
    const runId = await newRun();
    const { svc } = service("succeed");
    const intent = await svc.createIntent({
      runId,
      actionType: "external_side_effect",
      capability: "act:fake",
      resource: "fake:send",
      domainId,
      actor: "user:m4b-test",
    });
    expect(intent.status).toBe("proposed");

    await expect(
      svc.prepareIntent({ intentId: intent.id, actor: "user:m4b-test" }),
    ).rejects.toBeInstanceOf(InvalidIntentTransitionError); // proposed ↛ prepared

    const approved = await svc.approveIntent({ intentId: intent.id, actor: "user:m4b-test" });
    expect(approved.status).toBe("approved");

    await expect(
      svc.approveIntent({ intentId: intent.id, actor: "user:m4b-test" }),
    ).rejects.toBeInstanceOf(InvalidIntentTransitionError);

    await expect(
      svc.startAttempt({ intentId: intent.id, actor: "user:m4b-test", grantToken: "x", principalId }),
    ).rejects.toBeInstanceOf(InvalidIntentTransitionError); // not prepared yet

    const prepared = await svc.prepareIntent({ intentId: intent.id, actor: "user:m4b-test" });
    expect(prepared.status).toBe("prepared");

    const attempt = await dispatch(svc, intent, await grantTokenFor(intent));
    expect(attempt.outcome).toBe("succeeded");
    expect((await svc.getIntent(intent.id)).status).toBe("prepared"); // never 'executing'

    await expect(
      svc.cancelIntent({ intentId: intent.id, actor: "user:m4b-test" }),
    ).rejects.toBeInstanceOf(InvalidIntentTransitionError); // prepared ↛ cancelled

    await expect(
      svc.recordOutcome({
        intentId: intent.id,
        attemptId: attempt.id,
        actor: "user:m4b-test",
        outcome: "failed",
      }),
    ).rejects.toBeInstanceOf(InvalidAttemptTransitionError); // terminal outcomes are immutable
  });

  it("schema forbids 'executing' on the intent itself", async () => {
    const runId = await newRun();
    const { svc } = service("succeed");
    const intent = await preparedIntent(svc, runId);
    await expect(
      db.pool.query("UPDATE action_intents SET status = 'executing' WHERE id = $1", [
        intent.id,
      ]),
    ).rejects.toThrow(/check constraint/);
  });

  it("cancel: proposed|approved → cancelled, and a cancelled intent cannot dispatch", async () => {
    const runId = await newRun();
    const { svc } = service("succeed");
    const intent = await svc.createIntent({
      runId,
      actionType: "external_side_effect",
      capability: "act:fake",
      resource: "fake:send",
      domainId,
      actor: "user:m4b-test",
    });
    await svc.approveIntent({ intentId: intent.id, actor: "user:m4b-test" });
    const cancelled = await svc.cancelIntent({ intentId: intent.id, actor: "user:m4b-test" });
    expect(cancelled.status).toBe("cancelled");
    await expect(
      svc.startAttempt({ intentId: intent.id, actor: "user:m4b-test", grantToken: "x", principalId }),
    ).rejects.toBeInstanceOf(InvalidIntentTransitionError);
  });

  it("passes the idempotency key through to the provider and records it on attempts", async () => {
    const runId = await newRun();
    const { provider, svc } = service("succeed");
    const intent = await preparedIntent(svc, runId);
    const attempt = await dispatch(svc, intent, await grantTokenFor(intent));

    expect(attempt.idempotencyKey).toBeTruthy();
    expect(provider.requests[0]!.idempotencyKey).toBe(attempt.idempotencyKey);

    // Replaying the same key returns the recorded outcome (no second effect)
    // and the retry attempt records the same key.
    provider.behavior = "fail";
    const retry = await dispatch(svc, intent, await grantTokenFor(intent));
    expect(retry.idempotencyKey).toBe(attempt.idempotencyKey); // retries reuse the key
    expect(retry.outcome).toBe("succeeded"); // provider replayed the recorded outcome
    expect(provider.effects).toHaveLength(1);
  });

  it("provider-observed failure → outcome failed with the error recorded", async () => {
    const runId = await newRun();
    const { svc } = service("fail");
    const intent = await preparedIntent(svc, runId);
    const attempt = await dispatch(svc, intent, await grantTokenFor(intent));
    expect(attempt.outcome).toBe("failed");
    expect(attempt.error).toContain("fake provider failure");
    expect(attempt.providerRef).toBeNull();
  });

  it("rejects money_and_contracts at intent creation (autonomy ceiling from policy.yaml)", async () => {
    const runId = await newRun();
    const { svc } = service("succeed");
    await expect(
      svc.createIntent({
        runId,
        actionType: "money_and_contracts",
        capability: "act:bank",
        resource: "bank:transfer",
        domainId,
        payload: { amount: 1 },
        actor: "user:m4b-test",
      }),
    ).rejects.toBeInstanceOf(ActionProhibitedError);

    const intents = await db.pool.query("SELECT count(*)::int AS n FROM action_intents WHERE run_id = $1", [runId]);
    expect(intents.rows[0]!.n).toBe(0); // nothing was created

    const denials = await db.pool.query(
      "SELECT action FROM audit_log WHERE action = 'action.intent.denied' AND outputs_ref LIKE '%money_and_contracts%'",
    );
    expect(denials.rows).toHaveLength(1);
  });

  it("happy path: succeeded outcome carries the provider ref", async () => {
    const runId = await newRun();
    const { svc } = service("succeed");
    const intent = await preparedIntent(svc, runId);
    const attempt = await dispatch(svc, intent, await grantTokenFor(intent));
    expect(attempt.outcome).toBe("succeeded");
    expect(attempt.providerRef).toMatch(/^fake-fake-\d+$/);
    expect(attempt.finishedAt).not.toBeNull();
    expect((await svc.listAttempts(intent.id))).toHaveLength(1);
  });

  describe("R8: the ceiling comes from policy.yaml (ADR-0003)", () => {
    const dirs: string[] = [];

    afterAll(async () => {
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    });

    it("a custom policy file is loaded when no explicit policy is given", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "jehad-policy-"));
      dirs.push(dir);
      const file = path.join(dir, "policy.yaml");
      await writeFile(
        file,
        [
          "version: 1",
          "autonomy_ceiling:",
          "  read: prohibited",
          "  propose: autonomous",
          "  write_canonical: gated",
          "  external_side_effect: approval_required",
          "  money_and_contracts: prohibited",
        ].join("\n"),
      );
      const runId = await newRun();
      const built = new ActionService(db.pool, new FakeActionProvider("succeed"), { policyPath: file });
      await expect(
        built.createIntent({
          runId,
          actionType: "read",
          capability: "act:fake",
          resource: "fake:read",
          domainId,
          actor: "user:m4b-test",
        }),
      ).rejects.toBeInstanceOf(ActionProhibitedError); // file says read: prohibited; fallback says autonomous
    });

    it("a malformed policy file fails closed (no silent fallback)", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "jehad-policy-"));
      dirs.push(dir);
      const file = path.join(dir, "policy.yaml");
      await writeFile(file, "version: 1\nautonomy_ceiling:\n  read: very_allowed\n");
      const runId = await newRun();
      const built = new ActionService(db.pool, new FakeActionProvider("succeed"), { policyPath: file });
      await expect(
        built.createIntent({
          runId,
          actionType: "read",
          capability: "act:fake",
          resource: "fake:read",
          domainId,
          actor: "user:m4b-test",
        }),
      ).rejects.toThrow(/invalid autonomy level/);
    });
  });
});
