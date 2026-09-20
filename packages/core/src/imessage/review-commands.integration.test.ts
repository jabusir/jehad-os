// Phase G integration tests (docs/plans/ig-phase-g-contracts.md §8):
// deterministic ref review/control over iMessage — approve/reject through
// the EXISTING promotion pipeline (+ the rejection feedback row), replay
// noops, bad-ref rate cap + lockout, stale/expired refs, snooze semantics,
// escalation snooze-only, owner-only scoping, digest bounds, mint-once,
// the brief review section, and the no-content-in-audit needle scan.
// Isolated db per the threads.integration.test.ts pattern.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import { acceptEvent } from "../events/store.js";
import {
  DEFAULT_REVIEW_POLICY,
  REVIEW_COOLDOWN_REPLY,
  REVIEW_DENIED_REPLY,
  REVIEW_EXPIRED_REPLY,
  REVIEW_QUEUE_EMPTY_REPLY,
  REVIEW_UNKNOWN_REF_REPLY,
  handleReviewCommand,
  mintReviewRef,
  parseReviewCommand,
  refsForBrief,
  type ReviewCommandResult,
} from "./review-commands.js";
import { collectMorningBriefData, isMorningBriefMeaningful } from "../briefs/data.js";
import { renderMorningBriefText } from "../briefs/render.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("parseReviewCommand (grammar, hermetic)", () => {
  it("matches the exact forms: verb, verb+ref, brackets optional, case-insensitive, trimmed", () => {
    expect(parseReviewCommand("approve 7k4")).toEqual({ cmd: "approve", ref: "7K4" });
    expect(parseReviewCommand("  APPROVE [7K4] ")).toEqual({ cmd: "approve", ref: "7K4" });
    expect(parseReviewCommand("Reject\ta2m")).toEqual({ cmd: "reject", ref: "A2M" });
    expect(parseReviewCommand("snooze [mq7]")).toEqual({ cmd: "snooze", ref: "MQ7" });
    expect(parseReviewCommand("queue")).toEqual({ cmd: "queue" });
    expect(parseReviewCommand("approve")).toEqual({ cmd: "approve" });
    expect(parseReviewCommand("SNOOZE")).toEqual({ cmd: "snooze" });
  });

  it("everything else is not a command (falls through to CONVERSATION unchanged)", () => {
    for (const text of [
      "",
      "   ",
      "please approve 7K4",
      "approve 7K44", // 4 chars
      "approve 7k", // 2 chars
      "approve [7K4", // unbalanced bracket
      "queue 7K4", // queue takes no ref
      "approves 7K4",
      "approve 7i4 extra",
      "approve, 7K4",
      "what about approving 7K4?",
      "/new",
    ]) {
      expect(parseReviewCommand(text), JSON.stringify(text)).toBeNull();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("iMessage review commands (integration)", () => {
  let db: IsolatedDb;
  let josctlId: string;
  let yusraId: string;
  let now: Date;

  const registry = new ModelEgressPolicyRegistry([
    {
      id: "igrev-personal-normal",
      domainId: "personal",
      sensitivity: "normal",
      allowedProviders: ["openrouter"], // the pipeline's gate-3 provider fact
      allowRemote: false,
      requireRedaction: false,
    },
  ]);

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igrev");
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
      DELETE FROM review_refs; DELETE FROM feedback; DELETE FROM evidence;
      DELETE FROM memory_candidates; DELETE FROM outbox; DELETE FROM events;
      DELETE FROM notifications; DELETE FROM audit_log; DELETE FROM model_calls;
      DELETE FROM escalations; DELETE FROM runs;
    `);
    now = new Date();
  });

  function handle(
    text: string,
    overrides: {
      principalId?: string;
      principalName?: string;
      at?: Date;
      egressRegistry?: ModelEgressPolicyRegistry | null;
    } = {},
  ): Promise<ReviewCommandResult> {
    return handleReviewCommand(
      db.pool,
      {
        principalId: overrides.principalId ?? josctlId,
        principalName: overrides.principalName ?? "josctl",
        text,
        now: overrides.at ?? now,
      },
      { egressRegistry: overrides.egressRegistry === null ? undefined : overrides.egressRegistry ?? registry },
    );
  }

  /** An in_review candidate through the same seam the capture/extraction lanes use. */
  async function queueCandidate(statement: string, createdAt?: Date): Promise<string> {
    const at = createdAt ?? now;
    const accepted = await acceptEvent(db.pool, {
      type: "capture.recorded",
      schemaVersion: 1,
      source: "cli.capture",
      externalId: `igrev-${randomUUID()}`,
      occurredAt: at.toISOString(),
      domainId: "personal",
      sensitivity: "normal",
      payload: { statement },
      runId: null,
    });
    const inserted = await db.pool.query(
      `INSERT INTO memory_candidates
         (domain_id, proposed_class, assertion_kind, payload, provenance, gate_result, status, created_at, updated_at)
       SELECT d.id, 'semantic', 'user_declared', $1::jsonb, $2::jsonb,
              '{"version":1,"action":"in_review","reason":"force_review_source"}'::jsonb,
              'in_review', $3::timestamptz, $3::timestamptz
       FROM domains d WHERE d.key = 'personal'
       RETURNING id`,
      [
        JSON.stringify({
          kind: "memory_note",
          statement,
          speaker: "josctl",
          confidence: 1,
          metadata: { surface: "imessage" },
        }),
        JSON.stringify({ sourceEventId: accepted.envelope.id, runId: null, model: null, promptVersion: "igrev" }),
        at.toISOString(),
      ],
    );
    return String(inserted.rows[0].id);
  }

  async function queueEscalation(urgency: string | null): Promise<string> {
    const run = await db.pool.query(
      `INSERT INTO runs (kind, principal_id, status, intent, domain_id)
       SELECT 'workflow', $1::uuid, 'blocked', 'igrev', d.id FROM domains d WHERE d.key = 'personal'
       RETURNING id`,
      [josctlId],
    );
    const escalation = await db.pool.query(
      `INSERT INTO escalations (run_id, reason, urgency, est_human_minutes)
       VALUES ($1::uuid, 'approval_required', $2, 10) RETURNING id`,
      [run.rows[0].id, urgency],
    );
    return String(escalation.rows[0].id);
  }

  async function mintFor(candidateId: string, at: Date = now): Promise<string> {
    return mintReviewRef(db.pool, {
      itemType: "candidate",
      itemId: candidateId,
      principalId: josctlId,
      now: at,
    });
  }

  // ------------------------------------------------------------- §8.1/§5

  it("approve [REF]: promotes through the EXISTING pipeline — canonical write, memory.promoted with reviewer, zero model calls", async () => {
    now = new Date("2026-03-10T09:00:00Z");
    const candidateId = await queueCandidate("The workshop manual lives in the blue binder.");
    const ref = await mintFor(candidateId);

    const out = await handle(`approve ${ref}`);
    expect(out).toEqual({ handled: true, reply: `Approved [${ref}] — it's now memory.` });

    const row = (
      await db.pool.query("SELECT status FROM memory_candidates WHERE id = $1::uuid", [candidateId])
    ).rows[0];
    expect(row.status).toBe("promoted");
    // Canonical write landed via the existing writer.
    const claims = await db.pool.query(
      "SELECT claim FROM evidence WHERE metadata->>'candidateId' = $1",
      [candidateId],
    );
    expect(claims.rows[0].claim).toBe("The workshop manual lives in the blue binder.");
    // memory.promoted with the reviewer recorded (the pipeline's own event).
    const event = (
      await db.pool.query(
        `SELECT payload FROM events WHERE type = 'memory.promoted' AND payload->>'candidateId' = $1`,
        [candidateId],
      )
    ).rows[0];
    expect((event.payload as Record<string, unknown>).review).toMatchObject({ approvedBy: josctlId });
    // Zero model calls for the command turn (deterministic class).
    const calls = await db.pool.query(`SELECT count(*)::int AS n FROM model_calls`);
    expect(calls.rows[0].n).toBe(0);
    // Ref died with the verdict.
    const refRow = (
      await db.pool.query(`SELECT resolved_at, resolved_by FROM review_refs WHERE ref = $1`, [ref])
    ).rows[0];
    expect(refRow.resolved_at).not.toBeNull();
    expect(refRow.resolved_by).toBe("approve");
  });

  it("replay: a second approve [REF] is an honest noop — no second memory.promoted", async () => {
    now = new Date("2026-03-10T10:00:00Z");
    const candidateId = await queueCandidate("The spare fob is with reception.");
    const ref = await mintFor(candidateId);
    await handle(`approve ${ref}`);
    now = new Date(now.getTime() + MIN);

    const replay = await handle(`approve ${ref}`);
    expect(replay).toEqual({ handled: true, reply: `Already handled — [${ref}] was approved.` });
    const events = await db.pool.query(
      `SELECT count(*)::int AS n FROM events WHERE type = 'memory.promoted' AND payload->>'candidateId' = $1`,
      [candidateId],
    );
    expect(events.rows[0].n).toBe(1);
  });

  // ------------------------------------------------------------- §8.2

  it("reject [REF]: candidate discarded, ONE feedback row (review_item/noise/created_by), nothing canonical", async () => {
    now = new Date("2026-03-10T11:00:00Z");
    const candidateId = await queueCandidate("The neighbors said the fence line moved.");
    const ref = await mintFor(candidateId);

    const out = await handle(`reject ${ref}`);
    expect(out).toEqual({ handled: true, reply: `Rejected [${ref}] — it won't become memory.` });

    const row = (
      await db.pool.query("SELECT status FROM memory_candidates WHERE id = $1::uuid", [candidateId])
    ).rows[0];
    expect(row.status).toBe("rejected");
    const feedback = await db.pool.query(
      `SELECT item_type, item_id, verdict, created_by FROM feedback`,
    );
    expect(feedback.rows).toEqual([
      { item_type: "review_item", item_id: candidateId, verdict: "noise", created_by: josctlId },
    ]);
    const claims = await db.pool.query(
      "SELECT count(*)::int AS n FROM evidence WHERE metadata->>'candidateId' = $1",
      [candidateId],
    );
    expect(claims.rows[0].n).toBe(0);

    // Re-tap: honest noop; the feedback row is never duplicated.
    now = new Date(now.getTime() + MIN);
    const replay = await handle(`reject ${ref}`);
    expect(replay).toEqual({ handled: true, reply: `Already handled — [${ref}] was rejected.` });
    const still = await db.pool.query(`SELECT count(*)::int AS n FROM feedback`);
    expect(still.rows[0].n).toBe(1);
  });

  // ------------------------------------------------------------- §8.4

  it("guessing: unknown refs get honest replies ×3, then ONE cool-down notice, then silence; all audited + E4 lockout notice", async () => {
    now = new Date("2026-03-11T09:00:00Z");
    for (const ref of ["QQA", "QQB", "QQC"]) {
      const out = await handle(`approve ${ref}`);
      expect(out).toEqual({ handled: true, reply: REVIEW_UNKNOWN_REF_REPLY });
    }
    // 4th bad ref in the hour: over cap → cool-down notice ONCE.
    const fourth = await handle(`approve QQD`);
    expect(fourth).toEqual({ handled: true, reply: REVIEW_COOLDOWN_REPLY });
    // 5th (and even a VALID command — `queue`): silent drop, audit only.
    const fifth = await handle(`approve QQE`);
    expect(fifth).toEqual({ handled: true });
    const queue = await handle(`queue`);
    expect(queue).toEqual({ handled: true });

    const actions = await db.pool.query(
      `SELECT action, count(*)::int AS n FROM audit_log GROUP BY action ORDER BY action`,
    );
    const counts = Object.fromEntries(actions.rows.map((r) => [String(r.action), Number(r.n)]));
    expect(counts["imessage.review.bad_ref"]).toBe(3);
    // One cooldown audit per lockout drop: the 4th bad ref, the 5th, and
    // the silenced `queue` — the notice went out on the first only.
    expect(counts["imessage.review.cooldown"]).toBe(3);
    // E4: the owner is notified of the lockout (ids/counts only).
    const notice = await db.pool.query(
      `SELECT count(*)::int AS n FROM notifications WHERE kind = 'custom' AND title = 'Review commands paused'`,
    );
    expect(notice.rows[0].n).toBe(1);
    // Window clears → commands answer again.
    now = new Date(now.getTime() + 61 * MIN);
    const after = await handle(`approve QQF`);
    expect(after).toEqual({ handled: true, reply: REVIEW_UNKNOWN_REF_REPLY });
  });

  // ------------------------------------------------------------- §8.5

  it("stale/expired: resolved ref replays honestly; a TTL-lapsed ref expires honest and re-mints at next surfacing", async () => {
    now = new Date("2026-03-12T09:00:00Z");
    const candidateId = await queueCandidate("The ladder is behind the garage.");
    const ref = await mintFor(candidateId);
    await db.pool.query(`UPDATE review_refs SET expires_at = $2::timestamptz WHERE ref = $1`, [
      ref,
      new Date(now.getTime() - MIN).toISOString(),
    ]);

    const expired = await handle(`approve ${ref}`);
    expect(expired).toEqual({ handled: true, reply: REVIEW_EXPIRED_REPLY });
    const row = (
      await db.pool.query(`SELECT resolved_at, resolved_by FROM review_refs WHERE ref = $1`, [ref])
    ).rows[0];
    expect(row.resolved_by).toBe("expiry");
    // The candidate was untouched — still in_review.
    const status = (
      await db.pool.query(`SELECT status FROM memory_candidates WHERE id = $1::uuid`, [candidateId])
    ).rows[0];
    expect(status.status).toBe("in_review");

    // Re-mint at next surfacing: a NEW ref for the same item.
    now = new Date(now.getTime() + MIN);
    const remint = await mintFor(candidateId, now);
    expect(remint).not.toBe(ref);
    // The old code is dead authority: honest unknown after expiry resolution.
    const replay = await handle(`approve ${ref}`);
    expect(replay).toEqual({ handled: true, reply: REVIEW_EXPIRED_REPLY });
  });

  // ------------------------------------------------------------- §8.8

  it("yusra denied: control verbs → deterministic honest denial, audited, no refs resolved or minted for her", async () => {
    now = new Date("2026-03-12T10:00:00Z");
    const candidateId = await queueCandidate("Only the owner may resolve this.");
    const ref = await mintFor(candidateId);

    for (const text of [`approve ${ref}`, "queue"]) {
      const out = await handle(text, { principalId: yusraId, principalName: "yusra" });
      expect(out).toEqual({ handled: true, reply: REVIEW_DENIED_REPLY });
    }
    const denied = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'imessage.review.denied'`,
    );
    expect(denied.rows[0].n).toBe(2);
    const herRefs = await db.pool.query(
      `SELECT count(*)::int AS n FROM review_refs WHERE principal_id = $1::uuid`,
      [yusraId],
    );
    expect(herRefs.rows[0].n).toBe(0);
    const status = (
      await db.pool.query(`SELECT status FROM memory_candidates WHERE id = $1::uuid`, [candidateId])
    ).rows[0];
    expect(status.status).toBe("in_review"); // nothing resolved
  });

  // ------------------------------------------------------------- §8.7

  it("digest bounds: 15 pending candidates → 10 listed + overflow line, all with live refs, ≤1500 chars", async () => {
    now = new Date("2026-03-13T09:00:00Z");
    for (let i = 0; i < 15; i++) {
      await queueCandidate(
        `Note number ${i} waiting for review`,
        new Date(now.getTime() + i * MIN),
      );
    }
    const out = await handle("queue");
    expect(out.handled).toBe(true);
    const reply = out.reply!;
    expect(reply.length).toBeLessThanOrEqual(1500);
    expect(reply).toContain("Review queue — 15 waiting");
    const itemLines = reply.match(/^- \[/gm) ?? [];
    expect(itemLines.length).toBe(10);
    expect(reply).toContain("- …and 5 more");
    // First surfacing minted exactly the surfaced 10; the unsurfaced 5 have none.
    const refs = await db.pool.query(
      `SELECT count(*)::int AS n FROM review_refs WHERE resolved_at IS NULL`,
    );
    expect(refs.rows[0].n).toBe(10);
    // Oldest-first (the listReviewQueue order).
    const first = reply.match(/^- \[([0-9A-Z]{3})\] Note number (\d+)/m);
    expect(first![2]).toBe("0");
    expect(reply).not.toContain("Note number 14");
  });

  it("empty queue → honest empty reply", async () => {
    now = new Date("2026-03-13T10:00:00Z");
    const out = await handle("queue");
    expect(out).toEqual({ handled: true, reply: REVIEW_QUEUE_EMPTY_REPLY });
  });

  it("mint-once: the same item returns the same ref while live", async () => {
    now = new Date("2026-03-13T11:00:00Z");
    const candidateId = await queueCandidate("Mint once, keep until resolution.");
    const first = await mintFor(candidateId);
    now = new Date(now.getTime() + HOUR);
    const second = await mintFor(candidateId);
    expect(second).toBe(first);
    // …and refsForBrief keeps it copyable (not re-minted per digest).
    const digest = await refsForBrief(db.pool, josctlId, now, 10);
    expect(digest.candidates.map((c) => c.ref)).toContain(first);
    expect(digest.moreCandidates).toBe(0);
  });

  // ------------------------------------------------------------- snooze §3/§5

  it("snooze [REF]: hides from digests until snoozed_until, never resolves, resets on re-snooze, count surfaces after 2+", async () => {
    now = new Date("2026-03-14T09:00:00Z");
    const candidateId = await queueCandidate("Park this one for a day.");
    const ref = await mintFor(candidateId);

    const first = await handle(`snooze ${ref}`);
    expect(first.reply).toContain(`Snoozed [${ref}] for 24h`);
    const row = (
      await db.pool.query(`SELECT resolved_at, snooze_count, snoozed_until FROM review_refs WHERE ref = $1`, [ref])
    ).rows[0];
    expect(row.resolved_at).toBeNull(); // never resolves
    expect(row.snooze_count).toBe(1);
    expect(new Date(row.snoozed_until).toISOString()).toBe(
      new Date(now.getTime() + 24 * HOUR).toISOString(),
    );

    // Hidden from the digest while snoozed…
    const digest = await handle("queue");
    expect(digest.reply).not.toContain("Park this one for a day.");
    // …but the ref still resolves (snooze hides, never freezes).
    now = new Date(now.getTime() + MIN);
    const again = await handle(`snooze ${ref}`);
    expect(again.reply).toContain(`Snoozed [${ref}] for 24h`);
    const row2 = (
      await db.pool.query(`SELECT snooze_count, snoozed_until FROM review_refs WHERE ref = $1`, [ref])
    ).rows[0];
    expect(row2.snooze_count).toBe(2); // re-snooze resets the clock
    expect(new Date(row2.snoozed_until).toISOString()).toBe(
      new Date(now.getTime() + 24 * HOUR).toISOString(),
    );

    // After the snooze lifts the item returns, surfacing the snooze count.
    const later = new Date(now.getTime() + 25 * HOUR);
    const back = await handle("queue", { at: later });
    expect(back.reply).toContain("Park this one for a day.");
    expect(back.reply).toContain("snoozed 2×");
  });

  it("escalations: approve/reject are honestly refused from iMessage (CLI until H); snooze works", async () => {
    now = new Date("2026-03-14T11:00:00Z");
    const escalationId = await queueEscalation("high");
    const ref = await mintReviewRef(db.pool, {
      itemType: "escalation",
      itemId: escalationId,
      principalId: josctlId,
      now,
    });

    const refused = await handle(`approve ${ref}`);
    expect(refused.reply).toContain("Escalations can't be approved or rejected from here yet");
    const status = (
      await db.pool.query(`SELECT status FROM escalations WHERE id = $1::uuid`, [escalationId])
    ).rows[0];
    expect(status.status).toBe("pending");

    // Urgency-ranked into the digest with a minted ref + reason summary.
    const digest = await refsForBrief(db.pool, josctlId, now, 10);
    expect(digest.escalations).toHaveLength(1);
    expect(digest.escalations[0].summary).toBe("approval_required (high)");

    const snoozed = await handle(`snooze ${ref}`);
    expect(snoozed.reply).toContain(`Snoozed [${ref}] for 24h`);
  });

  // ------------------------------------------------------------- bare verbs §3

  it("bare approve: exactly one eligible item → resolves it; multiple → clarification listing refs; zero → honest nothing", async () => {
    now = new Date("2026-03-15T09:00:00Z");
    const only = await queueCandidate("The only thing waiting.");
    const bare = await handle("approve");
    expect(bare.reply).toMatch(/^Approved \[[0-9A-Z]{3}\] — it's now memory\.$/);
    expect(
      (await db.pool.query(`SELECT status FROM memory_candidates WHERE id = $1::uuid`, [only])).rows[0].status,
    ).toBe("promoted");

    await queueCandidate("First of two.");
    await queueCandidate("Second of two.");
    const clarify = await handle("approve");
    expect(clarify.reply).toContain("Which one? Reply with its ref:");
    expect((clarify.reply!.match(/^- \[/gm) ?? []).length).toBe(2);
    // Never a guess: both still in_review.
    const statuses = await db.pool.query(
      `SELECT count(*)::int AS n FROM memory_candidates WHERE status = 'in_review'`,
    );
    expect(statuses.rows[0].n).toBe(2);

    // Drain both by their listed refs, then bare again → honest nothing.
    for (const ref of clarify.reply!.match(/(?<=^- \[)[0-9A-Z]{3}(?=\])/gm) ?? []) {
      await handle(`reject ${ref}`);
    }
    const none = await handle("reject", { at: new Date("2026-03-15T09:05:00Z") });
    expect(none.reply).toBe("Nothing is waiting for your call right now.");
  });

  // ------------------------------------------------------------- §4.2 brief

  it("brief review section: renders with refs + statement summaries; un-suppresses an otherwise quiet morning", async () => {
    now = new Date("2026-03-16T12:00:00Z");
    await queueCandidate("Yusra's birthday is in March.");
    const data = await collectMorningBriefData(db.pool, { now: () => now, reviewPrincipalId: josctlId });
    expect(isMorningBriefMeaningful(data)).toBe(true); // review alone un-suppresses
    const text = renderMorningBriefText(data);
    expect(text).toContain("Needs your call");
    expect(text).toMatch(/- \[[0-9A-Z]{3}\] Yusra's birthday is in March./);

    // Empty queue → section suppressed; the quiet world suppresses the
    // brief (the candidate's source events must go too — they are the
    // overnight delta otherwise).
    await db.pool.query(`DELETE FROM memory_candidates`);
    await db.pool.query(`DELETE FROM outbox`);
    await db.pool.query(`DELETE FROM events`);
    await db.pool.query(`DELETE FROM review_refs`);
    const quiet = await collectMorningBriefData(db.pool, { now: () => now, reviewPrincipalId: josctlId });
    expect(quiet.review).toBeNull();
    expect(isMorningBriefMeaningful(quiet)).toBe(false);
  });

  // ------------------------------------------------------------- §5 privacy

  it("PRIVACY: audits carry refs/ids/counts only — never statement content; zero model calls anywhere", async () => {
    now = new Date("2026-03-17T09:00:00Z");
    const needle = "unique-needle-igrev-4c1";
    const approveId = await queueCandidate(`The gate code hint is ${needle}.`);
    const rejectId = await queueCandidate("A second statement to reject.");
    const approveRef = await mintFor(approveId);
    const rejectRef = await mintFor(rejectId);
    await handle(`approve ${approveRef}`);
    await handle(`reject ${rejectRef}`);
    await handle("queue");

    const auditRows = await db.pool.query(
      `SELECT inputs_ref::text AS i, outputs_ref::text AS o FROM audit_log`,
    );
    expect(auditRows.rows.length).toBeGreaterThan(0);
    for (const row of auditRows.rows) {
      expect(String(row.i).includes(needle), `needle leaked via inputs_ref: ${String(row.i)}`).toBe(false);
      expect(String(row.o).includes(needle), `needle leaked via outputs_ref: ${String(row.o)}`).toBe(false);
    }
    // The statement lives in the memory lane (candidate + canonical write),
    // nowhere in the control lane.
    const candidate = await db.pool.query(`SELECT payload::text AS p FROM memory_candidates WHERE id = $1::uuid`, [approveId]);
    expect(candidate.rows[0].p.includes(needle)).toBe(true);
    const calls = await db.pool.query(`SELECT count(*)::int AS n FROM model_calls`);
    expect(calls.rows[0].n).toBe(0);
  });

  it("contract §7 defaults: the module ships the owner-scoped policy", () => {
    expect(DEFAULT_REVIEW_POLICY).toEqual({
      enabled: true,
      principals: ["josctl"],
      maxBadRefs: 3,
      snoozeHours: 24,
      refTtlHours: 168,
      digestMaxCandidates: 10,
      digestMaxEscalations: 5,
    });
  });
});
