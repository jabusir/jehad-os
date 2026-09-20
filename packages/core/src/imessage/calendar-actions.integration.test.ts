// Phase H integration tests (docs/plans/ig-phase-h-contracts.md §9
// adversarial matrix): propose validation (every §4 violation), confirm
// happy path (attempt succeeded + grant minted/verified), token replay,
// expiry, wrong-principal fail-closed, payload-swap binding, quotas,
// UNKNOWN honesty + read-back reconciliation, and R10 terminal immutability.
// Isolated db 'igact' per the capture.integration.test.ts pattern. Hermetic
// on providers: only in-memory fakes — NO model calls anywhere (the route
// pass is the orchestrator's; this module receives extracted fields).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeActionProvider, type ActionProvider } from "@jehad/adapters";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import {
  CALENDAR_ACTION_DENIED_REPLY,
  CALENDAR_ACTION_DISPATCH_CAPPED_REPLY,
  CALENDAR_ACTION_PROPOSAL_CAPPED_REPLY,
  CALENDAR_CONFIRM_EXPIRED_REPLY,
  CALENDAR_CONFIRM_MISMATCH_REPLY,
  CALENDAR_CONFIRM_USED_REPLY,
  CALENDAR_GRANT_TTL_MS,
  CALENDAR_RECONCILE_NOT_CREATED_REPLY,
  CALENDAR_UNKNOWN_REPLY,
  DEFAULT_CALENDAR_ACTION_POLICY,
  cancelCalendarAction,
  confirmCalendarAction,
  type CalendarActionPolicy,
  type ConfirmCalendarActionResult,
  normalizeConfirmToken,
  parseActionRequest,
  proposeCalendarAction,
  reconcileCalendarAction,
  type ReconcileCalendarActionInput,
} from "./calendar-actions.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const HOUR = 60 * 60_000;

/** Real-clock base: DB now() and grant verification share this clock. */
function later(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

/**
 * Fake write provider with the reconcile read-back seam: dispatch rides
 * FakeActionProvider; findEventByIdempotencyKey resolves via its
 * provider-side record (statusForKey) — the stand-in for the google
 * extended-property lookup. `loseReadback` models "read-back finds nothing".
 */
function fakeWriteProvider(
  behavior: ConstructorParameters<typeof FakeActionProvider>[0] = "succeed",
  opts: { readonly loseReadback?: boolean } = {},
): ActionProvider & ReconcileCalendarActionInput["provider"] & { fake: FakeActionProvider } {
  const fake = new FakeActionProvider(behavior);
  return {
    fake,
    id: fake.id,
    dispatch: (request) => fake.dispatch(request),
    findEventByIdempotencyKey: async (key) => {
      if (opts.loseReadback === true) return null;
      const recorded = fake.statusForKey(key);
      return recorded?.status === "succeeded" && recorded.providerRef !== undefined
        ? { eventId: recorded.providerRef }
        : null;
    },
  };
}

describe.skipIf(!TEST_DATABASE_URL)("iMessage calendar actions (integration)", () => {
  let db: IsolatedDb;
  let josctlId: string;
  let yusraId: string;
  let seq = 0;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igact");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const mk = async (name: string): Promise<string> => {
      const p = await db.pool.query(
        "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
        [name],
      );
      return String(p.rows[0].id);
    };
    josctlId = await mk("josctl");
    yusraId = await mk("yusra");
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    await db.pool.query(`
      DELETE FROM audit_log; DELETE FROM action_attempts; DELETE FROM action_intents;
      DELETE FROM capability_grants; DELETE FROM runs;
    `);
    seq += 1;
  });

