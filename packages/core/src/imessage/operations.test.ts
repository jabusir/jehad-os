// §22 build item 2 tests — the typed operation registry (intelligence
// reset §22.2/§22.3/§22.4/§22.6). Hermetic: the full parse matrix
// (accept/reject per field and combo), the NO-SCAN proof (model/provider
// names in replies, interpretations, and task titles parse fine), the
// consent-class bar, and the pending-id format. Integration (skipIf
// TEST_DATABASE_URL, following turn-interpretation.integration.test.ts):
// executor happy/failure paths against the existing bridges.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { activeProfile } from "./profiles.js";
import { applyTaskBatch, proposalFromPending } from "./turn-interpretation.js";
import { parseThreadMetadata, resolveActiveThread } from "./threads.js";
import {
  CONSENT_CLASS_BAR,
  COGNITIVE_OPERATION_TYPES,
  PENDING_PROPOSAL_ID_RE,
  executeOperation,
  parseCognitiveEnvelope,
  parseCognitiveOperation,
  pendingProposalId,
  resolutionAllowed,
  type CognitiveOperation,
  type OperationContext,
} from "./operations.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Thursday 2026-09-24, 12:00 PDT — noon local, so civil-date and
// next-civil-day math is stable in every integration case below.
const NOW = new Date("2026-09-24T19:00:00.000Z");
const TOMORROW = "2026-09-25";

// ---------------------------------------------------------------- helpers

function envelopeOf(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reads_requested: [],
    operations_requested: [],
    proposal_resolutions: [],
    interpretation: "a one-line reading of the turn",
    intent: "chat",
    ...overrides,
  });
}

function opParses(op: unknown): boolean {
  return parseCognitiveOperation(op) !== null;
}

function envelopeParses(overrides: Record<string, unknown> = {}): boolean {
  return parseCognitiveEnvelope(envelopeOf(overrides)) !== null;
}

const UUID_A = "0b75a8db-d6b6-4a1b-9c58-3d0f9a4a6f22";
const UUID_B = "3e97c0fd-a8d8-4c3d-be70-5f201c6c8044";

// ======================================================================
// Hermetic: parseCognitiveOperation (strict, fail-closed, NO text scan)
// ======================================================================

