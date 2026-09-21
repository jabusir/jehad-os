// W5(c) integration tests: eligibility (open + domain-scoped +
// thread-relevant), the guarded transition write (event + audit +
// provenance), and the verb→status map against a real migrated database.
// Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { REDACTED_TOKEN } from "../imessage/redact.js";
import {
  applyCommitmentTransition,
  commitmentRefCode,
  eligibleCommitments,
  parseCommitmentVerb,
  renderCommitmentVerbReply,
  resolveCommitmentTarget,
} from "./transitions.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-17T21:00:00.000Z");
const now = (): Date => NOW;

describe.skipIf(!TEST_DATABASE_URL)("commitment transitions (integration)", () => {
  let db: IsolatedDb;
  let principalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w5ctrans");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    principalId = String(
      (
        await db.pool.query(
          "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
          [`owner-${randomUUID().slice(0, 8)}`],
        )
      ).rows[0]!.id,
    );
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function insertCommitment(args: {
    description: string;
    counterparty?: string;
    direction?: "i_owe" | "owes_me";
    status?: string;
    domainKey?: string;
  }): Promise<string> {
    const domain = String(
      (
        await db.pool.query(`SELECT id FROM domains WHERE key = $1`, [args.domainKey ?? "personal"])
      ).rows[0]!.id,
    );
    const eventId = randomUUID();
    await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, recorded_at, idempotency_key,
                           domain_id, payload, sensitivity, schema_version)
       VALUES ($1, 'capture.recorded', 'cli.capture', $2::timestamptz, $2::timestamptz, $3, $4::uuid,
               $5::jsonb, 'normal', 1)`,
      [eventId, NOW.toISOString(), `sha256:${randomUUID()}`, domain, JSON.stringify({ text: args.description })],
    );
    const inserted = await db.pool.query(
      `INSERT INTO commitments (domain_id, direction, counterparty_text, description, due_at,
                                confidence, status, source_event_id, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, NULL, 0.9, $5, $6::uuid, $7::timestamptz, $7::timestamptz)
       RETURNING id`,
      [
        domain,
        args.direction ?? "i_owe",
        args.counterparty ?? "self",
        args.description,
        args.status ?? "open",
        eventId,
        NOW.toISOString(),
      ],
    );
    return String(inserted.rows[0]!.id);
  }

  // ------------------------------------------------------------ eligibility

  it("eligibleCommitments returns open rows only, personal domain by default", async () => {
    const openId = await insertCommitment({ description: "Confirm venue by Friday", counterparty: "Henna" });
    await insertCommitment({ description: "Already met", status: "met" });
    await insertCommitment({ description: "Renegotiated away", status: "renegotiated" });
    await insertCommitment({ description: "Work commitment", domainKey: "work" });

    const eligible = await eligibleCommitments(db.pool, { now });
    expect(eligible.map((c) => c.id)).toEqual([openId]);
    expect(eligible[0]).toMatchObject({
      description: "Confirm venue by Friday",
      counterpartyText: "Henna",
      status: "open",
      domainKey: "personal",
    });

    // referentLabels narrow to the thread's subject; unrelated labels → empty.
    expect(await eligibleCommitments(db.pool, { now, referentLabels: ["confirm venue"] })).toHaveLength(1);
    expect(await eligibleCommitments(db.pool, { now, referentLabels: ["squash court"] })).toHaveLength(0);
  });

  // ------------------------------------------------------ bare verb → sole

  it("bare 'mark that done' applies when exactly one eligible item exists: status, event, audit", async () => {
    const parsed = parseCommitmentVerb("mark that done");
    expect(parsed).toEqual({ verb: "done" });
    const eligible = await eligibleCommitments(db.pool, { now });
    expect(eligible).toHaveLength(1);
    const resolution = resolveCommitmentTarget(eligible, parsed!.ref);
    expect(resolution).toMatchObject({ kind: "sole", id: eligible[0]!.id });
    expect(renderCommitmentVerbReply(resolution, "done")).toBe(
      "Marked: Confirm venue by Friday — done.",
    );

    const result = await applyCommitmentTransition(db.pool, {
      commitmentId: eligible[0]!.id,
      verb: "done",
      principalId,
      now,
    });
    expect(result).toMatchObject({
      applied: true,
      fromStatus: "open",
      toStatus: "met",
      reason: null,
    });

    const row = (
      await db.pool.query(`SELECT status FROM commitments WHERE id = $1::uuid`, [eligible[0]!.id])
    ).rows[0];
    expect(row.status).toBe("met");

    // One commitment.transitioned event with user_declared provenance.
    const events = await db.pool.query(
      `SELECT payload FROM events WHERE type = 'commitment.transitioned'`,
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload).toMatchObject({
      commitmentId: eligible[0]!.id,
      verb: "done",
      fromStatus: "open",
      toStatus: "met",
      provenance: "user_declared",
      declaredBy: principalId,
    });

    // One content-free audit row (ids/statuses/verb — no note text).
    const audits = await db.pool.query(
      `SELECT actor, action, outputs_ref FROM audit_log WHERE action = 'commitment.transition'`,
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0].actor).toBe("system:commitments");
    const outputs = JSON.parse(String(audits.rows[0].outputs_ref));
    expect(outputs).toMatchObject({
      commitmentId: eligible[0]!.id,
      verb: "done",
      applied: true,
      provenance: "user_declared",
      principalId,
    });
  });

  it("replay after the transition is an honest not_open no-op (no second event)", async () => {
    const metId = (
      await db.pool.query(`SELECT id FROM commitments WHERE status = 'met' LIMIT 1`)
    ).rows[0].id;
    const before = await db.pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'commitment.transitioned'`);
    const result = await applyCommitmentTransition(db.pool, {
      commitmentId: String(metId),
      verb: "done",
      principalId,
      now,
    });
    expect(result).toMatchObject({ applied: false, reason: "not_open", toStatus: "met", eventId: null });
    const after = await db.pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'commitment.transitioned'`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("unknown commitment id is not_found, never a throw", async () => {
    const result = await applyCommitmentTransition(db.pool, {
      commitmentId: randomUUID(),
      verb: "missed",
      principalId,
      now,
    });
    expect(result).toMatchObject({ applied: false, reason: "not_found" });
  });

  it("renegotiated and missed land their statuses; the note rides the event redacted", async () => {
    const renegotiatedId = await insertCommitment({ description: "Send Lena the draft" });
    const missedId = await insertCommitment({ description: "Pick up the suit" });

    const renegotiated = await applyCommitmentTransition(db.pool, {
      commitmentId: renegotiatedId,
      verb: "renegotiated",
      note: `new terms: card on file ${COMMITMENT_NOTE_CARD}`,
      principalId,
      now,
    });
    expect(renegotiated.toStatus).toBe("renegotiated");
    expect(renegotiated.noteRedacted).toBe(true);

    const missed = await applyCommitmentTransition(db.pool, {
      commitmentId: missedId,
      verb: "missed",
      principalId,
      now,
    });
    expect(missed.toStatus).toBe("missed");
    expect(missed.applied).toBe(true);

    // Event payload carries the REDACTED note; the audit never carries note text.
    const payload = (
      await db.pool.query(
        `SELECT payload FROM events WHERE type = 'commitment.transitioned' AND payload->>'commitmentId' = $1`,
        [renegotiatedId],
      )
    ).rows[0].payload;
    expect(String(payload.note)).toContain(REDACTED_TOKEN);
    expect(String(payload.note)).not.toContain(COMMITMENT_NOTE_CARD);
    const audit = (
      await db.pool.query(
        `SELECT outputs_ref FROM audit_log WHERE action = 'commitment.transition'
           AND outputs_ref::jsonb->>'commitmentId' = $1`,
        [renegotiatedId],
      )
    ).rows[0].outputs_ref;
    expect(audit).not.toContain(COMMITMENT_NOTE_CARD);
    expect(JSON.parse(String(audit)).notePresent).toBe(true);
  });

  // -------------------------------------------------- ambiguous → ref path

  it("multiple eligible → clarify; a [ref] applies to exactly that item", async () => {
    const a = await insertCommitment({ description: "Water the plants" });
    const b = await insertCommitment({ description: "Mail the package" });

    const eligible = await eligibleCommitments(db.pool, { now });
    expect(eligible).toHaveLength(2);
    const ambiguous = resolveCommitmentTarget(eligible);
    expect(ambiguous.kind).toBe("ambiguous");
    expect(renderCommitmentVerbReply(ambiguous, "done")).toContain("Which one? Reply with its ref:");

    const parsed = parseCommitmentVerb(`done [${commitmentRefCode(b)}]`);
    expect(parsed).toMatchObject({ verb: "done", ref: commitmentRefCode(b) });
    const targeted = resolveCommitmentTarget(eligible, parsed!.ref);
    expect(targeted).toMatchObject({ kind: "ref", id: b });

    const result = await applyCommitmentTransition(db.pool, {
      commitmentId: b,
      verb: "done",
      principalId,
      now,
    });
    expect(result.applied).toBe(true);
    const statuses = await db.pool.query(
      `SELECT id, status FROM commitments WHERE id = ANY($1::uuid[])`,
      [[a, b]],
    );
    expect(statuses.rows).toEqual(
      expect.arrayContaining([
        { id: a, status: "open" },
        { id: b, status: "met" },
      ]),
    );
  });

  it("zero eligible renders the honest none reply", async () => {
    // Drain: mark everything open as missed.
    const open = await db.pool.query(`SELECT id FROM commitments WHERE status = 'open'`);
    for (const row of open.rows) {
      await applyCommitmentTransition(db.pool, {
        commitmentId: String(row.id),
        verb: "missed",
        principalId,
        now,
      });
    }
    const eligible = await eligibleCommitments(db.pool, { now });
    expect(eligible).toHaveLength(0);
    expect(renderCommitmentVerbReply(resolveCommitmentTarget(eligible), "done")).toBe(
      "Nothing open matches that.",
    );
  });
});

/** A Luhn-valid test card number (redaction fixture — never a real card). */
const COMMITMENT_NOTE_CARD = "4242 4242 4242 4242";
