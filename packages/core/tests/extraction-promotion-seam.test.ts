// Cross-lane seam regression (M5B extraction v3 → M5C promotion): a captured
// obligation must travel the full pipeline — event store → extraction
// candidates (LLM extracts expression + state; the deterministic normalizer
// resolves) → five-gate promotion → canonical commitments row — without
// manual massage. The owner's temporal-directive cases live here: past-tense
// reports must NEVER become open commitments.
//
// The fake provider returns what a correct model returns per the v3 prompt
// (state + verbatim temporal expression); the deterministic half of the seam
// (normalizer, gate routing, writer) is what's under test.

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createIsolatedTestDb, dropIsolatedTestDb } from "../../db/tests/test-db.js";
import { migrateUp, seedDomains } from "../../db/src/index.js";
import { acceptEvent } from "../src/events/index.js";
import { extractFromEvent, type WrittenCandidate } from "../src/extraction/index.js";
import { promoteCandidate, type PromotionOutcome } from "../src/promotion/index.js";
import { loadEgressPolicyRegistry } from "../src/egress/index.js";
import type { EventEnvelope } from "../src/events/index.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("extraction → promotion seam (integration)", () => {
  let db: Awaited<ReturnType<typeof createIsolatedTestDb>>;
  let registry: Awaited<ReturnType<typeof loadEgressPolicyRegistry>>;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "seam");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    registry = await loadEgressPolicyRegistry();
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  // Anchor 2026-09-17 (Thursday) UTC for every capture: deterministic dates.
  const OCCURRED_AT = "2026-09-17T09:00:00.000Z";

  /** Canned v3 outputs: what a correct model returns per the v3 prompt. */
  const CANNED: readonly { match: string; output: Record<string, unknown> }[] = [
    {
      match: "migration plan Friday",
      output: {
        is_commitment: true, is_decision: false, direction: "i_owe", counterparty: "Jehad",
        temporal_expression: "Friday", temporal_type: "relative", commitment_state: "active",
        confidence: 0.9, description: "send the migration plan",
      },
    },
    {
      match: "I told him last Friday I would send it Monday",
      output: {
        is_commitment: true, is_decision: false, direction: "i_owe", counterparty: null,
        temporal_expression: "Monday", temporal_type: "relative", commitment_state: "historical",
        confidence: 0.85, description: "send it Monday",
      },
    },
    {
      match: "I'll send it to Jehad Monday",
      output: {
        is_commitment: true, is_decision: false, direction: "i_owe", counterparty: "Jehad",
        temporal_expression: "Monday", temporal_type: "relative", commitment_state: "active",
        confidence: 0.9, description: "send it Monday",
      },
    },
    {
      match: "I was supposed to send it last week",
      output: {
        is_commitment: true, is_decision: false, direction: "i_owe", counterparty: null,
        temporal_expression: "last week", temporal_type: "relative", commitment_state: "historical",
        confidence: 0.85, description: "send it",
      },
    },
    {
      match: "I told Jehad I'd send the plan Friday",
      output: {
        is_commitment: true, is_decision: false, direction: "i_owe", counterparty: "Jehad",
        temporal_expression: "Friday", temporal_type: "relative", commitment_state: "completed",
        confidence: 0.92, description: "send the plan",
      },
    },
    {
      match: "I said I'd send it Friday",
      output: {
        is_commitment: true, is_decision: false, direction: "i_owe", counterparty: null,
        temporal_expression: "Friday", temporal_type: "relative", commitment_state: "completed",
        confidence: 0.9, description: "send it",
      },
    },
    {
      match: "We had planned to send it Monday",
      output: {
        is_commitment: true, is_decision: false, direction: "i_owe", counterparty: null,
        temporal_expression: "Monday", temporal_type: "relative", commitment_state: "historical",
        confidence: 0.85, description: "send it",
      },
    },
    {
      match: "If they approve it, I'll send it Tuesday",
      output: {
        is_commitment: true, is_decision: false, direction: "i_owe", counterparty: null,
        temporal_expression: "Tuesday", temporal_type: "relative", commitment_state: "hypothetical",
        confidence: 0.8, description: "send it",
      },
    },
    {
      match: "sometime next week",
      output: {
        is_commitment: true, is_decision: false, direction: "i_owe", counterparty: "Sara",
        temporal_expression: "sometime next week", temporal_type: "vague", commitment_state: "active",
        confidence: 0.85, description: "get the summary to Sara",
      },
    },
    {
      match: "Forget Friday",
      output: {
        is_commitment: true, is_decision: false, direction: "i_owe", counterparty: "Lena",
        temporal_expression: "Monday", temporal_type: "relative", commitment_state: "renegotiated",
        confidence: 0.9, description: "send the plan",
      },
    },
    {
      match: "Once the contract is signed",
      output: {
        is_commitment: true, is_decision: false, direction: "i_owe", counterparty: "Vendor Co",
        temporal_expression: null, temporal_type: null, commitment_state: "prospective",
        confidence: 0.8, description: "order the parts",
      },
    },
    {
      match: "after all",
      output: {
        is_commitment: true, is_decision: false, direction: "i_owe", counterparty: "Dana",
        temporal_expression: null, temporal_type: null, commitment_state: "cancelled",
        confidence: 0.85, description: "send the report",
      },
    },
    {
      match: "Adapter says",
      output: {
        is_commitment: true, is_decision: false, direction: "i_owe", counterparty: "Jehad",
        temporal_expression: null, temporal_type: null, commitment_state: "active",
        confidence: 0.9, description: "owe a plan",
      },
    },
  ];

  const fakeProvider = {
    id: "fake-eval",
    // biome-ignore lint/suspicious/noExplicitAny: test double for the port
    async complete(request: unknown) {
      const req = request as { provider: string; prompt: string };
      const open = req.prompt.lastIndexOf("<capture>");
      const close = req.prompt.indexOf("</capture>", open);
      const capture = JSON.parse(req.prompt.slice(open + "<capture>".length, close)) as {
        text: string;
      };
      const canned = CANNED.find((c) => capture.text.includes(c.match));
      return {
        provider: req.provider,
        model: "fake",
        promptVersion: "seam-test",
        text: JSON.stringify(
          canned?.output ?? { is_commitment: false, is_decision: false, confidence: 0.2 },
        ),
        inTokens: 10,
        outTokens: 10,
        costUsd: 0,
        latencyMs: 1,
      };
    },
  } as never;

  interface SeamRun {
    readonly envelope: EventEnvelope;
    readonly candidates: readonly WrittenCandidate[];
    readonly commitment: WrittenCandidate | undefined;
  }

  async function captureAndExtract(
    text: string,
    source = "cli.capture",
  ): Promise<SeamRun> {
    const { envelope } = await acceptEvent(db.pool, {
      type: "capture.recorded",
      source,
      externalId: crypto.randomUUID(),
      occurredAt: OCCURRED_AT,
      domainId: "personal",
      sensitivity: "normal",
      schemaVersion: 1,
      payload: { kind: "capture", text },
    });
    const result = await extractFromEvent(
      { db: db.pool, provider: fakeProvider, model: "fake" },
      envelope as EventEnvelope,
    );
    return {
      envelope: envelope as EventEnvelope,
      candidates: [...result.candidates],
      commitment: result.candidates.find((c) => c.contract.payload.kind === "commitment"),
    };
  }

  function promoteCommitment(run: SeamRun, review?: { approvedBy: string }): Promise<PromotionOutcome> {
    expect(run.commitment).toBeDefined();
    return promoteCandidate(
      db.pool,
      run.commitment!.id,
      review === undefined ? { egressRegistry: registry } : { egressRegistry: registry, review },
    );
  }

  async function commitmentsFor(sourceEventId: string) {
    const result = await db.pool.query(
      "SELECT * FROM commitments WHERE source_event_id = $1::uuid",
      [sourceEventId],
    );
    return result.rows as Record<string, unknown>[];
  }

  it("lands a user-declared ACTIVE commitment canonically: open, normalized due_at, temporal stored", async () => {
    const run = await captureAndExtract("I'll send Jehad the migration plan Friday.");
    const payload = run.commitment!.contract.payload as {
      commitmentState: string;
      temporal: { normalizedTime: string | null; resolutionMethod: string };
    };
    expect(payload.commitmentState).toBe("active");
    expect(payload.temporal.normalizedTime).toBe("2026-09-18");
    expect(payload.temporal.resolutionMethod).toBe("weekday");

    const outcome = await promoteCommitment(run);
    expect(outcome.action).toBe("promoted");
    expect(outcome.write?.target).toBe("commitments");

    const [row] = await commitmentsFor(run.envelope.id);
    expect(row).toBeDefined();
    expect(row.status).toBe("open");
    // Normalized date lands as midnight UTC (anchor tz): deterministic, no
    // model date ever reaches due_at.
    expect(new Date(row.due_at as string).toISOString()).toBe("2026-09-18T00:00:00.000Z");
    const temporal = row.temporal as Record<string, unknown>;
    expect(temporal).toMatchObject({
      rawExpression: "Friday",
      resolutionStatus: "resolved",
      normalizedTime: "2026-09-18",
      resolutionMethod: "weekday",
    });
  });

  it("REGRESSION PAIR (owner): 'I told him last Friday I would send it Monday.' is historical — never open", async () => {
    const run = await captureAndExtract("I told him last Friday I would send it Monday.");
    const payload = run.commitment!.contract.payload as { commitmentState: string };
    expect(payload.commitmentState).toBe("historical");

    const outcome = await promoteCommitment(run);
    expect(outcome.action).toBe("in_review");
    expect(outcome.reason).toBe("commitment_state_historical");
    expect(outcome.write).toBeNull();
    expect(await commitmentsFor(run.envelope.id)).toHaveLength(0);

    // Review approval promotes the RECORD (event log), still never a row.
    const approved = await promoteCommitment(run, { approvedBy: "jehad" });
    expect(approved.action).toBe("promoted");
    expect(approved.write).toBeNull();
    expect(await commitmentsFor(run.envelope.id)).toHaveLength(0);
  });

  it("REGRESSION PAIR (owner): the active twin 'I'll send it to Jehad Monday.' lands open", async () => {
    const run = await captureAndExtract("I'll send it to Jehad Monday.");
    const outcome = await promoteCommitment(run);
    expect(outcome.action).toBe("promoted");
    const [row] = await commitmentsFor(run.envelope.id);
    expect(row.status).toBe("open");
    expect(new Date(row.due_at as string).toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("ADVERSARIAL (owner #1): 'I was supposed to send it last week.' → historical, no open row", async () => {
    const run = await captureAndExtract("I was supposed to send it last week.");
    expect(
      (run.commitment!.contract.payload as { commitmentState: string }).commitmentState,
    ).toBe("historical");
    const outcome = await promoteCommitment(run);
    expect(outcome).toMatchObject({ action: "in_review", reason: "commitment_state_historical" });
    expect(await commitmentsFor(run.envelope.id)).toHaveLength(0);
  });

  it("ADVERSARIAL (owner #2): 'I said I'd send it Friday, but I already did.' → completed (met when user_declared)", async () => {
    // Owner's exact text (no named counterparty): state is completed; the
    // canonical met-row needs counterparty_text (T9, NOT NULL) — unnamed
    // commitments cannot land canonically, same as every v2 capture.
    const exact = await captureAndExtract("I said I'd send it Friday, but I already did.");
    expect(
      (exact.commitment!.contract.payload as { commitmentState: string }).commitmentState,
    ).toBe("completed");
    const exactOutcome = await promoteCommitment(exact);
    expect(exactOutcome).toMatchObject({ action: "in_review", reason: "invalid_write_payload" });

    // Named variant: completed + user_declared writes the terminal status.
    const run = await captureAndExtract(
      "I told Jehad I'd send the plan Friday, but I already did.",
    );
    const outcome = await promoteCommitment(run);
    expect(outcome.action).toBe("promoted");
    const [row] = await commitmentsFor(run.envelope.id);
    expect(row.status).toBe("met"); // discharged on landing — never open
  });

  it("ADVERSARIAL (owner #3): 'We had planned to send it Monday.' → historical, no open row", async () => {
    const run = await captureAndExtract("We had planned to send it Monday.");
    expect(
      (run.commitment!.contract.payload as { commitmentState: string }).commitmentState,
    ).toBe("historical");
    const outcome = await promoteCommitment(run);
    expect(outcome).toMatchObject({ action: "in_review", reason: "commitment_state_historical" });
    expect(await commitmentsFor(run.envelope.id)).toHaveLength(0);
  });

  it("ADVERSARIAL (owner #4): 'If they approve it, I'll send it Tuesday.' → hypothetical, no open row", async () => {
    const run = await captureAndExtract("If they approve it, I'll send it Tuesday.");
    expect(
      (run.commitment!.contract.payload as { commitmentState: string }).commitmentState,
    ).toBe("hypothetical");
    const outcome = await promoteCommitment(run);
    expect(outcome).toMatchObject({ action: "in_review", reason: "commitment_state_hypothetical" });
    expect(await commitmentsFor(run.envelope.id)).toHaveLength(0);
  });

  it("ambiguous: 'sometime next week' lands OPEN with due_at null — no fabricated date", async () => {
    const run = await captureAndExtract("I'll get the summary to Sara sometime next week.");
    const payload = run.commitment!.contract.payload as {
      temporal: { normalizedTime: string | null; resolutionStatus: string };
    };
    expect(payload.temporal.resolutionStatus).toBe("ambiguous");
    expect(payload.temporal.normalizedTime).toBeNull();

    const outcome = await promoteCommitment(run);
    expect(outcome.action).toBe("promoted");
    const [row] = await commitmentsFor(run.envelope.id);
    expect(row.status).toBe("open");
    expect(row.due_at).toBeNull();
    expect((row.temporal as Record<string, unknown>).resolutionStatus).toBe("ambiguous");
  });

  it("renegotiated lands OPEN on the latest terms (Monday), not the superseded Friday", async () => {
    const run = await captureAndExtract(
      "Forget Friday — I'll send the plan to Lena Monday instead.",
    );
    expect(
      (run.commitment!.contract.payload as { commitmentState: string }).commitmentState,
    ).toBe("renegotiated");
    const outcome = await promoteCommitment(run);
    expect(outcome.action).toBe("promoted");
    const [row] = await commitmentsFor(run.envelope.id);
    expect(row.status).toBe("open");
    expect(new Date(row.due_at as string).toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("prospective routes to review (never open); cancelled lands void when user_declared", async () => {
    const prospective = await captureAndExtract(
      "Once the contract is signed I'll order the parts from Vendor Co.",
    );
    const prospectiveOutcome = await promoteCommitment(prospective);
    expect(prospectiveOutcome).toMatchObject({
      action: "in_review",
      reason: "commitment_state_prospective",
    });
    expect(await commitmentsFor(prospective.envelope.id)).toHaveLength(0);

    const cancelled = await captureAndExtract(
      "I won't be sending the report to Dana after all.",
    );
    const cancelledOutcome = await promoteCommitment(cancelled);
    expect(cancelledOutcome.action).toBe("promoted");
    const [row] = await commitmentsFor(cancelled.envelope.id);
    expect(row.status).toBe("void"); // withdrawn on landing — never open
  });

  it("routes model_inferred semantic candidates to review, not canonical (seam honors assertion_kind)", async () => {
    // Same text but ingested via an adapter source → externally_sourced per
    // assertionKindForSource — must NOT auto-land as canonical fact.
    const run = await captureAndExtract("Adapter says I owe Jehad a plan", "adapter:probe");
    const before = (
      await db.pool.query("SELECT count(*)::int AS n FROM commitments")
    ).rows[0]!.n;
    const outcome = await promoteCommitment(run);
    // externally_sourced commitments are semantic writes → review, never
    // direct canonical landing (plan §6.2 gate 5).
    expect(outcome.action).toBe("in_review");
    expect(outcome.reason).toBe("semantic_requires_review");
    expect(outcome.write).toBeNull();
    const after = (
      await db.pool.query("SELECT count(*)::int AS n FROM commitments")
    ).rows[0]!.n;
    expect(after).toBe(before);
  });
});
