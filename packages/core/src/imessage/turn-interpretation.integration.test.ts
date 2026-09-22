// W6(a) integration tests (jarvis-v1.md §7 W6(a), rev 3 R8/R12; §5
// invariants 15 + 16): the confirm→mutation bridges on a real database —
// the golden-transcript "track them" (8 commitments / 3 deterministic
// Wednesday dates from the 2026-09-21 fixture list), due-date correctness
// across week boundaries, proposal-never-writes DB pins, other-principal
// staging (owner-gated, honest policy line), feedback + memory landings,
// the thread pendingProposal lifecycle, and migration 020 up/down.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateDown, migrateUp, defaultMigrationsDir, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import {
  appendInteractionMessage,
  parseThreadMetadata,
  resolveActiveThread,
  retractThreadStance,
  setThreadPendingProposal,
} from "./threads.js";
import {
  JOSCTL_PROFILE_DEFINITION,
  activeProfile,
  seedProfile,
  setThreadProfileOverride,
} from "./profiles.js";
import {
  applyConfigurationDirective,
  applyMemoryCandidate,
  applySystemFeedback,
  applyTaskBatch,
  parseInterpretationJson,
  parseProposalConfirm,
  proposalFromPending,
  renderProposalOffer,
} from "./turn-interpretation.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// The 2026-09-21 golden transcript task list (R12): 8 tasks, 3 Wednesday
// deadlines, sent Monday 2026-09-21 12:36 PT.
const TRANSCRIPT_NOW = new Date("2026-09-21T19:36:00.000Z");
const GOLDEN_TASK_BATCH_JSON = JSON.stringify([
  {
    type: "task_batch",
    items: [
      { title: "Clean apartment and bathrooms", due: "by wednesday" },
      { title: "Pay the gardener", due: "wednesday" },
      { title: "Take out the recycling bins", due: "by Wednesday" },
      { title: "Reply to Henna about the dinner agenda", due: null },
      { title: "Book the venue deposit", due: null },
      { title: "Renew the passport application", due: null },
      { title: "Send the contract notes to Marco", due: null },
      { title: "Buy a birthday gift for Layla", due: null },
    ],
  },
]);

