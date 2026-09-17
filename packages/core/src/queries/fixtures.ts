// Fixture world for the M6A structured-query integration tests. Seeds an
// isolated, migrated database with two domains (personal + work) and a fully
// deterministic world relative to an injected `now`:
//
//   - the §25 dependency-leverage scenario: Decision A blocks Tasks B, C, D;
//     Decision E blocks Task F (plus a depth-2/3/4 chain under A to pin the
//     transitive cap, a closed-downstream decision, and a cycle pair)
//   - the §7 waiting variants: overdue / due-soon / no-due / renegotiated /
//     void / met, in both directions
//   - the review §17 silently-stalled set: 8-day-stale item (stalled),
//     2-day-fresh item (not), progress-event-rescued item (not), explicitly
//     blocked stale item (blocked, NOT stalled), expired-edge item (stalled
//     again), a 12-day-stale project (per-type threshold override target)
//
// Test-only: writes canonical rows; the query services themselves are
// read-only.

import { randomUUID } from "node:crypto";
import type { QueryExecutor } from "./executor.js";

export interface FixtureNow {
  readonly now: Date;
}

const MS_PER_DAY = 86_400_000;

export interface FixtureIds {
  readonly domains: { readonly personal: string; readonly work: string };
  readonly entities: {
    readonly acmeOrg: string;
    readonly projectStalled: string;
    readonly projectActive: string;
  };
  readonly commitments: {
    readonly waitingOverdue: string;
    readonly waitingFuture: string;
    readonly renegotiatedPast: string;
    readonly voidPast: string;
    readonly mineOverdue: string;
    readonly mineDueSoon: string;
    readonly mineNoDue: string;
    readonly metPast: string;
    readonly workMine: string;
    readonly taskB: string;
    readonly taskC: string;
    readonly taskD: string;
    readonly taskF: string;
    readonly taskT2: string;
    readonly taskT3: string;
    readonly taskT4: string;
    readonly taskMet: string;
    readonly cycX: string;
    readonly cycY: string;
    readonly staleUnblocked: string;
    readonly freshUnblocked: string;
    readonly blockedStale: string;
    readonly expiredBlocked: string;
    readonly progressRescued: string;
    readonly workTask: string;
  };
  readonly decisions: {
    readonly decisionA: string;
    readonly decisionE: string;
    readonly decisionClosed: string;
    readonly decisionNoDownstream: string;
    readonly decisionWork: string;
  };
  readonly events: { readonly progressEvent: string };
}

