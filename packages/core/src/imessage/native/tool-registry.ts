// Native tool registry (native-tool-cognition.md §5.4/§9, spike set W1):
// the 11 schema-validated surfaces over the EXISTING canonical services.
//
//   reads        → wrap read-tools.ts unchanged (executeReadTool)
//   writes       → wrap operations.ts executors unchanged (executeOperation
//                  via parseCognitiveOperation — the SAME structural
//                  validator the envelope used; no new validation dialect)
//   resolutions  → offers.apply / offers.decline over the shared pending
//                  slots (authority: pending_owner_confirmation)
//
// Selector-first ergonomics (human words, not UUIDs); the ambiguity
// contract is target-selector's 0/1/N contract returned as structured
// data. This module owns NAME→SHAPE coercion only — authority
// classification and execution live in tool-gateway.ts.

import {
  parseCognitiveOperation,
  PENDING_PROPOSAL_ID_RE,
  type CognitiveOperation,
} from "../operations.js";
import { parseRouteJson, type ReadToolCall } from "../read-tools.js";

export type NativeToolKind = "read" | "write" | "resolution";

export interface NativeToolDef {
  readonly name: string;
  readonly kind: NativeToolKind;
  /** Model-facing description (the catalog line). */
  readonly description: string;
  /** JSON-schema parameters (provider surface; the gateway re-validates). */
  readonly parameters: Record<string, unknown>;
}