describe("parseCognitiveOperation (per-type matrix)", () => {
  // ------------------------------------------------------------ profile_update
  it("accepts each single-change profile_update shape", () => {
    expect(parseCognitiveOperation({ type: "profile_update", addressOwnerName: "Sir" })).toEqual({
      type: "profile_update",
      addressOwnerName: "Sir",
    });
    expect(parseCognitiveOperation({ type: "profile_update", removeAddress: true })).toEqual({
      type: "profile_update",
      removeAddress: true,
    });
    expect(parseCognitiveOperation({ type: "profile_update", toneNote: "warmer, less clipped" })).toMatchObject({
      toneNote: "warmer, less clipped",
    });
    expect(parseCognitiveOperation({ type: "profile_update", brevityMaxSentences: 2 })).toMatchObject({
      brevityMaxSentences: 2,
    });
    expect(parseCognitiveOperation({ type: "profile_update", extraDirective: "always cite the source" })).toMatchObject({
      extraDirective: "always cite the source",
    });
  });

  it("rejects set+remove combos, multi-change ops, no-change ops, and bad values", () => {
    expect(opParses({ type: "profile_update", addressOwnerName: "Sir", removeAddress: true })).toBe(false);
    expect(opParses({ type: "profile_update", addressOwnerName: "Sir", toneNote: "x" })).toBe(false);
    expect(opParses({ type: "profile_update" })).toBe(false);
    expect(opParses({ type: "profile_update", removeAddress: false })).toBe(false);
    expect(opParses({ type: "profile_update", removeAddress: "yes" })).toBe(false);
    expect(opParses({ type: "profile_update", brevityMaxSentences: 0 })).toBe(false);
    expect(opParses({ type: "profile_update", brevityMaxSentences: 11 })).toBe(false);
    expect(opParses({ type: "profile_update", brevityMaxSentences: 2.5 })).toBe(false);
    expect(opParses({ type: "profile_update", toneNote: "x".repeat(121) })).toBe(false);
    expect(opParses({ type: "profile_update", toneNote: "" })).toBe(false);
    expect(opParses({ type: "profile_update", unknownKey: 1 })).toBe(false);
  });

  it("holds the profile address-term door (the existing profile validator, not a text scan)", () => {
    expect(opParses({ type: "profile_update", addressOwnerName: "Sir!" })).toBe(false); // name-shape
    expect(opParses({ type: "profile_update", addressOwnerName: "x".repeat(61) })).toBe(false);
    expect(opParses({ type: "profile_update", addressOwnerName: "" })).toBe(false);
    // §22.4's persona-fragment vocabulary door on profile values:
    expect(opParses({ type: "profile_update", addressOwnerName: "Budget" })).toBe(false);
    expect(opParses({ type: "profile_update", addressOwnerName: "Chief" })).toBe(true);
    // …but the SAME words in payload TEXT fields are never scanned (below).
    expect(opParses({ type: "memory_candidate", summary: "the budget reads line item is policy-adjacent" })).toBe(true);
  });

  // ---------------------------------------------------------------- task_batch
  it("accepts 1..20 items, coerces omitted/null due to null; rejects bounds violations", () => {
    expect(parseCognitiveOperation({ type: "task_batch", items: [{ title: "pick up suit" }] })).toEqual({
      type: "task_batch",
      items: [{ title: "pick up suit", due: null }],
    });
    const twenty = Array.from({ length: 20 }, (_, i) => ({ title: `task ${i + 1}` }));
    expect(opParses({ type: "task_batch", items: twenty })).toBe(true);
    expect(opParses({ type: "task_batch", items: [...twenty, { title: "one too many" }] })).toBe(false);
    expect(opParses({ type: "task_batch", items: [] })).toBe(false);
    expect(opParses({ type: "task_batch", items: [{ title: "x".repeat(121) }] })).toBe(false);
    expect(opParses({ type: "task_batch", items: [{ title: "ok", due: "x".repeat(41) }] })).toBe(false);
    expect(opParses({ type: "task_batch", items: [{ title: "ok", due: 7 }] })).toBe(false);
    expect(opParses({ type: "task_batch", items: [{ title: "ok", due: null }] })).toBe(true);
    expect(opParses({ type: "task_batch", items: [{ title: "ok", extra: 1 }] })).toBe(false);
    expect(opParses({ type: "task_batch", items: "eight things" })).toBe(false);
  });

  // ------------------------------------------------------------ reminder_create
  it("validates reminder_create shape (parseReminderPhrase-shaped)", () => {
    expect(
      parseCognitiveOperation({
        type: "reminder_create",
        title: "call sheikh jamaal",
        dueDate: null,
        dueTime: null,
        whenWords: "tomorrow at 9am",
      }),
    ).toMatchObject({ whenWords: "tomorrow at 9am" });
    expect(
      opParses({
        type: "reminder_create",
        title: "t",
        dueDate: "2026-09-25",
        dueTime: { hour: 9, minute: 0 },
        whenWords: null,
      }),
    ).toBe(true);
    expect(
      opParses({ type: "reminder_create", title: "t", dueDate: "2026-13-01", dueTime: null, whenWords: null }),
    ).toBe(false);
    expect(
      opParses({ type: "reminder_create", title: "t", dueDate: "tomorrow", dueTime: null, whenWords: null }),
    ).toBe(false);
    expect(
      opParses({ type: "reminder_create", title: "t", dueDate: null, dueTime: { hour: 24, minute: 0 }, whenWords: null }),
    ).toBe(false);
    expect(
      opParses({ type: "reminder_create", title: "t", dueDate: null, dueTime: { hour: 9, minute: 60 }, whenWords: null }),
    ).toBe(false);
    expect(
      opParses({ type: "reminder_create", title: "t", dueDate: null, dueTime: { hour: 9 }, whenWords: null }),
    ).toBe(false);
    expect(
      opParses({ type: "reminder_create", title: "t", dueDate: null, dueTime: null, whenWords: "x".repeat(41) }),
    ).toBe(false);
    expect(
      opParses({ type: "reminder_create", title: "t", dueDate: null, dueTime: null, whenWords: null, extra: 1 }),
    ).toBe(false);
    expect(opParses({ type: "reminder_create", title: "t", dueDate: null, dueTime: null })).toBe(false); // keys required
  });

  // ------------------------------------------------------------- reminder_reply
  it("validates reminder_reply (uuid id, exact kinds, bounded whenText)", () => {
    expect(
      parseCognitiveOperation({ type: "reminder_reply", reminderId: UUID_A, kind: "renegotiate", whenText: "tomorrow at 9am" }),
    ).toMatchObject({ kind: "renegotiate", whenText: "tomorrow at 9am" });
    expect(opParses({ type: "reminder_reply", reminderId: UUID_A, kind: "done", whenText: null })).toBe(true);
    expect(opParses({ type: "reminder_reply", reminderId: "not-a-uuid", kind: "done", whenText: null })).toBe(false);
    expect(opParses({ type: "reminder_reply", reminderId: UUID_A, kind: "later", whenText: null })).toBe(false);
    expect(opParses({ type: "reminder_reply", reminderId: UUID_A, kind: "done", whenText: "x".repeat(41) })).toBe(false);
  });

  // ------------------------------------------------------ commitment_transition
  it("validates commitment_transition", () => {
    for (const verb of ["done", "missed", "renegotiated"] as const) {
      expect(opParses({ type: "commitment_transition", commitmentId: UUID_B, verb, note: null })).toBe(true);
    }
    expect(opParses({ type: "commitment_transition", commitmentId: UUID_B, verb: "completed", note: null })).toBe(false);
    expect(opParses({ type: "commitment_transition", commitmentId: UUID_B, verb: "done", note: "x".repeat(121) })).toBe(false);
    expect(opParses({ type: "commitment_transition", commitmentId: "nope", verb: "done", note: null })).toBe(false);
  });

  // --------------------------------------------------------- occurrence_update
  it("validates occurrence_update", () => {
    expect(opParses({ type: "occurrence_update", calendarEventId: UUID_A, happened: true })).toBe(true);
    expect(opParses({ type: "occurrence_update", calendarEventId: UUID_A, happened: false })).toBe(true);
    expect(opParses({ type: "occurrence_update", calendarEventId: UUID_A, happened: "yes" })).toBe(false);
    expect(opParses({ type: "occurrence_update", calendarEventId: "nope", happened: true })).toBe(false);
  });

  // ------------------------------------------------------- calibration_feedback
  it("validates calibration_feedback kinds and their exclusive fields", () => {
    expect(opParses({ type: "calibration_feedback", kind: "rating", rating: 4 })).toBe(true);
    for (const rating of [1, 5]) {
      expect(opParses({ type: "calibration_feedback", kind: "rating", rating })).toBe(true);
    }
    for (const rating of [0, 6, 3.5]) {
      expect(opParses({ type: "calibration_feedback", kind: "rating", rating })).toBe(false);
    }
    expect(opParses({ type: "calibration_feedback", kind: "rating" })).toBe(false);
    expect(opParses({ type: "calibration_feedback", kind: "miss" })).toBe(true);
    expect(opParses({ type: "calibration_feedback", kind: "miss", category: "overclaim" })).toBe(false);
    expect(opParses({ type: "calibration_feedback", kind: "correction" })).toBe(false);
    expect(opParses({ type: "calibration_feedback", kind: "correction", category: "wat" })).toBe(false);
    expect(opParses({ type: "calibration_feedback", kind: "correction", category: "overclaim", rating: 3 })).toBe(false);
    const categories = [
      "planned_not_observed",
      "observed_but_missing",
      "wrong_sequence",
      "wrong_priority",
      "wrong_completion_state",
      "source_coverage_gap",
      "overclaim",
    ];
    expect(categories).toHaveLength(7);
    for (const category of categories) {
      expect(opParses({ type: "calibration_feedback", kind: "correction", category })).toBe(true);
    }
  });

  // ------------------------------------------------------------ system_feedback
  it("validates system_feedback", () => {
    expect(
      parseCognitiveOperation({
        type: "system_feedback",
        category: "capability_gap",
        subject: "cannot search the web",
        detail: "asked for a local cleaner",
      }),
    ).toMatchObject({ category: "capability_gap" });
    expect(opParses({ type: "system_feedback", category: "bug", subject: "repeated myself", detail: null })).toBe(true);
    expect(opParses({ type: "system_feedback", category: "complaint", subject: "x", detail: null })).toBe(false);
    expect(opParses({ type: "system_feedback", category: "bug", subject: "x".repeat(81), detail: null })).toBe(false);
    expect(opParses({ type: "system_feedback", category: "bug", subject: "x", detail: "y".repeat(201) })).toBe(false);
    expect(opParses({ type: "system_feedback", category: "bug", subject: "x" })).toBe(false); // detail key required (null ok)
  });

  // ----------------------------------------------------------- memory_candidate
  it("validates memory_candidate", () => {
    expect(opParses({ type: "memory_candidate", summary: "prefers venues with parking" })).toBe(true);
    expect(opParses({ type: "memory_candidate", summary: "x".repeat(201) })).toBe(false);
    expect(opParses({ type: "memory_candidate", summary: "" })).toBe(false);
    expect(opParses({ type: "memory_candidate" })).toBe(false);
  });

  // ------------------------------------------------------------ calendar_action
  it("validates calendar_action (action-route shapes)", () => {
    expect(
      parseCognitiveOperation({
        type: "calendar_action",
        title: "Henna",
        day: "tomorrow",
        time: "2pm",
        endTime: "11pm",
        durationMinutes: null,
        location: "15038 River Rock, Fontana CA",
        description: "bring snacks",
        attendees: ["Sam@Example.com", "sam@example.com", "lea@example.com"],
      }),
    ).toMatchObject({ attendees: ["sam@example.com", "lea@example.com"] }); // deduped lowercase
    expect(
      opParses({
        type: "calendar_action",
        title: "Dentist",
        day: "today",
        time: "7pm",
        endTime: null,
        durationMinutes: 90,
        location: null,
        description: null,
        attendees: null,
      }),
    ).toBe(true);
    expect(
      opParses({
        type: "calendar_action",
        title: "X",
        day: "friday",
        time: null,
        endTime: null,
        durationMinutes: null,
        location: null,
        description: null,
        attendees: null,
      }),
    ).toBe(false);
    expect(
      opParses({
        type: "calendar_action",
        title: "X",
        day: "today",
        time: "not a time",
        endTime: null,
        durationMinutes: null,
        location: null,
        description: null,
        attendees: null,
      }),
    ).toBe(false);
    expect(
      opParses({
        type: "calendar_action",
        title: "X",
        day: "today",
        time: null,
        endTime: null,
        durationMinutes: 10,
        location: null,
        description: null,
        attendees: null,
      }),
    ).toBe(false);
    expect(
      opParses({
        type: "calendar_action",
        title: "X",
        day: "today",
        time: null,
        endTime: null,
        durationMinutes: 721,
        location: null,
        description: null,
        attendees: null,
      }),
    ).toBe(false);
    expect(
      opParses({
        type: "calendar_action",
        title: "X",
        day: "today",
        time: null,
        endTime: null,
        durationMinutes: null,
        location: null,
        description: null,
        attendees: ["not-an-email"],
      }),
    ).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => `p${i}@example.com`);
    expect(
      opParses({
        type: "calendar_action",
        title: "X",
        day: "today",
        time: null,
        endTime: null,
        durationMinutes: null,
        location: null,
        description: null,
        attendees: eleven,
      }),
    ).toBe(false);
  });

  // --------------------------------------------------------------- outcome_spec
  it("validates outcome_spec (coerceOutcomeSpec semantics)", () => {
    expect(
      parseCognitiveOperation({
        type: "outcome_spec",
        title: "Plaid security review",
        directive: "own the review until done",
        criteria: ["all four findings covered"],
        budget_usd: 2,
        deadline_days: 7,
      }),
    ).toMatchObject({ budget_usd: 2, deadline_days: 7 });
    expect(
      opParses({ type: "outcome_spec", title: "T", criteria: ["c"], budget_usd: null, deadline_days: null }),
    ).toBe(true); // directive optional
    expect(
      parseCognitiveOperation({ type: "outcome_spec", title: "T", criteria: ["c"], budget_usd: null, deadline_days: null }),
    ).toMatchObject({ directive: "" });
    expect(opParses({ type: "outcome_spec", title: "T", criteria: [], budget_usd: null, deadline_days: null })).toBe(false);
    expect(
      opParses({ type: "outcome_spec", title: "T", criteria: Array.from({ length: 6 }, () => "c"), budget_usd: null, deadline_days: null }),
    ).toBe(false);
    expect(opParses({ type: "outcome_spec", title: "T", criteria: ["c"], budget_usd: 50.01, deadline_days: null })).toBe(false);
    expect(opParses({ type: "outcome_spec", title: "T", criteria: ["c"], budget_usd: -1, deadline_days: null })).toBe(false);
    expect(opParses({ type: "outcome_spec", title: "T", criteria: ["c"], budget_usd: null, deadline_days: 31 })).toBe(false);
    expect(opParses({ type: "outcome_spec", title: "T", criteria: ["c"], budget_usd: null, deadline_days: 1.5 })).toBe(false);
    expect(opParses({ type: "outcome_spec", title: "T", directive: "x".repeat(501), criteria: ["c"], budget_usd: null, deadline_days: null })).toBe(false);
  });

  // ----------------------------------------------------- cross_principal_profile
  it("validates cross_principal_profile (named target, ≥1 change)", () => {
    expect(
      parseCognitiveOperation({ type: "cross_principal_profile", targetPrincipal: "yusra", change: { ownerName: "Yusra" } }),
    ).toMatchObject({ change: { ownerName: "Yusra" } });
    expect(
      opParses({ type: "cross_principal_profile", targetPrincipal: "yusra", change: { toneNote: "urdu, mentions the kids" } }),
    ).toBe(true);
    expect(opParses({ type: "cross_principal_profile", targetPrincipal: "self", change: { toneNote: "x" } })).toBe(false);
    expect(opParses({ type: "cross_principal_profile", targetPrincipal: "yusra", change: {} })).toBe(false);
    expect(opParses({ type: "cross_principal_profile", targetPrincipal: "yusra", change: { ownerName: "Bad!!" } })).toBe(false);
    expect(opParses({ type: "cross_principal_profile", targetPrincipal: "x".repeat(61), change: { toneNote: "x" } })).toBe(false);
    expect(opParses({ type: "cross_principal_profile", targetPrincipal: "yusra", change: { other: "x" } })).toBe(false);
  });

  it("rejects unknown types and non-object shapes", () => {
    expect(opParses({ type: "calendar.create", title: "sneaky" })).toBe(false);
    expect(opParses({ type: "read_files", path: "/etc/passwd" })).toBe(false);
    expect(opParses(null)).toBe(false);
    expect(opParses("task_batch")).toBe(false);
    expect(opParses([1, 2])).toBe(false);
  });
});

