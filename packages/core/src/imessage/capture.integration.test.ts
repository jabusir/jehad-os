// Phase F integration tests (docs/plans/ig-phase-f-contracts.md §9):
// deterministic-first capture detection, speaker-attributed candidates via
// the existing pipeline conventions, triple idempotency, flood cap,
// principal scoping, force-review landing, and the no-content-in-audit
// privacy scan. Isolated db per the threads.integration.test.ts pattern.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { acceptEvent } from "../events/store.js";
import { idempotencyKeyFor } from "../events/envelope.js";
import { listReviewQueue } from "../review/review-queue.js";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import {
  CAPTURE_ACK_REPLY,
  CAPTURE_ALREADY_REPLY,
  CAPTURE_DENIED_REPLY,
  CAPTURE_EXTERNAL_ID_PREFIX,
  CAPTURE_LIMIT_REPLY,
  CAPTURE_SOURCE,
  captureEnabledFor,
  captureNormalize,
  considerCapture,
  DEFAULT_CAPTURE_POLICY,
  type CaptureOutcome,
} from "./capture.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MIN = 60_000;
const HOUR = 60 * MIN;

describe.skipIf(!TEST_DATABASE_URL)("iMessage capture (integration)", () => {
  let db: IsolatedDb;
  let josctlId: string;
  let yusraId: string;
  let now: Date;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igcap");
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
      DELETE FROM memory_candidates; DELETE FROM outbox; DELETE FROM events;
      DELETE FROM audit_log;
    `);
    now = new Date();
  });

  function consider(
    text: string,
    overrides: {
      principalId?: string;
      principalName?: string;
      threadId?: string;
      sourceEventId?: string;
      intentRouter?: (text: string) => Promise<boolean>;
    } = {},
  ): Promise<CaptureOutcome> {
    return considerCapture(
      db.pool,
      {
        principalId: overrides.principalId ?? josctlId,
        principalName: overrides.principalName ?? "josctl",
        text,
        threadId: overrides.threadId,
        sourceEventId: overrides.sourceEventId,
        now,
      },
      { intentRouter: overrides.intentRouter },
    );
  }

  async function candidates(): Promise<Record<string, unknown>[]> {
    const rows = await db.pool.query(
      `SELECT c.*, d.key AS domain_key FROM memory_candidates c
         JOIN domains d ON d.id = c.domain_id
        ORDER BY c.created_at`,
    );
    return rows.rows;
  }

  it("deterministic trigger: 'Remember that …' lands one in_review semantic candidate (attributed, provenance, force-review) + ack", async () => {
    now = new Date("2026-03-01T10:00:00Z");
    const threadId = crypto.randomUUID();
    const out = await consider("Remember that I'm looking for a Porsche 911.", { threadId });

    expect(out.captured).toBe(true);
    expect(out.reply).toBe(CAPTURE_ACK_REPLY);
    expect(out.reason).toBeUndefined();

    const rows = await candidates();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.proposed_class).toBe("semantic");
    expect(row.assertion_kind).toBe("user_declared");
    expect(row.status).toBe("in_review");
    expect(row.domain_key).toBe("personal");
    expect(row.gated_class).toBeNull();

    const payload = row.payload as Record<string, unknown>;
    expect(payload.kind).toBe("memory_note");
    expect(payload.speaker).toBe("josctl");
    // Speaker-attributed semantics — "josctl said X", NEVER "X is true".
    expect(payload.statement).toBe(`josctl said: "I'm looking for a Porsche 911."`);
    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.threadId).toBe(threadId);
    expect(metadata.surface).toBe("imessage");
    expect(metadata.trigger).toBe("pattern");

    const provenance = row.provenance as Record<string, unknown>;
    const sourceEventId = String(provenance.sourceEventId);
    expect(sourceEventId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(provenance.model).toBeNull();
    expect(metadata.captureSource).toBe(CAPTURE_SOURCE);

    // The source event exists: capture.recorded, source imessage.capture,
    // payload.text = the inbound text (externalId rides the idempotency
    // key — verified in the sourceEventId test below).
    const event = await db.pool.query(
      `SELECT e.type, e.source, e.payload, e.idempotency_key
         FROM events e WHERE e.id = $1::uuid`,
      [sourceEventId],
    );
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0].type).toBe("capture.recorded");
    expect(event.rows[0].source).toBe(CAPTURE_SOURCE);
    expect(String(event.rows[0].idempotency_key)).toMatch(/^[0-9a-f]{64}$/);
    expect((event.rows[0].payload as Record<string, unknown>).text).toBe(
      "Remember that I'm looking for a Porsche 911.",
    );

    // memory.proposed (references only) + force-review marker + review queue.
    const proposed = await db.pool.query(
      `SELECT count(*)::int AS n FROM events WHERE type = 'memory.proposed'
         AND idempotency_key = $1`,
      [idempotencyKeyFor("internal", `memory-candidate:${row.id}`)],
    );
    expect(proposed.rows[0].n).toBe(1);
    const gateResult = row.gate_result as Record<string, unknown>;
    expect(gateResult.reason).toBe("force_review_source");
    expect((gateResult.forceReview as Record<string, unknown>).source).toBe(CAPTURE_SOURCE);
    const queue = await listReviewQueue(db.pool);
    expect(queue.promotions.map((p) => p.id)).toContain(String(row.id));
  });

  it("mention vs remember: 'I've been looking at Porsche 911s' is working context — no event, no candidate", async () => {
    now = new Date("2026-03-01T11:00:00Z");
    const out = await consider("I've been looking at Porsche 911s");
    expect(out).toEqual({ captured: false, reason: "no-capture-trigger" });
    expect(await candidates()).toHaveLength(0);
    const events = await db.pool.query(`SELECT count(*)::int AS n FROM events`);
    expect(events.rows[0].n).toBe(0);
  });

  it("questions and negations never capture deterministically", async () => {
    now = new Date("2026-03-01T12:00:00Z");
    for (const text of [
      "Did you remember to book the table?",
      "remember that we settled the deposit?",
      "Please don't remember the door code — it rotates.",
      "Do not note that I said anything.",
    ]) {
      const out = await consider(text);
      expect(out.captured, text).toBe(false);
      expect(out.reason, text).toBe("no-capture-trigger");
    }
    expect(await candidates()).toHaveLength(0);

    // "don't forget that …" IS a capture imperative (contract §2).
    const forget = await consider("Don't forget that Yusra's birthday is in March.");
    expect(forget.captured).toBe(true);
    expect(await candidates()).toHaveLength(1);
  });

  it("dedupe window: identical normalized content within 24h is a noop + ack; outside the window captures again", async () => {
    now = new Date("2026-03-02T09:00:00Z");
    const first = await consider("Remember that I prefer manual gearboxes.");
    expect(first.captured).toBe(true);

    now = new Date(now.getTime() + HOUR);
    // Same content, different casing/whitespace — still "identical" normalized.
    const repeat = await consider("  remember THAT I prefer manual gearboxes. ");
    expect(repeat).toEqual({ captured: false, reason: "duplicate-content", reply: CAPTURE_ALREADY_REPLY });
    expect(await candidates()).toHaveLength(1);

    // +25h from the first capture — outside the 24h window → captures again.
    now = new Date(Date.parse("2026-03-02T09:00:00Z") + 25 * HOUR);
    const later = await consider("Remember that I prefer manual gearboxes.");
    expect(later.captured).toBe(true);
    expect(await candidates()).toHaveLength(2);
  });

  it("flood cap: the 6th distinct capture within the hour is suppressed with the honest limit reply", async () => {
    now = new Date("2026-03-03T10:00:00Z");
    for (let i = 1; i <= 5; i++) {
      now = new Date(now.getTime() + MIN);
      const out = await consider(`Remember that spare key number ${i} is in the drawer.`);
      expect(out.captured, `capture ${i}`).toBe(true);
    }
    expect(await candidates()).toHaveLength(5);

    now = new Date(now.getTime() + MIN);
    const sixth = await consider("Remember that the workshop is closed on Fridays.");
    expect(sixth).toEqual({ captured: false, reason: "flood-cap", reply: CAPTURE_LIMIT_REPLY });
    expect(await candidates()).toHaveLength(5);

    const capped = await db.pool.query(
      `SELECT outputs_ref::text AS t FROM audit_log WHERE action = 'imessage.capture.capped'`,
    );
    expect(capped.rows).toHaveLength(1);
  });

  it("disabled principal: deterministic honest denial, no candidate, no event, zero router calls", async () => {
    now = new Date("2026-03-04T10:00:00Z");
    const routerCalls: string[] = [];
    const out = await consider("Remember that my dentist is Dr. Amara.", {
      principalId: yusraId,
      principalName: "yusra",
      intentRouter: async (text) => {
        routerCalls.push(text);
        return true;
      },
    });
    expect(out).toEqual({
      captured: false,
      reason: "principal-not-capture-enabled",
      reply: CAPTURE_DENIED_REPLY,
    });
    expect(routerCalls).toHaveLength(0);
    expect(await candidates()).toHaveLength(0);
    const events = await db.pool.query(`SELECT count(*)::int AS n FROM events`);
    expect(events.rows[0].n).toBe(0);
    const denied = await db.pool.query(
      `SELECT outputs_ref::text AS t FROM audit_log WHERE action = 'imessage.capture.denied'`,
    );
    expect(denied.rows).toHaveLength(1);
  });

  it("double-capture on the same sourceEventId is blocked; the provided event is used as provenance (no synthetic event)", async () => {
    now = new Date("2026-03-05T10:00:00Z");
    const accepted = await acceptEvent(db.pool, {
      type: "capture.recorded",
      schemaVersion: 1,
      source: CAPTURE_SOURCE,
      externalId: `${CAPTURE_EXTERNAL_ID_PREFIX}guid-abc123`,
      occurredAt: now.toISOString(),
      domainId: "personal",
      sensitivity: "normal",
      payload: { text: "Remember that the VIN ends in 8841.", surface: "imessage" },
      runId: null,
    });

    const first = await consider("Remember that the VIN ends in 8841.", {
      sourceEventId: accepted.envelope.id,
    });
    expect(first.captured).toBe(true);
    const rows = await candidates();
    expect(rows).toHaveLength(1);
    expect((rows[0].provenance as Record<string, unknown>).sourceEventId).toBe(
      accepted.envelope.id,
    );
    // No second capture.recorded was minted by the module, and the caller's
    // event idempotency key = sha256(source + NUL + "imessage-capture:guid-abc123").
    const captureEvents = await db.pool.query(
      `SELECT count(*)::int AS n, max(idempotency_key) AS k FROM events WHERE type = 'capture.recorded'`,
    );
    expect(captureEvents.rows[0].n).toBe(1);
    expect(captureEvents.rows[0].k).toBe(
      idempotencyKeyFor(CAPTURE_SOURCE, `${CAPTURE_EXTERNAL_ID_PREFIX}guid-abc123`),
    );

    // Redelivery with the same source event id → noop + ack, still one candidate.
    const second = await consider("Remember that the VIN ends in 8841.", {
      sourceEventId: accepted.envelope.id,
    });
    expect(second).toEqual({
      captured: false,
      reason: "duplicate-source-event",
      reply: CAPTURE_ALREADY_REPLY,
    });
    expect(await candidates()).toHaveLength(1);
  });

  it("PRIVACY: audit rows carry ids/counts only — never inbound content (needle scan)", async () => {
    now = new Date("2026-03-06T10:00:00Z");
    const needle = "unique-needle-7c2f";
    const out = await consider(`Remember that the gate code hint is ${needle}.`);
    expect(out.captured).toBe(true);
    const auditRows = await db.pool.query(
      `SELECT inputs_ref::text AS i, outputs_ref::text AS o FROM audit_log`,
    );
    expect(auditRows.rows.length).toBeGreaterThan(0);
    for (const row of auditRows.rows) {
      expect(String(row.i).includes(needle)).toBe(false);
      expect(String(row.o).includes(needle)).toBe(false);
    }
    // The needle lives in the candidate + its source event (the memory
    // pipeline's job) and nowhere in the audit lane.
    const candidateRows = await db.pool.query(`SELECT payload::text AS p FROM memory_candidates`);
    expect(candidateRows.rows[0].p.includes(needle)).toBe(true);
  });

  it("redaction: denylist shapes are masked before they reach the event payload or the candidate statement", async () => {
    now = new Date("2026-03-06T11:00:00Z");
    const out = await consider("Remember that my card is 4242 4242 4242 4242.");
    expect(out.captured).toBe(true);
    const rows = await candidates();
    const payload = rows[0].payload as Record<string, unknown>;
    expect(String(payload.statement)).toContain("⦙redacted⦙");
    expect(String(payload.statement)).not.toContain("4242");
    const event = await db.pool.query(
      `SELECT payload::text AS p FROM events WHERE type = 'capture.recorded'`,
    );
    expect(event.rows[0].p).toContain("⦙redacted⦙");
    expect(event.rows[0].p).not.toContain("4242");
  });

  it("intentRouter fallback: non-pattern storage phrasing routes to capture; false/throw fail safe", async () => {
    now = new Date("2026-03-07T10:00:00Z");

    // Default (no router): deterministic-only — non-pattern text never captures.
    const noRouter = await consider("Could you hold on to the fact that I hate suede seats?");
    expect(noRouter.captured).toBe(false);

    // Router says yes → capture with trigger 'route', full-text attribution.
    const routed = await consider("Could you hold on to the fact that I hate suede seats?", {
      intentRouter: async () => true,
    });
    expect(routed.captured).toBe(true);
    expect(routed.reply).toBe(CAPTURE_ACK_REPLY);
    const rows = await candidates();
    const metadata = (rows[0].payload as Record<string, unknown>).metadata as Record<string, unknown>;
    expect(metadata.trigger).toBe("route");

    // Router says no → no capture.
    now = new Date(now.getTime() + MIN);
    const refused = await consider("Please keep the fact that I owe Dana lunch in mind.", {
      intentRouter: async () => false,
    });
    expect(refused.captured).toBe(false);
    expect(refused.reason).toBe("no-capture-trigger");

    // Router throws → fail safe, no candidate, no reply.
    now = new Date(now.getTime() + MIN);
    const threw = await consider("Please keep the fact that I owe Dana lunch in mind.", {
      intentRouter: async () => {
        throw new Error('{"capture":"yes"}');
      },
    });
    expect(threw).toEqual({ captured: false, reason: "intent-router-error" });
    expect(await candidates()).toHaveLength(1);
  });

  it("captureEnabledFor: contract default enables only the owner principal; explicit policy overrides", () => {
    expect(captureEnabledFor("josctl")).toBe(true);
    expect(captureEnabledFor("yusra")).toBe(false);
    expect(captureEnabledFor("josctl", DEFAULT_CAPTURE_POLICY)).toBe(true);
    expect(captureEnabledFor("josctl", { enabled: false, principals: ["josctl"], maxCandidatesPerHour: 5, dedupeWindowHours: 24 })).toBe(false);
    expect(captureEnabledFor("dana", { enabled: true, principals: ["dana"], maxCandidatesPerHour: 1, dedupeWindowHours: 12 })).toBe(true);
  });

  it("captureNormalize: NFC + LF + trim + lowercase (restatement-equal)", () => {
    expect(captureNormalize("Rémember\r\nThat X")).toBe("rémember\nthat x");
    expect(captureNormalize("  Same Text  ")).toBe(captureNormalize("same text"));
    expect(captureNormalize("same text")).not.toBe(captureNormalize("same text twice"));
  });
});