describe.skipIf(!TEST_DATABASE_URL)("turn interpretation bridges (integration)", () => {
  let db: IsolatedDb;
  let josctlId: string;
  let yusraId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w6aturnprop");
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
      DELETE FROM commitments; DELETE FROM feedback; DELETE FROM memory_candidates;
      DELETE FROM events; DELETE FROM outbox; DELETE FROM audit_log;
      DELETE FROM interaction_messages; DELETE FROM interaction_threads;
      TRUNCATE interaction_profiles;
    `);
  });

  // ------------------------------------------------------------- task_batch

  it("GOLDEN TRANSCRIPT: 'track them' writes 8 commitments with 3 deterministic Wednesday dates", async () => {
    // The interpreter turn parsed cleanly and rendered the offer.
    const proposals = parseInterpretationJson(GOLDEN_TASK_BATCH_JSON);
    expect(proposals).not.toBeNull();
    const offer = renderProposalOffer(proposals!);
    expect(offer).toBe(
      "I pulled out 8 tasks, 3 due wednesday: Clean apartment and bathrooms, Pay the gardener, Take out the recycling bins … Reply 'track them' and I'll track them (the 3 with deadlines).",
    );
    // The principal confirmed.
    expect(parseProposalConfirm("track them")).toBe("track");

    const result = await applyTaskBatch(db.pool, {
      proposal: proposals![0],
      principalId: josctlId,
      now: TRANSCRIPT_NOW,
    });
    expect(result.applied).toBe(true);
    expect(result.reply).toBe("Tracked 8 tasks — 3 due Wednesday.");
    expect(result.commitmentIds).toHaveLength(8);
    expect(result.dueIsoDates).toEqual(["2026-09-23"]);

    const rows = (
      await db.pool.query(
        `SELECT c.id, c.direction, c.counterparty_text, c.description, c.due_at,
                c.confidence, c.status, c.source_event_id, c.may_follow_up,
                c.temporal->>'normalizedTime' AS normalized_time,
                c.temporal->>'resolutionMethod' AS method,
                c.temporal->>'rawExpression' AS raw_expression
           FROM commitments c ORDER BY c.created_at, c.id`,
      )
    ).rows;
    expect(rows).toHaveLength(8);
    const withDue = rows.filter((r) => r.due_at !== null);
    expect(withDue).toHaveLength(3);
    for (const row of withDue) {
      // Monday 2026-09-21 anchor → "wednesday"/"by wednesday"/"by Wednesday"
      // all resolve strictly-after to the SAME next Wednesday.
      expect(row.normalized_time).toBe("2026-09-23");
      expect(row.method).toBe("weekday");
      // Midnight civil anchor in BRIEF_TIMEZONE (PDT, UTC-7).
      expect(new Date(row.due_at).toISOString()).toBe("2026-09-23T07:00:00.000Z");
    }
    expect(withDue.map((r) => r.raw_expression).sort()).toEqual(
      ["by Wednesday", "by wednesday", "wednesday"],
    );
    for (const row of rows) {
      expect(row.direction).toBe("i_owe");
      expect(row.status).toBe("open");
      expect(Number(row.confidence)).toBe(1);
      expect(row.counterparty_text).toBe("josctl");
      expect(row.may_follow_up).toBe(false);
      expect(row.source_event_id).toBe(result.eventId);
    }
    expect(rows.filter((r) => r.due_at === null)).toHaveLength(5);

    // ONE content-free provenance event for the whole batch (user_declared).
    const events = (
      await db.pool.query(`SELECT type, source, payload FROM events WHERE id = $1::uuid`, [
        result.eventId,
      ])
    ).rows;
    expect(events[0]!.type).toBe("commitment.detected");
    expect(events[0]!.source).toBe("system:turn-proposals");
    expect(events[0]!.payload.provenance).toBe("user_declared");
    expect(events[0]!.payload.itemCount).toBe(8);
    expect(events[0]!.payload.dueCount).toBe(3);
    expect(JSON.stringify(events[0]!.payload)).not.toContain("Clean apartment");

    // One audit row, ids/counts only.
    const audits = (
      await db.pool.query(`SELECT actor, action, outputs_ref FROM audit_log ORDER BY created_at`)
    ).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("proposal.task_batch.applied");
    expect(audits[0]!.outputs_ref).not.toContain("Clean apartment");
  });

  it("due dates are correct across week boundaries (anchor ON / before the weekday)", async () => {
    const anchorOnWednesday = new Date("2026-09-23T19:00:00.000Z"); // Wed Sep 23 PDT
    const onResult = await applyTaskBatch(db.pool, {
      proposal: { type: "task_batch", items: [{ title: "A", due: "by wednesday" }] },
      principalId: josctlId,
      now: anchorOnWednesday,
    });
    expect(onResult.dueIsoDates).toEqual(["2026-09-30"]); // strictly after → next week

    const anchorSaturday = new Date("2026-09-26T19:00:00.000Z"); // Sat Sep 26 PDT
    const satResult = await applyTaskBatch(db.pool, {
      proposal: { type: "task_batch", items: [{ title: "B", due: "wednesday" }] },
      principalId: josctlId,
      now: anchorSaturday,
    });
    expect(satResult.dueIsoDates).toEqual(["2026-09-30"]); // crosses the week boundary

    // Ambiguous dues stay null — honest, never a guess.
    const vague = await applyTaskBatch(db.pool, {
      proposal: { type: "task_batch", items: [{ title: "C", due: "sometime" }] },
      principalId: josctlId,
      now: anchorSaturday,
    });
    expect(vague.applied).toBe(true);
    expect(vague.dueIsoDates).toEqual([]);
    const stored = await db.pool.query(
      `SELECT due_at, temporal->>'resolutionStatus' AS status FROM commitments WHERE description = 'C'`,
    );
    expect(stored.rows[0]!.due_at).toBeNull();
    expect(stored.rows[0]!.status).toBe("ambiguous");
  });

  it("DB PIN: invalid or smuggled proposals write ZERO rows (proposals never mutate)", async () => {
    const before = await db.pool.query(`SELECT count(*)::int AS n FROM commitments`);
    const invalid = [
      { type: "task_batch", items: [] },
      { type: "task_batch", items: [{ title: "ask gpt-4o", due: null }] },
      { type: "calendar.create", title: "sneaky" },
      { type: "task_batch", items: [{ title: "ok", due: null }], extra: 1 },
      null,
    ];
    for (const proposal of invalid) {
      const result = await applyTaskBatch(db.pool, {
        proposal,
        principalId: josctlId,
        now: TRANSCRIPT_NOW,
      });
      expect(result.applied).toBe(false);
      // Persistence truth: the reply may say "nothing was tracked", but must
      // never assert a completed write.
      expect(result.reply).not.toMatch(/^(Tracked|Tracking) \d/);
      expect(result.reply).toMatch(/nothing/i);
    }
    const after = await db.pool.query(`SELECT count(*)::int AS n FROM commitments`);
    expect(after.rows[0].n).toBe(before.rows[0].n).toBe(0);
    const events = await db.pool.query(`SELECT count(*)::int AS n FROM events`);
    expect(events.rows[0].n).toBe(0);
  });

  // ------------------------------------------------- configuration_directive

  it("self directive: 'approve' applies the next profile version (created_via self)", async () => {
    await seedProfile(db.pool, {
      principalId: josctlId,
      surface: "imessage",
      definition: JOSCTL_PROFILE_DEFINITION,
    });
    const result = await applyConfigurationDirective(db.pool, {
      proposal: {
        type: "configuration_directive",
        target_principal: "self",
        target: "interaction_profile",
        change: { tone: "warmer" },
      },
      principalId: josctlId,
      actorPrincipalName: "josctl",
    });
    expect(result.applied).toBe(true);
    expect(result.staged).toBe(false);
    expect(result.version).toBe(2);
    expect(result.reply).toContain("Applied to your profile (version 2)");

    const active = await activeProfile(db.pool, { principalId: josctlId, surface: "imessage" });
    expect(active?.version).toBe(2);
    expect(active?.definition.extraDirectives?.at(-1)).toBe("tone: warmer");

    const via = await db.pool.query(
      `SELECT created_via FROM interaction_profiles WHERE principal_id = $1::uuid ORDER BY version`,
      [josctlId],
    );
    expect(via.rows.map((r) => r.created_via)).toEqual(["owner_seed", "self"]);
    const audit = await db.pool.query(
      `SELECT action FROM audit_log WHERE action LIKE 'proposal.configuration%'`,
    );
    expect(audit.rows[0]!.action).toBe("proposal.configuration_directive.applied");
  });

  it("other-principal directive: owner stages an owner_seed version; the reply is honest about policy activation", async () => {
    const result = await applyConfigurationDirective(db.pool, {
      proposal: {
        type: "configuration_directive",
        target_principal: "yusra",
        target: "interaction_profile",
        change: { language: "urdu", mentions: "the kids" },
      },
      principalId: josctlId,
      actorPrincipalName: "josctl",
    });
    expect(result.applied).toBe(true);
    expect(result.staged).toBe(true);
    // POLICY PIN: the honest activation line — the system never edits policy.
    expect(result.reply).toContain("personas policy");
    expect(result.reply).toContain("can't edit policy from chat");

    const active = await activeProfile(db.pool, { principalId: yusraId, surface: "imessage" });
    expect(active?.version).toBe(1);
    // Staged onto the system's default base register (JOSCTL seed — the
    // principal had no profile), so the two directive lines append to it.
    expect(active?.definition.extraDirectives).toEqual([
      ...JOSCTL_PROFILE_DEFINITION.extraDirectives!,
      "language: urdu",
      "mentions: the kids",
    ]);
    const via = await db.pool.query(
      `SELECT created_via FROM interaction_profiles WHERE principal_id = $1::uuid`,
      [yusraId],
    );
    expect(via.rows[0]!.created_via).toBe("owner_seed");
    const audit = await db.pool.query(
      `SELECT action FROM audit_log WHERE action LIKE 'proposal.configuration%'`,
    );
    expect(audit.rows[0]!.action).toBe("proposal.configuration_directive.staged");
  });

  it("other-principal directive from a NON-owner is refused with zero rows (cross-principal gate)", async () => {
    const result = await applyConfigurationDirective(db.pool, {
      proposal: {
        type: "configuration_directive",
        target_principal: "josctl",
        target: "interaction_profile",
        change: { tone: "sweeter" },
      },
      principalId: yusraId,
      actorPrincipalName: "yusra",
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("not-owner");
    expect(result.reply).toContain("only the owner can stage that");
    const rows = await db.pool.query(`SELECT count(*)::int AS n FROM interaction_profiles`);
    expect(rows.rows[0].n).toBe(0);
  });

  it("unknown target principal and invalid shapes are honest no-ops", async () => {
    const unknown = await applyConfigurationDirective(db.pool, {
      proposal: {
        type: "configuration_directive",
        target_principal: "ghost",
        target: "interaction_profile",
        change: { k: "v" },
      },
      principalId: josctlId,
      actorPrincipalName: "josctl",
    });
    expect(unknown.applied).toBe(false);
    expect(unknown.reason).toBe("unknown-principal");

    const invalid = await applyConfigurationDirective(db.pool, {
      proposal: { type: "task_batch", items: [{ title: "x", due: null }] },
      principalId: josctlId,
      actorPrincipalName: "josctl",
    });
    expect(invalid.applied).toBe(false);
    expect(invalid.reason).toBe("invalid-proposal");
  });

  // --------------------------------------------------------- system_feedback

  it("'log it' records one system_feedback feedback row (migration 020 vocabulary)", async () => {
    const now = new Date("2026-09-21T20:00:00.000Z");
    const result = await applySystemFeedback(db.pool, {
      proposal: {
        type: "system_feedback",
        category: "capability_gap",
        subject: "cannot see work email",
        detail: "missed the recruiter reply",
      },
      principalId: josctlId,
      now,
    });
    expect(result.applied).toBe(true);
    expect(result.feedbackId).toBeTruthy();

    const rows = (
      await db.pool.query(`SELECT item_type, item_id, verdict, note, created_by FROM feedback`)
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.item_type).toBe("system_feedback");
    expect(rows[0]!.verdict).toBe("capability_gap");
    expect(rows[0]!.note).toBe("cannot see work email — missed the recruiter reply");
    expect(rows[0]!.created_by).toBe(josctlId);
    expect(rows[0]!.item_id).toContain("system-feedback:");

    const audit = await db.pool.query(`SELECT outputs_ref FROM audit_log`);
    expect(JSON.parse(audit.rows[0]!.outputs_ref).category).toBe("capability_gap");
    expect(audit.rows[0]!.outputs_ref).not.toContain("recruiter");
  });

  // --------------------------------------------------------- memory_candidate

  it("'remember it' routes into the capture pipeline shape (in_review, events, audit)", async () => {
    const now = new Date("2026-09-21T20:05:00.000Z");
    const result = await applyMemoryCandidate(db.pool, {
      proposal: { type: "memory_candidate", summary: "prefers venues with parking" },
      principalId: josctlId,
      now,
    });
    expect(result.applied).toBe(true);
    expect(result.candidateId).toBeTruthy();

    const candidate = (
      await db.pool.query(
        `SELECT proposed_class, assertion_kind, status, payload, provenance FROM memory_candidates`,
      )
    ).rows[0]!;
    expect(candidate.proposed_class).toBe("semantic");
    expect(candidate.assertion_kind).toBe("user_declared");
    expect(candidate.status).toBe("in_review"); // ESCALATE-2: never auto-canonized
    expect(candidate.payload.statement).toBe('josctl said: "prefers venues with parking"');
    expect(candidate.payload.metadata.captureSource).toBe("turn.interpretation");

    const events = (await db.pool.query(`SELECT type FROM events ORDER BY type`)).rows;
    expect(events.map((e) => e.type)).toEqual(["capture.recorded", "memory.proposed"]);
  });

  it("memory capture is policy-gated per principal (yusra denied by default)", async () => {
    const result = await applyMemoryCandidate(db.pool, {
      proposal: { type: "memory_candidate", summary: "yusra fact" },
      principalId: yusraId,
      now: new Date(),
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("principal-not-capture-enabled");
    const rows = await db.pool.query(`SELECT count(*)::int AS n FROM memory_candidates`);
    expect(rows.rows[0].n).toBe(0);
  });

  // -------------------------------------------------- thread pendingProposal

  it("pendingProposal round-trips through thread metadata and survives every sibling write", async () => {
    const thread = await resolveActiveThread(db.pool, {
      principalId: josctlId,
      surface: "imessage",
      now: new Date(),
    });
    const proposals = parseInterpretationJson(GOLDEN_TASK_BATCH_JSON)!;
    const offered = renderProposalOffer(proposals)!;
    await setThreadPendingProposal(db.pool, {
      threadId: thread.id,
      principalId: josctlId,
      pending: {
        type: "task_batch",
        at: TRANSCRIPT_NOW.toISOString(),
        payload: proposals[0],
        offered,
      },
    });
    const stored = await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [
      thread.id,
    ]);
    const parsed = parseThreadMetadata(stored.rows[0].metadata);
    expect(parsed?.pendingProposal?.type).toBe("task_batch");
    expect(parsed?.pendingProposal?.offered).toBe(offered);
    expect(proposalFromPending(parsed!.pendingProposal!)).toEqual(proposals[0]);

    // Survives W1 turn-state merges (appendInteractionMessage).
    await appendInteractionMessage(db.pool, {
      threadId: thread.id,
      principalId: josctlId,
      surface: "imessage",
      direction: "inbound",
      trustClass: "authenticated_user_intent",
      content: "track them",
      receivedAt: new Date(),
      threadState: {
        at: new Date().toISOString(),
        stance: { kind: "answer", summary: "confirmed tracking" },
      },
    });
    const afterTurn = parseThreadMetadata(
      (await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [thread.id]))
        .rows[0].metadata,
    );
    expect(afterTurn?.pendingProposal).toEqual(parsed?.pendingProposal);

    // Survives stance retraction AND profile-override writes.
    await retractThreadStance(db.pool, { threadId: thread.id, principalId: josctlId });
    await setThreadProfileOverride(db.pool, {
      threadId: thread.id,
      principalId: josctlId,
      override: { brevityDelta: { maxSentences: -2 } },
    });
    const afterSiblings = parseThreadMetadata(
      (await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [thread.id]))
        .rows[0].metadata,
    );
    expect(afterSiblings?.pendingProposal).toEqual(parsed?.pendingProposal);
    expect(afterSiblings?.profile_override).toEqual({ brevityDelta: { maxSentences: -2 } });

    // A confirm consumed the pending proposal → the orchestrator clears it.
    await setThreadPendingProposal(db.pool, {
      threadId: thread.id,
      principalId: josctlId,
      pending: null,
    });
    const cleared = parseThreadMetadata(
      (await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [thread.id]))
        .rows[0].metadata,
    );
    expect(cleared?.pendingProposal).toBeUndefined();
    expect(cleared?.profile_override).toEqual({ brevityDelta: { maxSentences: -2 } });
  });

  it("pendingProposal writes fail closed cross-principal and on malformed shapes", async () => {
    const thread = await resolveActiveThread(db.pool, {
      principalId: josctlId,
      surface: "imessage",
      now: new Date(),
    });
    await expect(
      setThreadPendingProposal(db.pool, {
        threadId: thread.id,
        principalId: yusraId,
        pending: { type: "memory_candidate", at: new Date().toISOString(), payload: {}, offered: "x" },
      }),
    ).rejects.toThrow(/does not belong/i);
    await expect(
      setThreadPendingProposal(db.pool, {
        threadId: thread.id,
        principalId: josctlId,
        pending: { type: "calendar.create", at: new Date().toISOString(), payload: {}, offered: "x" },
      }),
    ).rejects.toThrow(/strict shape/i);
    await expect(
      setThreadPendingProposal(db.pool, {
        threadId: thread.id,
        principalId: josctlId,
        pending: {
          type: "task_batch",
          at: new Date().toISOString(),
          payload: {},
          offered: "x".repeat(401),
        },
      }),
    ).rejects.toThrow(/strict shape/i);
  });

  // --------------------------------------------------------- migration 020

  it("migration 020 up/down: the system_feedback vocabulary widens and narrows", async () => {
    // Up state (current): the widened CHECKs admit the row.
    await db.pool.query(
      `INSERT INTO feedback (item_type, item_id, verdict, note, created_by)
       VALUES ('system_feedback', 't', 'bug', 'n', $1)`,
      [josctlId],
    );
    expect(
      (await db.pool.query(`SELECT count(*)::int AS n FROM feedback WHERE item_type = 'system_feedback'`))
        .rows[0].n,
    ).toBe(1);

    // Roll back exactly 020 — the down path purges then narrows.
    expect(await migrateDown(db.pool, { to: "019_grant_reminder_kind" }, defaultMigrationsDir())).toEqual([
      "021_reminders",
      "020_system_feedback",
    ]);
    await expect(
      db.pool.query(
        `INSERT INTO feedback (item_type, item_id, verdict, note, created_by)
         VALUES ('system_feedback', 't2', 'bug', 'n', $1)`,
        [josctlId],
      ),
    ).rejects.toThrow(/feedback_item_type_check/);
    await expect(
      db.pool.query(
        `INSERT INTO feedback (item_type, item_id, verdict, note, created_by)
         VALUES ('event', 't3', 'capability_gap', 'n', $1)`,
        [josctlId],
      ),
    ).rejects.toThrow(/feedback_verdict_check/);

    // Re-up restores the widened vocabulary.
    expect(await migrateUp(db.pool, defaultMigrationsDir())).toEqual(["020_system_feedback", "021_reminders"]);
    await db.pool.query(
      `INSERT INTO feedback (item_type, item_id, verdict, note, created_by)
       VALUES ('system_feedback', 't4', 'request', 'n', $1)`,
      [josctlId],
    );
  });
});