// ======================================================================
// Hermetic: parseCognitiveEnvelope (§22.2 strictness)
// ======================================================================

describe("parseCognitiveEnvelope (strict single-line JSON)", () => {
  it("parses the §22.2 example shape", () => {
    const envelope = parseCognitiveEnvelope(
      envelopeOf({
        reads_requested: [{ tool: "commitments.waiting" }, { tool: "gmail.search", query: "plaid", max_age_days: 7 }],
        operations_requested: [
          { type: "profile_update", addressOwnerName: "Sir" },
          { type: "task_batch", items: [{ title: "pick up suit" }] },
        ],
        proposal_resolutions: [{ id: "task_batch:a1b2", action: "apply" }],
        interpretation: "wants the address changed and a list tracked",
        intent: "directive",
        reply: "Done — Sir it is. Want me to track the suit pickup?",
      }),
    );
    expect(envelope).not.toBeNull();
    expect(envelope!.reads_requested).toHaveLength(2);
    expect(envelope!.operations_requested).toHaveLength(2);
    expect(envelope!.operations_requested[0]).toMatchObject({ addressOwnerName: "Sir" });
    expect(envelope!.proposal_resolutions).toEqual([{ id: "task_batch:a1b2", action: "apply" }]);
    expect(envelope!.intent).toBe("directive");
  });

  it("reply is optional (§22.3 finality governs presence); absence parses to null", () => {
    const envelope = parseCognitiveEnvelope(envelopeOf());
    expect(envelope).not.toBeNull();
    expect(envelope!.reply).toBeNull();
  });

  it("rejects unknown/missing top-level keys", () => {
    expect(envelopeParses({ model: "gpt-4.1" })).toBe(false);
    expect(envelopeParses({ budget_usd: 5 })).toBe(false);
    expect(parseCognitiveEnvelope(JSON.stringify({
      reads_requested: [],
      operations_requested: [],
      proposal_resolutions: [],
      interpretation: "x",
      intent: "chat",
    }))).not.toBeNull();
    expect(parseCognitiveEnvelope(JSON.stringify({
      operations_requested: [],
      proposal_resolutions: [],
      interpretation: "x",
      intent: "chat",
    }))).toBeNull(); // reads_requested required
    expect(parseCognitiveEnvelope(JSON.stringify({
      reads_requested: [],
      operations_requested: [],
      proposal_resolutions: [],
      interpretation: "x",
    }))).toBeNull(); // intent required
  });

  it("fails closed on fences, prose, multi-line JSON, and arrays", () => {
    expect(parseCognitiveEnvelope("```json\n" + envelopeOf() + "\n```")).toBeNull();
    expect(parseCognitiveEnvelope("Sure — here is my plan: " + envelopeOf())).toBeNull();
    expect(parseCognitiveEnvelope(envelopeOf() + " hope that helps")).toBeNull();
    expect(
      parseCognitiveEnvelope(
        JSON.stringify({
          reads_requested: [],
          operations_requested: [],
          proposal_resolutions: [],
          interpretation: "x",
          intent: "chat",
          reply: "line one\nline two",
        }),
      ),
    ).not.toBeNull(); // NEWLINES IN reply are fine — the ENVELOPE is single-line
    expect(parseCognitiveEnvelope("[1,2,3]")).toBeNull();
    expect(parseCognitiveEnvelope("[]")).toBeNull();
  });

  it("bounds interpretation (≤200), reply (≤1500), and the intent enum", () => {
    expect(envelopeParses({ interpretation: "x".repeat(200) })).toBe(true);
    expect(envelopeParses({ interpretation: "x".repeat(201) })).toBe(false);
    expect(envelopeParses({ reply: "x".repeat(1500) })).toBe(true);
    expect(envelopeParses({ reply: "x".repeat(1501) })).toBe(false);
    expect(envelopeParses({ intent: "smalltalk" })).toBe(false);
    for (const intent of ["question", "directive", "preference", "correction", "feedback", "delegation", "capability", "chat"]) {
      expect(envelopeParses({ intent })).toBe(true);
    }
  });

  it("bounds reads (≤3, no repeats) and validates per-tool args via the route parser", () => {
    expect(envelopeParses({ reads_requested: [{ tool: "calendar.next" }] })).toBe(true);
    expect(envelopeParses({ reads_requested: [{ tool: "calendar.day", day: "tomorrow" }] })).toBe(true);
    expect(envelopeParses({ reads_requested: [{ tool: "calendar.day", day: "friday" }] })).toBe(false);
    expect(envelopeParses({ reads_requested: [{ tool: "calendar.day" }] })).toBe(false);
    expect(envelopeParses({ reads_requested: [{ tool: "gmail.search", query: "plaid", max_age_days: 7 }] })).toBe(true);
    expect(envelopeParses({ reads_requested: [{ tool: "gmail.search" }] })).toBe(false);
    expect(envelopeParses({ reads_requested: [{ tool: "gmail.search", query: "plaid", max_age_days: 8 }] })).toBe(false);
    expect(envelopeParses({ reads_requested: [{ tool: "gmail.read", message_id: "m-123" }] })).toBe(true);
    expect(envelopeParses({ reads_requested: [{ tool: "calendar.write", title: "sneaky" }] })).toBe(false);
    expect(envelopeParses({ reads_requested: [{ tool: "none" }] })).toBe(false);
    const three = [{ tool: "calendar.next" }, { tool: "commitments.waiting" }, { tool: "day.state" }];
    expect(envelopeParses({ reads_requested: three })).toBe(true);
    expect(envelopeParses({ reads_requested: [...three, { tool: "system.state" }] })).toBe(false);
    expect(envelopeParses({ reads_requested: [{ tool: "day.state" }, { tool: "day.state" }] })).toBe(false);
  });

  it("bounds operations (≤4, one per type) and resolutions (≤2, unique, exact actions)", () => {
    const fourOps: CognitiveOperation[] = [
      { type: "memory_candidate", summary: "x" },
      { type: "system_feedback", category: "bug", subject: "x", detail: null },
      { type: "occurrence_update", calendarEventId: UUID_A, happened: true },
      { type: "reminder_create", title: "t", dueDate: null, dueTime: null, whenWords: null },
    ];
    expect(envelopeParses({ operations_requested: fourOps })).toBe(true);
    expect(
      envelopeParses({
        operations_requested: [
          ...fourOps,
          { type: "commitment_transition", commitmentId: UUID_B, verb: "done", note: null },
        ],
      }),
    ).toBe(false);
    expect(
      envelopeParses({
        operations_requested: [
          { type: "memory_candidate", summary: "a" },
          { type: "memory_candidate", summary: "b" },
        ],
      }),
    ).toBe(false);
    expect(envelopeParses({ proposal_resolutions: [{ id: "task_batch:a1b2", action: "apply" }] })).toBe(true);
    expect(envelopeParses({ proposal_resolutions: [{ id: "task_batch:a1b2", action: "decline" }] })).toBe(true);
    expect(envelopeParses({ proposal_resolutions: [{ id: "task_batch:a1b2", action: "confirm" }] })).toBe(false);
    expect(envelopeParses({ proposal_resolutions: [{ id: "task_batch:a1b2" }] })).toBe(false);
    expect(envelopeParses({ proposal_resolutions: [{ id: "task_batch:a1b2c", action: "apply" }] })).toBe(false);
    expect(envelopeParses({ proposal_resolutions: [{ id: "task_batch:A1B2", action: "apply" }] })).toBe(false);
    expect(envelopeParses({ proposal_resolutions: [{ id: "bogus_type:a1b2", action: "apply" }] })).toBe(false);
    expect(
      envelopeParses({
        proposal_resolutions: [
          { id: "task_batch:a1b2", action: "apply" },
          { id: "task_batch:a1b2", action: "decline" },
        ],
      }),
    ).toBe(false);
    expect(
      envelopeParses({
        proposal_resolutions: [
          { id: "task_batch:a1b2", action: "apply" },
          { id: "memory_candidate:c3d4", action: "decline" },
          { id: "reminder_create:e5f6", action: "apply" },
        ],
      }),
    ).toBe(false);
  });

  it("NO-SCAN PROOF (owner correction 2): model/provider/tool names in text fields parse fine", () => {
    const envelope = parseCognitiveEnvelope(
      envelopeOf({
        reads_requested: [{ tool: "gmail.search", query: "openai vs anthropic pricing" }],
        operations_requested: [
          { type: "task_batch", items: [{ title: "Compare OpenAI and Anthropic pricing", due: "by friday" }] },
          {
            type: "system_feedback",
            category: "capability",
            subject: "what model are you running?",
            detail: "user asked whether replies come from gpt-4.1 or claude",
          },
        ],
        interpretation: "user wants a claude-vs-gpt-4.1 pricing comparison and asked about the model",
        intent: "question",
        reply: "Comparing OpenAI and Anthropic now — for reference, gpt-4.1 writes my quick replies.",
      }),
    );
    // system_feedback category "capability" is NOT in the enum — the whole
    // envelope must fail on STRUCTURAL grounds only. Re-run with a valid one.
    expect(envelope).toBeNull();
    const legal = parseCognitiveEnvelope(
      envelopeOf({
        reads_requested: [{ tool: "gmail.search", query: "openai vs anthropic pricing" }],
        operations_requested: [
          { type: "task_batch", items: [{ title: "Compare OpenAI and Anthropic pricing", due: "by friday" }] },
          {
            type: "system_feedback",
            category: "capability_gap",
            subject: "what model are you running?",
            detail: "user asked whether replies come from gpt-4.1 or claude",
          },
        ],
        interpretation: "user wants a claude-vs-gpt-4.1 pricing comparison and asked about the model",
        intent: "question",
        reply: "Comparing OpenAI and Anthropic now — for reference, gpt-4.1 writes my quick replies.",
      }),
    );
    expect(legal).not.toBeNull();
    expect(legal!.operations_requested[0]).toMatchObject({
      items: [{ title: "Compare OpenAI and Anthropic pricing", due: "by friday" }],
    });
    expect(legal!.reply).toContain("gpt-4.1");
    expect(legal!.interpretation).toContain("claude");
  });

  it("NO-SCAN PROOF: read-tool names inside payload text are ordinary words", () => {
    expect(opParses({ type: "memory_candidate", summary: "review the calendar.day coverage notes" })).toBe(true);
    expect(
      envelopeParses({
        operations_requested: [{ type: "memory_candidate", summary: "memory.recall felt weaker than gmail.recent" }],
      }),
    ).toBe(true);
  });

  it("redacts secrets at parse (data hygiene, not word policing)", () => {
    const envelope = parseCognitiveEnvelope(
      envelopeOf({
        operations_requested: [{ type: "memory_candidate", summary: "key sk-abcdef0123456789abcdef" }],
      }),
    );
    expect(envelope).not.toBeNull();
    expect(envelope!.operations_requested[0]).toMatchObject({
      summary: expect.not.stringContaining("sk-abcdef0123456789abcdef") as unknown,
    });
  });
});