export async function seedQueryFixtureWorld(
  db: QueryExecutor,
  opts: FixtureNow,
): Promise<FixtureIds> {
  const t0 = opts.now.getTime();
  const at = (daysAgo: number): Date => new Date(t0 - daysAgo * MS_PER_DAY);
  const ahead = (days: number): Date => new Date(t0 + days * MS_PER_DAY);

  const domainIds = new Map<string, string>();
  for (const [key, sensitivity] of [
    ["personal", "normal"],
    ["work", "work"],
  ] as const) {
    const inserted = await db.query(
      `INSERT INTO domains (key, name, sensitivity, retention_class, detachable, storage_mode)
       VALUES ($1, $2, $3, 'default', $4, 'local') RETURNING id`,
      [key, key === "personal" ? "Personal" : "Work", sensitivity, key === "work"],
    );
    domainIds.set(key, String(inserted.rows[0]!.id));
  }
  const dom = (key: string): string => domainIds.get(key)!;

  async function insertEvent(args: {
    domainKey: string;
    type: string;
    ageDays: number;
    payload: Record<string, unknown>;
  }): Promise<string> {
    const at_ = at(args.ageDays);
    const id = randomUUID();
    await db.query(
      `INSERT INTO events (id, type, source, occurred_at, recorded_at, idempotency_key,
                           domain_id, payload, sensitivity, schema_version)
       VALUES ($1, $2, 'cli.capture', $3::timestamptz, $4::timestamptz, $5, $6::uuid,
               $7::jsonb, 'normal', 1)`,
      [
        id,
        args.type,
        at_.toISOString(),
        at_.toISOString(),
        `sha256:${randomUUID()}`,
        dom(args.domainKey),
        JSON.stringify(args.payload),
      ],
    );
    return id;
  }

  async function insertCommitment(args: {
    domainKey?: string;
    direction: "owes_me" | "i_owe";
    counterparty: string;
    description: string;
    dueAt: Date | null;
    status: string;
    ageDays: number;
    counterpartyEntityId?: string;
  }): Promise<string> {
    const domainKey = args.domainKey ?? "personal";
    const sourceEventId = await insertEvent({
      domainKey,
      type: "capture.recorded",
      ageDays: args.ageDays,
      payload: { text: args.description },
    });
    const at_ = at(args.ageDays);
    const inserted = await db.query(
      `INSERT INTO commitments (direction, counterparty_text, counterparty_entity_id,
                                description, due_at, confidence, status, source_event_id,
                                created_at, updated_at)
       VALUES ($1, $2, $3::uuid, $4, $5::timestamptz, 0.9, $6, $7::uuid,
               $8::timestamptz, $8::timestamptz)
       RETURNING id`,
      [
        args.direction,
        args.counterparty,
        args.counterpartyEntityId ?? null,
        args.description,
        args.dueAt === null ? null : args.dueAt.toISOString(),
        args.status,
        sourceEventId,
        at_.toISOString(),
      ],
    );
    return String(inserted.rows[0]!.id);
  }

  async function insertDecision(args: {
    domainKey?: string;
    question: string;
    chosen: string;
    revisitConditions?: unknown[];
    ageDays: number;
  }): Promise<string> {
    const domainKey = args.domainKey ?? "personal";
    const sourceEventId = await insertEvent({
      domainKey,
      type: "decision.recorded",
      ageDays: args.ageDays,
      payload: { question: args.question },
    });
    const at_ = at(args.ageDays);
    const inserted = await db.query(
      `INSERT INTO decisions (domain_id, question, chosen, revisit_conditions, decided_at,
                              source_event_id, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::jsonb, $5::timestamptz, $6::uuid,
               $5::timestamptz, $5::timestamptz)
       RETURNING id`,
      [
        dom(domainKey),
        args.question,
        args.chosen,
        args.revisitConditions === undefined ? null : JSON.stringify(args.revisitConditions),
        at_.toISOString(),
        sourceEventId,
      ],
    );
    return String(inserted.rows[0]!.id);
  }

  async function insertEdge(args: {
    fromType: string;
    fromId: string;
    toType: string;
    toId: string;
    ageDays: number;
    validUntilDaysAgo?: number;
    type?: string;
  }): Promise<void> {
    const sourceEventId = await insertEvent({
      domainKey: "personal",
      type: args.type ?? "capture.recorded",
      ageDays: args.ageDays,
      payload: { note: "dependency" },
    });
    const at_ = at(args.ageDays);
    await db.query(
      `INSERT INTO relationships (domain_id, from_type, from_id, relation, to_type, to_id,
                                  source_event_id, valid_from, valid_until,
                                  created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, 'blocked_by', $4, $5::uuid, $6::uuid,
               $7::timestamptz, $8::timestamptz, $7::timestamptz, $7::timestamptz)`,
      [
        dom("personal"),
        args.fromType,
        args.fromId,
        args.toType,
        args.toId,
        sourceEventId,
        at_.toISOString(),
        args.validUntilDaysAgo === undefined ? null : at(args.validUntilDaysAgo).toISOString(),
      ],
    );
  }

  const acmeOrg = String(
    (
      await db.query(
        `INSERT INTO entities (discriminator, domain_id, name, sensitivity, created_at, updated_at)
         VALUES ('org', $1::uuid, 'Acme Corp', 'normal', $2::timestamptz, $2::timestamptz)
         RETURNING id`,
        [dom("personal"), at(9).toISOString()],
      )
    ).rows[0]!.id,
  );
  const projectStalled = String(
    (
      await db.query(
        `INSERT INTO entities (discriminator, domain_id, name, sensitivity, created_at, updated_at)
         VALUES ('project', $1::uuid, 'Legacy Migration', 'normal', $2::timestamptz, $3::timestamptz)
         RETURNING id`,
        [dom("personal"), at(40).toISOString(), at(12).toISOString()],
      )
    ).rows[0]!.id,
  );
  const projectActive = String(
    (
      await db.query(
        `INSERT INTO entities (discriminator, domain_id, name, sensitivity, created_at, updated_at)
         VALUES ('project', $1::uuid, 'Website Refresh', 'normal', $2::timestamptz, $3::timestamptz)
         RETURNING id`,
        [dom("personal"), at(30).toISOString(), at(1).toISOString()],
      )
    ).rows[0]!.id,
  );

  // ---- §25 leverage scenario -------------------------------------------------
  const decisionA = await insertDecision({
    question: "Choose the migration approach",
    chosen: "Strangler fig",
    ageDays: 10,
  });
  const decisionE = await insertDecision({
    question: "Pick the CI provider",
    chosen: "GitHub Actions",
    revisitConditions: [],
    ageDays: 10,
  });
  const decisionClosed = await insertDecision({
    question: "Vendor contract renewal",
    chosen: "Renew for one year",
    revisitConditions: ["pricing changes"],
    ageDays: 10,
  });
  const decisionNoDownstream = await insertDecision({
    question: "Team offsite month",
    chosen: "June",
    ageDays: 10,
  });
  const decisionWork = await insertDecision({
    domainKey: "work",
    question: "Deploy window",
    chosen: "Friday night",
    ageDays: 9,
  });

  const taskB = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Task B: draft schema",
    dueAt: null,
    status: "open",
    ageDays: 4,
  });
  const taskC = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Task C: extraction prompt",
    dueAt: null,
    status: "open",
    ageDays: 4,
  });
  const taskD = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Task D: brief renderer",
    dueAt: null,
    status: "open",
    ageDays: 4,
  });
  const taskF = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Task F: CI pipeline",
    dueAt: null,
    status: "open",
    ageDays: 4,
  });
  const taskT2 = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Task T2 (depth 2 under A)",
    dueAt: null,
    status: "open",
    ageDays: 4,
  });
  const taskT3 = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Task T3 (depth 3 under A)",
    dueAt: null,
    status: "open",
    ageDays: 4,
  });
  const taskT4 = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Task T4 (depth 4 under A — beyond cap)",
    dueAt: null,
    status: "open",
    ageDays: 4,
  });
  const taskMet = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Task already delivered",
    dueAt: at(3.5),
    status: "met",
    ageDays: 3.5,
  });
  const workTask = await insertCommitment({
    domainKey: "work",
    direction: "i_owe",
    counterparty: "employer",
    description: "Work task blocked by deploy window",
    dueAt: null,
    status: "open",
    ageDays: 4,
  });

  // ---- waiting variants ------------------------------------------------------
  const waitingOverdue = await insertCommitment({
    direction: "owes_me",
    counterparty: "Acme Corp",
    counterpartyEntityId: acmeOrg,
    description: "Acme owes Jehad the signed SOW",
    dueAt: at(2),
    status: "open",
    ageDays: 8,
  });
  const waitingFuture = await insertCommitment({
    direction: "owes_me",
    counterparty: "Vendor Ltd",
    description: "Vendor owes the audit report",
    dueAt: ahead(10),
    status: "open",
    ageDays: 1,
  });
  const renegotiatedPast = await insertCommitment({
    direction: "owes_me",
    counterparty: "Old Co",
    description: "Renegotiated deliverable",
    dueAt: at(5),
    status: "renegotiated",
    ageDays: 6,
  });
  const voidPast = await insertCommitment({
    direction: "owes_me",
    counterparty: "Ghost Co",
    description: "Voided deliverable",
    dueAt: at(4),
    status: "void",
    ageDays: 6,
  });
  const mineOverdue = await insertCommitment({
    direction: "i_owe",
    counterparty: "Landlord",
    description: "Pay October rent",
    dueAt: at(1),
    status: "open",
    ageDays: 3.5,
  });
  const mineDueSoon = await insertCommitment({
    direction: "i_owe",
    counterparty: "Bank",
    description: "Submit quarter-end paperwork",
    dueAt: ahead(2),
    status: "open",
    ageDays: 1,
  });
  const mineNoDue = await insertCommitment({
    direction: "i_owe",
    counterparty: "Gym",
    description: "Book squash court",
    dueAt: null,
    status: "open",
    ageDays: 2,
  });
  const metPast = await insertCommitment({
    direction: "i_owe",
    counterparty: "ISP",
    description: "Pay internet bill",
    dueAt: at(3.5),
    status: "met",
    ageDays: 3.5,
  });
  const workMine = await insertCommitment({
    domainKey: "work",
    direction: "i_owe",
    counterparty: "employer",
    description: "Work-domain commitment that must never leak",
    dueAt: ahead(1),
    status: "open",
    ageDays: 1,
  });

  // ---- stalled + cycle set ---------------------------------------------------
  const cycX = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Cycle side X",
    dueAt: null,
    status: "open",
    ageDays: 2,
  });
  const cycY = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Cycle side Y",
    dueAt: null,
    status: "open",
    ageDays: 2,
  });
  const staleUnblocked = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Stale unblocked commitment (8 days silent)",
    dueAt: null,
    status: "open",
    ageDays: 8,
  });
  const freshUnblocked = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Fresh commitment (2 days)",
    dueAt: null,
    status: "open",
    ageDays: 2,
  });
  const blockedStale = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Stale but explicitly blocked (8 days silent)",
    dueAt: null,
    status: "open",
    ageDays: 8,
  });
  const expiredBlocked = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Stale with an expired blocked_by edge (8 days silent)",
    dueAt: null,
    status: "open",
    ageDays: 8,
  });
  const progressRescued = await insertCommitment({
    direction: "i_owe",
    counterparty: "self",
    description: "Old row (10 days) rescued by a progress event yesterday",
    dueAt: null,
    status: "open",
    ageDays: 10,
  });

  // §25 edges: B, C, D blocked_by A; F blocked_by E; depth chain T2→B,
  // T3→T2, T4→T3; closed item under decisionClosed; cycle pair; stalled
  // variants; work edge.
  await insertEdge({ fromType: "commitment", fromId: taskB, toType: "decision", toId: decisionA, ageDays: 9 });
  await insertEdge({ fromType: "commitment", fromId: taskC, toType: "decision", toId: decisionA, ageDays: 9 });
  await insertEdge({ fromType: "commitment", fromId: taskD, toType: "decision", toId: decisionA, ageDays: 9 });
  await insertEdge({ fromType: "commitment", fromId: taskF, toType: "decision", toId: decisionE, ageDays: 9 });
  await insertEdge({ fromType: "commitment", fromId: taskT2, toType: "commitment", toId: taskB, ageDays: 9 });
  await insertEdge({ fromType: "commitment", fromId: taskT3, toType: "commitment", toId: taskT2, ageDays: 9 });
  await insertEdge({ fromType: "commitment", fromId: taskT4, toType: "commitment", toId: taskT3, ageDays: 9 });
  await insertEdge({ fromType: "commitment", fromId: taskMet, toType: "decision", toId: decisionClosed, ageDays: 9 });
  await insertEdge({ fromType: "commitment", fromId: cycX, toType: "commitment", toId: cycY, ageDays: 2, type: "commitment.detected" });
  await insertEdge({ fromType: "commitment", fromId: cycY, toType: "commitment", toId: cycX, ageDays: 2, type: "commitment.detected" });
  await insertEdge({ fromType: "commitment", fromId: blockedStale, toType: "decision", toId: decisionE, ageDays: 8 });
  await insertEdge({
    fromType: "commitment", fromId: expiredBlocked, toType: "decision", toId: decisionA,
    ageDays: 10, validUntilDaysAgo: 1,
  });
  // Work-domain edge (own domain, own source event).
  {
    const sourceEventId = await insertEvent({
      domainKey: "work",
      type: "capture.recorded",
      ageDays: 1,
      payload: { note: "work dependency" },
    });
    await db.query(
      `INSERT INTO relationships (domain_id, from_type, from_id, relation, to_type, to_id,
                                  source_event_id, created_at, updated_at)
       VALUES ($1::uuid, 'commitment', $2::uuid, 'blocked_by', 'decision', $3::uuid,
               $4::uuid, $5::timestamptz, $5::timestamptz)`,
      [dom("work"), workTask, decisionWork, sourceEventId, at(1).toISOString()],
    );
  }

  // Meaningful progress event referencing progressRescued, one day old.
  const progressEvent = await insertEvent({
    domainKey: "personal",
    type: "capture.recorded",
    ageDays: 1,
    payload: { commitmentId: progressRescued, note: "half done" },
  });

  return {
    domains: { personal: dom("personal"), work: dom("work") },
    entities: { acmeOrg, projectStalled, projectActive },
    commitments: {
      waitingOverdue,
      waitingFuture,
      renegotiatedPast,
      voidPast,
      mineOverdue,
      mineDueSoon,
      mineNoDue,
      metPast,
      workMine,
      taskB,
      taskC,
      taskD,
      taskF,
      taskT2,
      taskT3,
      taskT4,
      taskMet,
      cycX,
      cycY,
      staleUnblocked,
      freshUnblocked,
      blockedStale,
      expiredBlocked,
      progressRescued,
      workTask,
    },
    decisions: { decisionA, decisionE, decisionClosed, decisionNoDownstream, decisionWork },
    events: { progressEvent },
  };
}