/** A tool call as it arrives from the provider. */
export interface NativeToolInvocation {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** The spike set — wave W1 (plan §9; ratified 2026-09-28). */
export const NATIVE_TOOLS: readonly NativeToolDef[] = [
  {
    name: "commitments.list",
    kind: "read",
    description:
      "List the user's open to-dos/commitments — overdue, due soon, and undated open items with titles. Use for any 'what's on my list' question.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "gmail.search",
    kind: "read",
    description:
      "Keyword search over the user's Gmail (subject, sender, body), last 7 days. Pass a short keyword phrase, not a sentence. Returns messageIds for gmail.read.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 120 },
        max_age_days: { type: "integer", minimum: 1, maximum: 7 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail.read",
    kind: "read",
    description:
      "Read one Gmail message by messageId (from a gmail.search result). Use to open 'that one' after a search.",
    parameters: {
      type: "object",
      properties: { message_id: { type: "string", maxLength: 200 } },
      required: ["message_id"],
      additionalProperties: false,
    },
  },
  {
    name: "work.status",
    kind: "read",
    description:
      "Canonical delegated-work state — what research/outcomes exist and their status. The ONLY source for 'how is that going'. Optional ref for one outcome's detail.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string", maxLength: 8 } },
      additionalProperties: false,
    },
  },
  {
    name: "commitments.transition",
    kind: "write",
    description:
      "Mark one of the user's open to-dos done / missed / renegotiated. selector = the user's own words naming it ('seating chart'); ambiguous matches are refused with candidates, never guessed.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", maxLength: 200 },
        verb: { type: "string", enum: ["done", "missed", "renegotiated"] },
        note: { type: "string", maxLength: 120 },
      },
      required: ["selector", "verb"],
      additionalProperties: false,
    },
  },
  {
    name: "commitments.create",
    kind: "write",
    description:
      "Capture one or more new to-dos (items with optional due words like 'by wednesday'). Multiple items stage as one offer the user confirms with a yes.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              title: { type: "string", maxLength: 200 },
              due: { type: "string", maxLength: 60 },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "reminders.create",
    kind: "write",
    description:
      "Create a time-based reminder ('remind me to X'). Pass whenWords (the user's time words verbatim) and/or a concrete dueDate/dueTime you can derive. Fuzzy times are definite — pick the concrete time.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 200 },
        whenWords: { type: "string", maxLength: 40 },
        dueDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        dueTime: {
          type: "object",
          properties: { hour: { type: "integer", minimum: 0, maximum: 23 }, minute: { type: "integer", minimum: 0, maximum: 59 } },
          required: ["hour", "minute"],
          additionalProperties: false,
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "profile.update",
    kind: "write",
    description:
      "Update how you address/talk to the user: exactly ONE change — addressOwnerName, removeAddress, toneNote, brevityMaxSentences (1-10), or extraDirective. These are changes, not chat.",
    parameters: {
      type: "object",
      properties: {
        addressOwnerName: { type: "string", maxLength: 60 },
        removeAddress: { type: "boolean" },
        toneNote: { type: "string", maxLength: 120 },
        brevityMaxSentences: { type: "integer", minimum: 1, maximum: 10 },
        extraDirective: { type: "string", maxLength: 120 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "outcomes.delegate",
    kind: "write",
    description:
      "Delegate durable work to a worker (research/projects). Stages an offer with a confirm token — the work does NOT start until the user confirms. Never say work is running before that.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 200 },
        directive: { type: "string", maxLength: 1000 },
        criteria: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", maxLength: 200 } },
        budget_usd: { type: "number", minimum: 0, maximum: 50 },
        deadline_days: { type: "integer", minimum: 1, maximum: 90 },
      },
      required: ["title", "criteria"],
      additionalProperties: false,
    },
  },
  {
    name: "offers.apply",
    kind: "resolution",
    description:
      "Apply one of your pending offers (from PENDING OFFERS) when the user's CURRENT message confirms it ('yes do that'). Id format: <type>:<4hex>.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", pattern: "^[a-z_]+:[0-9a-f]{4}$" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "offers.decline",
    kind: "resolution",
    description: "Drop one of your pending offers when the user's CURRENT message declines it.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", pattern: "^[a-z_]+:[0-9a-f]{4}$" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

const NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set(NATIVE_TOOLS.map((t) => t.name));

export function isNativeTool(name: string): boolean {
  return NATIVE_TOOL_NAMES.has(name);
}

export function nativeToolDef(name: string): NativeToolDef | null {
  return NATIVE_TOOLS.find((tool) => tool.name === name) ?? null;
}

/** Provider tool surface (JSON schema per tool). */
export function nativeToolSchemas(): readonly { name: string; description: string; parameters: Record<string, unknown> }[] {
  return NATIVE_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export type CoercedNativeToolCall =
  | { readonly kind: "read"; readonly read: ReadToolCall }
  | { readonly kind: "write"; readonly op: CognitiveOperation }
  | { readonly kind: "resolution"; readonly id: string; readonly action: "apply" | "decline" };

function argsObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Coerce a provider tool call onto the EXISTING validated shapes. The
 * heavy lifting reuses the envelope's own strict validators
 * (parseRouteJson / parseCognitiveOperation) — the native surface adds
 * ergonomics (selector keys, items arrays), never a second validation
 * dialect. Null on any structural deviation (fail-closed, reported to the
 * model as an invalid-call result).
 */
export function coerceNativeToolCall(invocation: NativeToolInvocation): CoercedNativeToolCall | null {
  const args = argsObject(invocation.arguments);
  if (args === null) return null;
  switch (invocation.name) {
    case "commitments.list":
      return Object.keys(args).length === 0 ? { kind: "read", read: { tool: "commitments.waiting" } } : null;
    case "gmail.search": {
      const call = parseRouteJson(JSON.stringify({ tool: "gmail.search", ...args }));
      return call !== null && call.tool === "gmail.search" ? { kind: "read", read: call } : null;
    }
    case "gmail.read": {
      const call = parseRouteJson(JSON.stringify({ tool: "gmail.read", ...args }));
      return call !== null && call.tool === "gmail.read" ? { kind: "read", read: call } : null;
    }
    case "work.status": {
      const call = parseRouteJson(JSON.stringify({ tool: "work.status", ...args }));
      return call !== null && call.tool === "work.status" ? { kind: "read", read: call } : null;
    }
    case "commitments.transition": {
      const op = parseCognitiveOperation({
        type: "commitment_transition",
        target: { text: args["selector"] },
        verb: args["verb"],
        note: args["note"] ?? null,
      });
      return op !== null && op.type === "commitment_transition" ? { kind: "write", op } : null;
    }
    case "commitments.create": {
      const items = args["items"];
      const op = parseCognitiveOperation({ type: "task_batch", items });
      return op !== null && op.type === "task_batch" ? { kind: "write", op } : null;
    }
    case "reminders.create": {
      const op = parseCognitiveOperation({
        type: "reminder_create",
        title: args["title"],
        dueDate: args["dueDate"] ?? null,
        dueTime: args["dueTime"] ?? null,
        whenWords: args["whenWords"] ?? null,
      });
      return op !== null && op.type === "reminder_create" ? { kind: "write", op } : null;
    }
    case "profile.update": {
      const op = parseCognitiveOperation({ type: "profile_update", ...args });
      return op !== null && op.type === "profile_update" ? { kind: "write", op } : null;
    }
    case "outcomes.delegate": {
      const op = parseCognitiveOperation({
        type: "outcome_spec",
        title: args["title"],
        directive: args["directive"] ?? "",
        criteria: args["criteria"],
        budget_usd: args["budget_usd"] ?? null,
        deadline_days: args["deadline_days"] ?? null,
      });
      return op !== null && op.type === "outcome_spec" ? { kind: "write", op } : null;
    }
    case "offers.apply":
    case "offers.decline": {
      const id = args["id"];
      if (typeof id !== "string" || !PENDING_PROPOSAL_ID_RE.test(id)) return null;
      return {
        kind: "resolution",
        id,
        action: invocation.name === "offers.apply" ? "apply" : "decline",
      };
    }
    default:
      return null;
  }
}