// ======================================================================
// Hermetic: consent-class bar + pending ids
// ======================================================================

describe("CONSENT_CLASS_BAR (§22.6)", () => {
  it("allows every non-consequential type; blocks outcome_spec/calendar/cross-principal", () => {
    expect(CONSENT_CLASS_BAR.size).toBe(9);
    for (const type of COGNITIVE_OPERATION_TYPES) {
      const allowed = resolutionAllowed(type);
      if (type === "outcome_spec" || type === "calendar_action" || type === "cross_principal_profile") {
        expect(allowed).toBe(false);
      } else {
        expect(allowed, type).toBe(true);
      }
    }
  });

  it("unknown pending types are not resolvable", () => {
    expect(resolutionAllowed("configuration_directive")).toBe(false);
    expect(resolutionAllowed("calendar")).toBe(false);
    expect(resolutionAllowed("")).toBe(false);
  });
});

describe("pendingProposalId", () => {
  it("is `<type>:<4hex>` and deterministic in (type, at)", () => {
    const id = pendingProposalId("task_batch", "2026-09-24T19:00:00.000Z");
    expect(id).toMatch(/^task_batch:[0-9a-f]{4}$/);
    expect(id).toBe(pendingProposalId("task_batch", "2026-09-24T19:00:00.000Z"));
    expect(id).not.toBe(pendingProposalId("task_batch", "2026-09-24T19:00:01.000Z"));
    expect(id).not.toBe(pendingProposalId("outcome_spec", "2026-09-24T19:00:00.000Z"));
    expect(PENDING_PROPOSAL_ID_RE.test(id)).toBe(true);
  });
});