function propose(overrides: {
    principalId?: string;
    principalName?: string;
    title?: string;
    startIso?: string;
    endIso?: string;
    now?: Date;
    policy?: CalendarActionPolicy | null;
  } = {}) {
    // Single base keeps the default duration exactly 1h (whole minutes).
    const base = Date.now() + 2 * HOUR;
    return proposeCalendarAction(db.pool, {
      principalId: overrides.principalId ?? josctlId,
      principalName: overrides.principalName ?? "josctl",
      title: overrides.title ?? `Test event ${seq}`,
      startIso: overrides.startIso ?? new Date(base).toISOString(),
      endIso: overrides.endIso ?? new Date(base + HOUR).toISOString(),
      now: overrides.now ?? new Date(),
      policy: overrides.policy === undefined ? DEFAULT_CALENDAR_ACTION_POLICY : overrides.policy,
    });
  }

  function confirm(token: string, overrides: {
    principalId?: string;
    now?: Date;
    payloadHashEcho?: string;
    policy?: CalendarActionPolicy | null;
    provider?: ActionProvider;
  } = {}): Promise<ConfirmCalendarActionResult> {
    return confirmCalendarAction(db.pool, {
      principalId: overrides.principalId ?? josctlId,
      confirmToken: token,
      payloadHashEcho: overrides.payloadHashEcho,
      now: overrides.now ?? new Date(),
      policy: overrides.policy === undefined ? DEFAULT_CALENDAR_ACTION_POLICY : overrides.policy,
      provider: overrides.provider ?? fakeWriteProvider(),
    });
  }

  async function intentCount(): Promise<number> {
    const r = await db.pool.query(`SELECT count(*)::int AS n FROM action_intents`);
    return Number(r.rows[0]?.n ?? 0);
  }

  async function auditRows(action: string): Promise<Record<string, unknown>[]> {
    const r = await db.pool.query(
      `SELECT actor, action, inputs_ref, outputs_ref FROM audit_log WHERE action = $1 ORDER BY created_at`,
      [action],
    );
    return r.rows;
  }

  // ------------------------------------------------------------ detection

  describe("parseActionRequest (deterministic pre-pass)", () => {
    it("matches explicit phrasings, always with title=null (extraction is the route pass's)", () => {
      expect(parseActionRequest("Schedule lunch with Sam tomorrow at noon")).toEqual({
        proposed: true,
        title: null,
      });
      expect(parseActionRequest("please add dentist visit to my calendar")).toEqual({
        proposed: true,
        title: null,
      });
      expect(parseActionRequest("Can you schedule the 1:1 for Friday?")).toBeNull(); // question
      expect(parseActionRequest("don't schedule anything")).toBeNull(); // negated
      expect(parseActionRequest("what's my schedule tomorrow")).toBeNull();
      expect(parseActionRequest("add milk to my grocery list")).toBeNull(); // not the calendar
      expect(parseActionRequest("")).toBeNull();
    });
  });

  // ------------------------------------------------------------ propose

  it("propose: valid payload → proposed intent + token + render; no plaintext token stored", async () => {
    const base = Date.now() + 2 * HOUR;
    const out = await propose({
      title: "Dentist",
      startIso: new Date(base).toISOString(),
      endIso: new Date(base + HOUR).toISOString(),
    });

    expect(out.status).toBe("proposed");
    if (out.status !== "proposed") return;
    expect(normalizeConfirmToken(out.confirmToken)).toBe(out.confirmToken);
    expect(out.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(out.render).toContain('"Dentist"');
    expect(out.render).toContain(`confirm ${out.confirmToken}`);
    expect(out.render).toContain(`cancel ${out.confirmToken}`);

    const rows = await db.pool.query(`SELECT * FROM action_intents`);
    expect(rows.rows).toHaveLength(1);
    const intent = rows.rows[0] as Record<string, unknown>;
    expect(intent.status).toBe("proposed");
    const payload = intent.payload as Record<string, unknown>;
    const confirm = payload.confirm as Record<string, unknown>;
    const provenance = payload.provenance as Record<string, unknown>;
    expect(payload.action).toBe("calendar_create");
    expect(payload.title).toBe("Dentist");
    expect(payload.tentative).toBe(true); // ESCALATE-2 default
    expect(provenance.principalId).toBe(josctlId);
    expect(provenance.surface).toBe("imessage");
    expect(confirm.tokenHash).not.toBe(out.confirmToken); // hash only
    expect(confirm.consumedAt).toBeNull();
    // M4B audit trail intact + module audit carries (redacted) title only.
    const proposed = await auditRows("imessage.action.proposed");
    expect(proposed).toHaveLength(1);
    expect(String(proposed[0]!.outputs_ref)).toContain("Dentist");
    expect(await auditRows("action.intent.proposed")).toHaveLength(1);
  });

  it("propose: every §4 violation is rejected with the fixed constraint reply and NO intent row", async () => {
    const base = Date.now() + 2 * HOUR;
    const at = (minutes: number): string => new Date(base + minutes * 60_000).toISOString();
    const cases: Array<{ over: { title?: string; startIso?: string; endIso?: string }; phrase: string }> = [
      { over: { title: "   " }, phrase: "a title is required" },
      { over: { title: "x".repeat(121) }, phrase: "at most 120 characters" },
      { over: { startIso: new Date(Date.now() - HOUR).toISOString() }, phrase: "start must be in the future" },
      { over: { startIso: new Date(Date.now() + 30 * 24 * HOUR).toISOString() }, phrase: "within the next 14 days" },
      { over: { startIso: at(0), endIso: at(5) }, phrase: "at least 15 minutes" },
      { over: { startIso: at(0), endIso: at(300) }, phrase: "at most 4 hours" },
      { over: { startIso: at(0), endIso: new Date(base + 30.5 * 60_000).toISOString() }, phrase: "whole minutes" },
      { over: { startIso: "whenever", endIso: at(60) }, phrase: "valid date-time" },
    ];
    for (const c of cases) {
      const out = await propose(c.over);
      expect(out.status, JSON.stringify(c.over)).toBe("invalid");
      if (out.status === "invalid") expect(out.reply).toContain(c.phrase);
    }
    expect(await intentCount()).toBe(0);
    expect(await auditRows("imessage.action.invalid")).toHaveLength(cases.length);
  });

  it("propose: non-enabled principal → deterministic denial + audit (fail closed)", async () => {
    const out = await propose({ principalId: yusraId, principalName: "yusra" });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.reply).toBe(CALENDAR_ACTION_DENIED_REPLY);
    expect(await intentCount()).toBe(0);
    const denied = await auditRows("imessage.action.denied");
    expect(denied).toHaveLength(1);
    expect(String(denied[0]!.outputs_ref)).toContain("principal-not-action-enabled");
  });

  it("propose: proposal quota is a per-principal UTC-day flood bound", async () => {
    const policy = { ...DEFAULT_CALENDAR_ACTION_POLICY, maxProposalsPerDay: 1 };
    const first = await propose({ policy });
    const second = await propose({ policy });
    expect(first.status).toBe("proposed");
    expect(second.status).toBe("capped");
    if (second.status === "capped") {
      expect(second.reply).toBe(CALENDAR_ACTION_PROPOSAL_CAPPED_REPLY);
    }
    expect(await intentCount()).toBe(1);
    expect(await auditRows("imessage.action.capped")).toHaveLength(1);
  });

  // ------------------------------------------------------------ confirm

  it("confirm happy path: attempt succeeded + grant minted AND verified (consumed) via startAttempt; full M4B audit chain", async () => {
    const provider = fakeWriteProvider("succeed");
    const prop = await propose({ title: "Standup" });
    expect(prop.status).toBe("proposed");
    if (prop.status !== "proposed") return;

    const out = await confirm(prop.confirmToken, { provider });
    expect(out.status).toBe("succeeded");
    expect(out.reply).toContain("Created: Standup");
    expect(out.providerRef).toMatch(/^fake-fake-\d+$/);

    const attempts = await db.pool.query(`SELECT * FROM action_attempts`);
    expect(attempts.rows).toHaveLength(1);
    const attempt = attempts.rows[0] as Record<string, unknown>;
    expect(attempt.outcome).toBe("succeeded");
    expect(attempt.provider_ref).toBe(out.providerRef);
    expect(attempt.provider).toBe("fake");
    // The dispatched request carried the frozen payload + idempotency key.
    expect(provider.fake.requests[0]?.payload).toMatchObject({ title: "Standup", tentative: true });
    expect(provider.fake.requests[0]?.idempotencyKey).toBeTruthy();

    const intents = await db.pool.query(`SELECT * FROM action_intents`);
    const intent = intents.rows[0] as Record<string, unknown>;
    expect(intent.status).toBe("prepared"); // intents never hold execution state
    expect(intent.grant_id).not.toBeNull();
    const grants = await db.pool.query(`SELECT * FROM capability_grants WHERE id = $1`, [
      intent.grant_id,
    ]);
    const grant = grants.rows[0] as Record<string, unknown>;
    expect(grant.capability).toBe("act:fake"); // act:<provider.id>
    expect(grant.principal_id).toBe(josctlId);
    expect(grant.revoked_at).toBeNull();
    expect((grant.expires_at as Date).getTime()).toBeGreaterThan(
      Date.now() + CALENDAR_GRANT_TTL_MS - 30_000,
    );

    for (const action of [
      "action.intent.proposed",
      "action.intent.approved",
      "action.intent.prepared",
      "action.attempt.pre_effect",
      "action.attempt.outcome",
      "imessage.action.proposed",
      "imessage.action.confirmed",
    ]) {
      expect(await auditRows(action), action).toHaveLength(1);
    }
    const confirmed = await auditRows("imessage.action.confirmed");
    expect(String(confirmed[0]!.outputs_ref)).toContain('"outcome":"succeeded"');
  });

  it("token replay (adversary #1): second confirm is a noop with the honest already-used reply", async () => {
    const prop = await propose({ title: "Replay" });
    if (prop.status !== "proposed") throw new Error("propose failed");
    const first = await confirm(prop.confirmToken);
    expect(first.status).toBe("succeeded");

    const second = await confirm(prop.confirmToken);
    expect(second.status).toBe("already-used");
    expect(second.reply).toBe(CALENDAR_CONFIRM_USED_REPLY);
    expect(await db.pool.query(`SELECT count(*)::int AS n FROM action_attempts`)).toMatchObject({
      rows: [{ n: 1 }],
    });
    expect(await auditRows("imessage.action.rejected")).toHaveLength(1);
  });

  it("expired token (adversary #1 TTL): honest expiry reply; intent cancelled; nothing dispatched", async () => {
    const atPropose = new Date();
    const prop = await propose({ title: "Old", now: atPropose });
    if (prop.status !== "proposed") throw new Error("propose failed");

    const out = await confirm(prop.confirmToken, { now: later(11) }); // TTL 10min
    expect(out.status).toBe("expired");
    expect(out.reply).toBe(CALENDAR_CONFIRM_EXPIRED_REPLY);
    const intents = await db.pool.query(`SELECT status FROM action_intents`);
    expect(intents.rows[0]).toMatchObject({ status: "cancelled" });
    expect(await db.pool.query(`SELECT count(*)::int AS n FROM action_attempts`)).toMatchObject({
      rows: [{ n: 0 }],
    });
    expect(await auditRows("imessage.action.expired")).toHaveLength(1);
  });

  it("wrong-principal confirm (adversary #5): fail closed + audit; the real owner can still confirm", async () => {
    const prop = await propose({ title: "Mine" });
    if (prop.status !== "proposed") throw new Error("propose failed");

    const wrong = await confirm(prop.confirmToken, { principalId: yusraId });
    expect(wrong.status).toBe("denied");
    expect(wrong.reply).toBe(CALENDAR_ACTION_DENIED_REPLY);
    const rejected = await auditRows("imessage.action.rejected");
    expect(String(rejected[0]!.outputs_ref)).toContain("wrong-principal");
    // No content beyond ids/counts in the denial audit.
    expect(String(rejected[0]!.outputs_ref)).not.toContain("Mine");

    const intent = await db.pool.query(`SELECT status FROM action_intents`);
    expect(intent.rows[0]).toMatchObject({ status: "proposed" }); // not consumed

    const right = await confirm(prop.confirmToken);
    expect(right.status).toBe("succeeded");
  });

  it("payload-swap (adversary #2): token bound to the intent payload — mutated payload or wrong echo fails closed", async () => {
    const prop = await propose({ title: "Original" });
    if (prop.status !== "proposed") throw new Error("propose failed");

    await db.pool.query(
      `UPDATE action_intents SET payload = jsonb_set(payload, '{title}', '"Hacked"') WHERE id = $1`,
      [prop.intentId],
    );
    const swapped = await confirm(prop.confirmToken);
    expect(swapped.status).toBe("payload-mismatch");
    expect(swapped.reply).toBe(CALENDAR_CONFIRM_MISMATCH_REPLY);

    // Restore the payload; a wrong echo must ALSO fail closed.
    await db.pool.query(
      `UPDATE action_intents SET payload = jsonb_set(payload, '{title}', '"Original"') WHERE id = $1`,
      [prop.intentId],
    );
    const badEcho = await confirm(prop.confirmToken, { payloadHashEcho: "deadbeef" });
    expect(badEcho.status).toBe("payload-mismatch");

    const intent = await db.pool.query(`SELECT status FROM action_intents`);
    expect(intent.rows[0]).toMatchObject({ status: "proposed" });
    expect(await db.pool.query(`SELECT count(*)::int AS n FROM action_attempts`)).toMatchObject({
      rows: [{ n: 0 }],
    });
    // The correct echo still confirms.
    const ok = await confirm(prop.confirmToken, { payloadHashEcho: prop.payloadHash });
    expect(ok.status).toBe("succeeded");
  });

  it("dispatch quota (adversary #4): confirmed dispatches are capped per UTC day; quota never bypasses confirm", async () => {
    const policy = { ...DEFAULT_CALENDAR_ACTION_POLICY, maxDispatchesPerDay: 1 };
    const first = await propose({ title: "First", policy });
    if (first.status !== "proposed") throw new Error("propose failed");
    expect((await confirm(first.confirmToken, { policy })).status).toBe("succeeded");

    const second = await propose({ title: "Second", policy });
    expect(second.status).toBe("proposed"); // proposals still allowed
    if (second.status !== "proposed") return;
    const out = await confirm(second.confirmToken, { policy });
    expect(out.status).toBe("capped");
    expect(out.reply).toBe(CALENDAR_ACTION_DISPATCH_CAPPED_REPLY);
    expect(await db.pool.query(`SELECT count(*)::int AS n FROM action_attempts`)).toMatchObject({
      rows: [{ n: 1 }],
    });
  });

  it("UNKNOWN on provider throw (adversary #6): honest unknown state, then reconcile resolves via read-back", async () => {
    const provider = fakeWriteProvider("timeout-after-dispatch");
    const prop = await propose({ title: "Ambiguous" });
    if (prop.status !== "proposed") throw new Error("propose failed");

    const out = await confirm(prop.confirmToken, { provider });
    expect(out.status).toBe("unknown");
    expect(out.reply).toBe(CALENDAR_UNKNOWN_REPLY);
    expect(out.providerRef).toBeNull();
    const attempt = (await db.pool.query(`SELECT * FROM action_attempts`)).rows[0] as Record<string, unknown>;
    expect(attempt.outcome).toBe("unknown");
    expect(attempt.provider_ref).toBeNull();
    expect(provider.fake.effects).toHaveLength(1); // the effect DID happen

    const rec = await reconcileCalendarAction(db.pool, {
      intentId: prop.intentId,
      provider,
    });
    expect(rec.status).toBe("reconciled");
    expect(rec.providerRef).toMatch(/^fake-fake-\d+$/);
    expect(rec.reply).toContain("Confirmed created: Ambiguous");
    const after = (await db.pool.query(`SELECT outcome, provider_ref FROM action_attempts`)).rows[0] as Record<string, unknown>;
    expect(after.outcome).toBe("reconciled");
    expect(after.provider_ref).toBe(rec.providerRef);
    expect(await auditRows("imessage.action.reconciled")).toHaveLength(1);
  });

  it("reconcile with no read-back hit: attempt STAYS unknown (R10) and the reply treats it as not-created", async () => {
    const provider = fakeWriteProvider("timeout-after-dispatch", { loseReadback: true });
    const prop = await propose({ title: "Ghost" });
    if (prop.status !== "proposed") throw new Error("propose failed");
    expect((await confirm(prop.confirmToken, { provider })).status).toBe("unknown");

    const rec = await reconcileCalendarAction(db.pool, { intentId: prop.intentId, provider });
    expect(rec.status).toBe("failed");
    expect(rec.reply).toBe(CALENDAR_RECONCILE_NOT_CREATED_REPLY);
    const attempt = (await db.pool.query(`SELECT outcome FROM action_attempts`)).rows[0] as Record<string, unknown>;
    expect(attempt.outcome).toBe("unknown"); // never silently failed
    expect(await auditRows("imessage.action.unresolved")).toHaveLength(1);
  });

  it("R10: terminal attempts are untouched by reconcile (immutability respected)", async () => {
    const prop = await propose({ title: "Done deal" });
    if (prop.status !== "proposed") throw new Error("propose failed");
    expect((await confirm(prop.confirmToken)).status).toBe("succeeded");

    const rec = await reconcileCalendarAction(db.pool, {
      intentId: prop.intentId,
      provider: fakeWriteProvider(),
    });
    expect(rec.status).toBe("noop");
    const attempt = (await db.pool.query(`SELECT outcome, provider_ref FROM action_attempts`)).rows[0] as Record<string, unknown>;
    expect(attempt.outcome).toBe("succeeded");
    expect(attempt.provider_ref).not.toBeNull();
  });

  it("owner cancel: proposed intent cancelled with the honest reply; later confirm is a cancelled noop", async () => {
    const prop = await propose({ title: "Never mind" });
    if (prop.status !== "proposed") throw new Error("propose failed");

    const cancel = await cancelCalendarAction(db.pool, {
      principalId: josctlId,
      confirmToken: prop.confirmToken,
      now: new Date(),
    });
    expect(cancel.status).toBe("cancelled");
    const intent = await db.pool.query(`SELECT status FROM action_intents`);
    expect(intent.rows[0]).toMatchObject({ status: "cancelled" });

    const out = await confirm(prop.confirmToken);
    expect(out.status).toBe("cancelled");
    expect(await db.pool.query(`SELECT count(*)::int AS n FROM action_attempts`)).toMatchObject({
      rows: [{ n: 0 }],
    });
  });

  it("wrong-principal cancel fails closed too", async () => {
    const prop = await propose({ title: "Not yours" });
    if (prop.status !== "proposed") throw new Error("propose failed");
    const out = await cancelCalendarAction(db.pool, {
      principalId: yusraId,
      confirmToken: prop.confirmToken,
      now: new Date(),
    });
    expect(out.status).toBe("denied");
    const intent = await db.pool.query(`SELECT status FROM action_intents`);
    expect(intent.rows[0]).toMatchObject({ status: "proposed" });
  });
});