// ======================================================================
// Integration: executors (skipIf no TEST_DATABASE_URL — bridge coverage
// on a real database, the turn-interpretation.integration.test.ts seam)
// ======================================================================

describe.skipIf(!TEST_DATABASE_URL)("cognitive operation executors (integration)", () => {
  let db: IsolatedDb;
  let josctlId: string;
  let yusraId: string;
  let domainId: string;

  const ctx = (principalId: string, principalName: string, threadId: string | null = null): OperationContext => ({
    principalId,
    principalName,
    threadId,
    now: NOW,
  });

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "cogops");
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
    domainId = String(
      (await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`)).rows[0]!.id,
    );
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    await db.pool.query(`
      DELETE FROM audit_log;
      DELETE FROM action_attempts; DELETE FROM action_intents; DELETE FROM runs;
      DELETE FROM reminders; DELETE FROM feedback; DELETE FROM calibration_items;
      DELETE FROM memory_candidates; DELETE FROM outcomes; DELETE FROM commitments;
      DELETE FROM calendar_events; DELETE FROM interaction_messages; DELETE FROM interaction_threads;
      DELETE FROM events; DELETE FROM outbox;
      TRUNCATE interaction_profiles;
    `);
  });

  async function activeThread(principalId: string): Promise<string> {
    const thread = await resolveActiveThread(db.pool, {
      principalId,
      surface: "imessage",
      now: NOW,
    });
    return thread.id;
  }

  // ---------------------------------------------------------- profile_update

  it("G2: profile_update applies single-turn via seed-if-needed + applyDefinitionDelta + nextProfileVersion(self)", async () => {
    const result = await executeOperation(
      db.pool,
      { type: "profile_update", addressOwnerName: "Sir" },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("applied");
    expect(result.id).toBe("profile:v2"); // v1 = the owner_seed base

    const active = await activeProfile(db.pool, { principalId: josctlId, surface: "imessage" });
    expect(active?.version).toBe(2);
    expect(active?.definition.address.ownerName).toBe("Sir");
    const via = await db.pool.query(
      `SELECT created_via FROM interaction_profiles WHERE principal_id = $1::uuid ORDER BY version`,
      [josctlId],
    );
    expect(via.rows.map((r: { created_via: string }) => r.created_via)).toEqual(["owner_seed", "self"]);
    const audit = await db.pool.query(
      `SELECT outputs_ref FROM audit_log WHERE action = 'operation.profile_update.applied'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(String(audit.rows[0]!.outputs_ref)).not.toContain("Sir"); // ids/counts only
    expect(JSON.parse(String(audit.rows[0]!.outputs_ref)).change).toBe("addressOwnerName");
  });

  it("profile_update maps every change key onto the definition delta", async () => {
    await executeOperation(db.pool, { type: "profile_update", addressOwnerName: "Sir" }, ctx(josctlId, "josctl"));
    const tone = await executeOperation(
      db.pool,
      { type: "profile_update", toneNote: "warmer" },
      ctx(josctlId, "josctl"),
    );
    expect(tone.status).toBe("applied");
    const brief = await executeOperation(
      db.pool,
      { type: "profile_update", brevityMaxSentences: 2 },
      ctx(josctlId, "josctl"),
    );
    expect(brief.status).toBe("applied");
    const active = await activeProfile(db.pool, { principalId: josctlId, surface: "imessage" });
    expect(active?.definition.extraDirectives?.at(-1)).toBe("Voice note: warmer");
    expect(active?.definition.brevity.maxSentences).toBe(2);
    const removed = await executeOperation(
      db.pool,
      { type: "profile_update", removeAddress: true },
      ctx(josctlId, "josctl"),
    );
    expect(removed.status).toBe("applied");
    const after = await activeProfile(db.pool, { principalId: josctlId, surface: "imessage" });
    expect(after?.definition.address.ownerName).toBeUndefined();
  });

  it("G7: cross_principal_profile from a NON-owner is refused with zero rows", async () => {
    const result = await executeOperation(
      db.pool,
      { type: "cross_principal_profile", targetPrincipal: "josctl", change: { toneNote: "sweeter" } },
      ctx(yusraId, "yusra"),
    );
    expect(result.status).toBe("rejected");
    expect(result.detail).toBe("not-owner");
    const rows = await db.pool.query(`SELECT count(*)::int AS n FROM interaction_profiles`);
    expect(rows.rows[0].n).toBe(0);
  });

  it("cross_principal_profile from the owner stages (owner_seed) and reports queued", async () => {
    const result = await executeOperation(
      db.pool,
      { type: "cross_principal_profile", targetPrincipal: "yusra", change: { ownerName: "Yusra" } },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("queued");
    expect(result.id).toBe("profile:v1");
    const active = await activeProfile(db.pool, { principalId: yusraId, surface: "imessage" });
    expect(active?.definition.address.ownerName).toBe("Yusra");
    const via = await db.pool.query(
      `SELECT created_via FROM interaction_profiles WHERE principal_id = $1::uuid`,
      [yusraId],
    );
    expect(via.rows[0]!.created_via).toBe("owner_seed");
  });

  // -------------------------------------------------------------- task_batch

  it("task_batch PARKS as a pending proposal (parking IS execution) — no commitments written", async () => {
    const threadId = await activeThread(josctlId);
    const op = {
      type: "task_batch" as const,
      items: [
        { title: "Clean apartment", due: "by friday" },
        { title: "Pay the gardener", due: null },
      ],
    };
    const result = await executeOperation(db.pool, op, ctx(josctlId, "josctl", threadId));
    expect(result.status).toBe("parked");
    expect(result.id).toMatch(/^task_batch:[0-9a-f]{4}$/);

    const commitments = await db.pool.query(`SELECT count(*)::int AS n FROM commitments`);
    expect(commitments.rows[0].n).toBe(0); // the park writes NOTHING canonical

    const stored = parseThreadMetadata(
      (
        await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [threadId])
      ).rows[0].metadata,
    );
    const entries = stored?.pendingProposals ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("task_batch");
    // G6(d): the parked payload re-validates identically at apply time.
    const revalidated = proposalFromPending(entries[0]!);
    expect(revalidated).not.toBeNull();
    expect(revalidated).toMatchObject({
      type: "task_batch",
      items: [
        { title: "Clean apartment", due: "by friday" },
        { title: "Pay the gardener", due: null },
      ],
    });

    // Side-effect idempotency: a re-park at the same instant replaces the slot.
    const again = await executeOperation(db.pool, op, ctx(josctlId, "josctl", threadId));
    expect(again.status).toBe("parked");
    expect(again.id).toBe(result.id);
    const after = parseThreadMetadata(
      (
        await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [threadId])
      ).rows[0].metadata,
    );
    expect(after?.pendingProposals?.filter((p) => p.type === "task_batch")).toHaveLength(1);
  });

  it("task_batch without an active thread fails honestly", async () => {
    const result = await executeOperation(
      db.pool,
      { type: "task_batch", items: [{ title: "x" }] },
      ctx(josctlId, "josctl", null),
    );
    expect(result.status).toBe("failed");
    expect(result.detail).toBe("no-active-thread");
  });

  // ---------------------------------------------------------- reminder_create

  it("reminder_create applies immediately (commitment + armed reminder, tomorrow 9am default rhythm)", async () => {
    const result = await executeOperation(
      db.pool,
      { type: "reminder_create", title: "call sheikh jamaal", dueDate: null, dueTime: null, whenWords: "tomorrow at 9am" },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("applied");
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    const reminder = (
      await db.pool.query(`SELECT principal, title, status, due_date, due_time, commitment_id FROM reminders`)
    ).rows[0]!;
    expect(reminder.status).toBe("armed");
    expect(reminder.principal).toBe("josctl");
    expect(new Date(reminder.due_date).toISOString().slice(0, 10)).toBe(TOMORROW);
    expect(reminder.commitment_id).not.toBeNull();
    const commitment = (
      await db.pool.query(`SELECT description, status FROM commitments`)
    ).rows[0]!;
    expect(commitment.description).toBe("call sheikh jamaal");
    expect(commitment.status).toBe("open");
  });

  it("reminder_create with unresolvable when-words fails with zero rows (never a guess)", async () => {
    const result = await executeOperation(
      db.pool,
      { type: "reminder_create", title: "t", dueDate: null, dueTime: null, whenWords: "someday" },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("unsupported-when");
    for (const table of ["reminders", "commitments"]) {
      const rows = await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows.rows[0].n).toBe(0);
    }
  });

  // ----------------------------------------------------------- reminder_reply

  it("reminder_reply done completes the reminder and its linked commitment", async () => {
    const created = await executeOperation(
      db.pool,
      { type: "reminder_create", title: "call sheikh jamaal", dueDate: null, dueTime: null, whenWords: "tomorrow" },
      ctx(josctlId, "josctl"),
    );
    const result = await executeOperation(
      db.pool,
      { type: "reminder_reply", reminderId: created.id!, kind: "done", whenText: null },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("applied");
    const reminder = (
      await db.pool.query(`SELECT status, resolved_via FROM reminders WHERE id = $1::uuid`, [created.id])
    ).rows[0]!;
    expect(reminder.status).toBe("completed");
    expect(reminder.resolved_via).toBe("user_reply");
    const commitment = (await db.pool.query(`SELECT status FROM commitments`)).rows[0]!;
    expect(commitment.status).toBe("met");
  });

  it("reminder_reply on an unknown reminder fails honestly", async () => {
    const result = await executeOperation(
      db.pool,
      { type: "reminder_reply", reminderId: randomUUID(), kind: "done", whenText: null },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("failed");
    expect(result.detail).toBe("unknown-reminder");
  });

  // ---------------------------------------------------- commitment_transition

  it("commitment_transition applies the guarded open→met transition", async () => {
    const batch = await applyTaskBatch(db.pool, {
      proposal: { type: "task_batch", items: [{ title: "ship the contract notes", due: null }] },
      principalId: josctlId,
      now: NOW,
    });
    const commitmentId = batch.commitmentIds[0]!;
    const result = await executeOperation(
      db.pool,
      { type: "commitment_transition", commitmentId, verb: "done", note: "sent over email" },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("applied");
    expect(result.detail).toBe("met");
    const row = (
      await db.pool.query(`SELECT status FROM commitments WHERE id = $1::uuid`, [commitmentId])
    ).rows[0]!;
    expect(row.status).toBe("met");

    // Replay is an honest idempotent no-op, never a second mutation.
    const replay = await executeOperation(
      db.pool,
      { type: "commitment_transition", commitmentId, verb: "done", note: null },
      ctx(josctlId, "josctl"),
    );
    expect(replay.status).toBe("applied");
    expect(replay.detail).toBe("already-resolved");
  });

  it("commitment_transition on an unknown commitment fails", async () => {
    const result = await executeOperation(
      db.pool,
      { type: "commitment_transition", commitmentId: randomUUID(), verb: "missed", note: null },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("failed");
    expect(result.detail).toBe("unknown-commitment");
  });

  // -------------------------------------------------------- occurrence_update

  it("occurrence_update graduates a past-unverified event by user declaration", async () => {
    const sourceEventId = randomUUID();
    await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, idempotency_key, domain_id, payload, sensitivity, schema_version)
       VALUES ($1::uuid, 'calendar.event.created', 'adapter:google-calendar', $2::timestamptz, $3, $4::uuid, '{}', 'normal', 1)`,
      [sourceEventId, NOW.toISOString(), randomUUID(), domainId],
    );
    const eventId = randomUUID();
    await db.pool.query(
      `INSERT INTO calendar_events
         (id, google_event_id, google_calendar_id, status, summary, start_time, end_time,
          timezone, attendees, location, metadata, source_event_id, content_hash, occurrence)
       VALUES ($1::uuid, 'occ-1', 'primary', 'confirmed', 'Henna prep', $2::timestamptz, $3::timestamptz,
               NULL, '[]', NULL, '{}', $4::uuid, 'x', 'scheduled_past_unverified')`,
      [
        eventId,
        new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
        new Date(NOW.getTime() - 3_600_000).toISOString(),
        sourceEventId,
      ],
    );
    const result = await executeOperation(
      db.pool,
      { type: "occurrence_update", calendarEventId: eventId, happened: true },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("applied");
    expect(result.detail).toBe("observed_occurred");
    const row = (
      await db.pool.query(`SELECT occurrence FROM calendar_events WHERE id = $1::uuid`, [eventId])
    ).rows[0]!;
    expect(row.occurrence).toBe("observed_occurred");

    // Replay fails honestly (already graduated), never silently re-graduates.
    const replay = await executeOperation(
      db.pool,
      { type: "occurrence_update", calendarEventId: eventId, happened: false },
      ctx(josctlId, "josctl"),
    );
    expect(replay.status).toBe("failed");
    expect(replay.detail).toBe("already-graduated");
  });

  it("occurrence_update on an unknown event fails", async () => {
    const result = await executeOperation(
      db.pool,
      { type: "occurrence_update", calendarEventId: randomUUID(), happened: false },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("failed");
    expect(result.detail).toBe("unknown-calendar-event");
  });

  // ------------------------------------------------------- calibration_feedback

  it("calibration_feedback rating stores on the sole open item (§22.10's 4-rating case)", async () => {
    const item = await db.pool.query(
      `INSERT INTO calibration_items (principal_id, period_date, surface, summary, prompt_sent_at)
       VALUES ($1::uuid, '2026-09-24', 'imessage', '{}', $2::timestamptz) RETURNING id`,
      [josctlId, NOW.toISOString()],
    );
    const itemId = String(item.rows[0].id);
    const result = await executeOperation(
      db.pool,
      { type: "calibration_feedback", kind: "rating", rating: 4 },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("applied");
    expect(result.id).toBe(itemId);
    const row = (
      await db.pool.query(`SELECT rating FROM calibration_items WHERE id = $1::uuid`, [itemId])
    ).rows[0]!;
    expect(row.rating).toBe(4);
  });

  it("calibration_feedback miss/correction land as feedback rows without user free text", async () => {
    await db.pool.query(
      `INSERT INTO calibration_items (principal_id, period_date, surface, summary, prompt_sent_at)
       VALUES ($1::uuid, '2026-09-24', 'imessage', '{}', $2::timestamptz)`,
      [josctlId, NOW.toISOString()],
    );
    const miss = await executeOperation(
      db.pool,
      { type: "calibration_feedback", kind: "miss" },
      ctx(josctlId, "josctl"),
    );
    expect(miss.status).toBe("applied");
    const correction = await executeOperation(
      db.pool,
      { type: "calibration_feedback", kind: "correction", category: "observed_but_missing" },
      ctx(josctlId, "josctl"),
    );
    expect(correction.status).toBe("applied");
    const rows = (
      await db.pool.query(`SELECT verdict, note, source_attribution FROM feedback ORDER BY created_at`)
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { verdict: string }) => r.verdict === "missed")).toBe(true);
    expect(rows[1].source_attribution).toBe("observed_but_missing");
    // No free-text diary of private messages rides the durable row.
    expect(String(rows[0].note)).not.toMatch(/[A-Z]/); // fixed lowercase markers only
  });

  it("calibration_feedback rating with no open item fails honestly", async () => {
    const result = await executeOperation(
      db.pool,
      { type: "calibration_feedback", kind: "rating", rating: 3 },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("failed");
    expect(result.detail).toBe("no-open-item");
  });

  // ----------------------------------------------------------- system_feedback

  it("system_feedback lands one append-only feedback row via the existing bridge", async () => {
    const result = await executeOperation(
      db.pool,
      { type: "system_feedback", category: "capability_gap", subject: "cannot search the web", detail: "wanted a local cleaner" },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("applied");
    const row = (
      await db.pool.query(`SELECT item_type, verdict, note, created_by FROM feedback`)
    ).rows[0]!;
    expect(row.item_type).toBe("system_feedback");
    expect(row.verdict).toBe("capability_gap");
    expect(row.note).toBe("cannot search the web — wanted a local cleaner");
    expect(row.created_by).toBe(josctlId);
  });

  it("system_feedback with an invalid principal id fails before any write", async () => {
    const result = await executeOperation(
      db.pool,
      { type: "system_feedback", category: "bug", subject: "x", detail: null },
      ctx("not-a-uuid", "josctl"),
    );
    expect(result.status).toBe("failed");
    expect(result.detail).toBe("invalid-principal-id");
    const rows = await db.pool.query(`SELECT count(*)::int AS n FROM feedback`);
    expect(rows.rows[0].n).toBe(0);
  });

  // --------------------------------------------------------- memory_candidate

  it("memory_candidate mints the canonical capture.recorded event + in_review candidate", async () => {
    const op = { type: "memory_candidate" as const, summary: "prefers venues with parking" };
    const result = await executeOperation(db.pool, op, ctx(josctlId, "josctl"));
    expect(result.status).toBe("applied");
    const candidate = (
      await db.pool.query(`SELECT proposed_class, assertion_kind, status FROM memory_candidates`)
    ).rows[0]!;
    expect(candidate.status).toBe("in_review"); // force-review, never auto-canonized
    const events = (await db.pool.query(`SELECT type FROM events ORDER BY type`)).rows;
    expect(events.map((e: { type: string }) => e.type)).toEqual(["capture.recorded", "memory.proposed"]);

    // Deterministic candidate id → side-effect-idempotent replay.
    const replay = await executeOperation(db.pool, op, ctx(josctlId, "josctl"));
    expect(replay.status).toBe("applied");
    expect(replay.detail).toBe("already-in-review");
    const count = await db.pool.query(`SELECT count(*)::int AS n FROM memory_candidates`);
    expect(count.rows[0].n).toBe(1);
  });

  it("memory_candidate is capture-gated per principal (yusra denied by default)", async () => {
    const result = await executeOperation(
      db.pool,
      { type: "memory_candidate", summary: "yusra fact" },
      ctx(yusraId, "yusra"),
    );
    expect(result.status).toBe("rejected");
    expect(result.detail).toBe("principal-not-capture-enabled");
    const rows = await db.pool.query(`SELECT count(*)::int AS n FROM memory_candidates`);
    expect(rows.rows[0].n).toBe(0);
  });

  // ----------------------------------------------------------- calendar_action

  it("calendar_action parks as a confirm-token intent (the token returns to cognition as data)", async () => {
    const threadId = await activeThread(josctlId);
    const result = await executeOperation(
      db.pool,
      {
        type: "calendar_action",
        title: "Henna",
        day: "tomorrow",
        time: "2pm",
        endTime: "11pm",
        durationMinutes: null,
        location: "15038 River Rock, Fontana CA",
        description: null,
        attendees: ["sam@example.com"],
      },
      ctx(josctlId, "josctl", threadId),
    );
    expect(result.status).toBe("parked");
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.detail).toMatch(/^confirm [0-9A-HJKMNP-TV-Z]{5}$/); // token quoted verbatim
    const intent = (
      await db.pool.query(`SELECT capability, status, payload FROM action_intents WHERE id = $1::uuid`, [result.id])
    ).rows[0]!;
    expect(intent.capability).toBe("act:google-calendar");
    expect(intent.status).toBe("proposed");
    expect(intent.payload.action).toBe("calendar_create");
    expect(intent.payload.title).toBe("Henna");
    // Nothing was created on any calendar — the token lane is the only applier.
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM calendar_events WHERE summary = 'Henna'`)).rows[0].n).toBe(0);
  });

  it("calendar_action for a policy-disabled principal is rejected (denied, zero intents)", async () => {
    const result = await executeOperation(
      db.pool,
      {
        type: "calendar_action",
        title: "X",
        day: "today",
        time: "3pm",
        endTime: null,
        durationMinutes: null,
        location: null,
        description: null,
        attendees: null,
      },
      ctx(yusraId, "yusra"),
    );
    expect(result.status).toBe("rejected");
    expect(result.detail).toBe("denied");
    const rows = await db.pool.query(`SELECT count(*)::int AS n FROM action_intents`);
    expect(rows.rows[0].n).toBe(0);
  });

  it("calendar_action without a parsable time fails honestly", async () => {
    const result = await executeOperation(
      db.pool,
      {
        type: "calendar_action",
        title: "X",
        day: "today",
        time: null,
        endTime: null,
        durationMinutes: null,
        location: null,
        description: null,
        attendees: null,
      },
      ctx(josctlId, "josctl"),
    );
    expect(result.status).toBe("failed");
    expect(result.detail).toBe("schedule-time-missing");
  });

  // -------------------------------------------------------------- outcome_spec

  it("outcome_spec parks as a pending proposal; no outcome is created; siblings persist", async () => {
    const threadId = await activeThread(josctlId);
    // An existing task_batch park must survive as a sibling (per-type slots).
    await executeOperation(
      db.pool,
      { type: "task_batch", items: [{ title: "a" }] },
      ctx(josctlId, "josctl", threadId),
    );
    const result = await executeOperation(
      db.pool,
      {
        type: "outcome_spec",
        title: "Plaid security review",
        directive: "own the review until done",
        criteria: ["all four findings covered"],
        budget_usd: 2,
        deadline_days: 7,
      },
      ctx(josctlId, "josctl", threadId),
    );
    expect(result.status).toBe("parked");
    expect(result.id).toMatch(/^outcome_spec:[0-9a-f]{4}$/);
    const outcomes = await db.pool.query(`SELECT count(*)::int AS n FROM outcomes`);
    expect(outcomes.rows[0].n).toBe(0); // the token lane is the only applier
    const stored = parseThreadMetadata(
      (
        await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [threadId])
      ).rows[0].metadata,
    );
    const types = (stored?.pendingProposals ?? []).map((p) => p.type).sort();
    expect(types).toEqual(["outcome_spec", "task_batch"]);
    const parked = stored?.pendingProposals?.find((p) => p.type === "outcome_spec");
    expect(proposalFromPending(parked!)).not.toBeNull(); // payload re-validates at apply
  });

  it("consent bar pins: the parked outcome_spec id is NOT envelope-resolvable (§22.6/G7)", () => {
    const id = pendingProposalId("outcome_spec", NOW.toISOString());
    expect(resolutionAllowed(id.slice(0, id.lastIndexOf(":")))).toBe(false);
    const taskId = pendingProposalId("task_batch", NOW.toISOString());
    expect(resolutionAllowed(taskId.slice(0, taskId.lastIndexOf(":")))).toBe(true);
  });
});
