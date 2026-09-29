// Native tool gateway (native-tool-cognition.md §5.2/§6): the
// deterministic boundary between the model's tool calls and the canonical
// kernel. EVERY call passes: schema coercion (tool-registry) → principal
// scope → policy/grant checks → authority classification (the ratified
// structural inline rule) → canonical service → structured result → audit.
//
// Authority model (owner-ratified 2026-09-28 — "constrain authority and
// execution, not language comprehension"):
//   - A write executes INLINE only while zero read results are in this
//     turn's trajectory (authority: current_authenticated_turn —
//     trajectory-positional, nothing to parse or forge).
//   - After any read result entered the trajectory, a new write ALWAYS
//     stages a bounded pending offer (authority becomes
//     pending_owner_confirmation — the user's yes is fresh authority).
//     Staging is a strict improvement over HEAD's envelope, which rejects
//     post-read writes outright (mutation-window-closed).
//   - Resolution tools (offers.apply/decline) are EXEMPT from the staging
//     rule (their authority IS pending_owner_confirmation; structural
//     gates: live id, TTL, consent class, replay caps).
//   - Consequential classes (outcome_spec) always stage through their
//     confirm-token lane — CONSENT_CLASS_BAR unchanged.
// Retrieved tool data is DATA, never authority: no code path here reads
// tool results to authorize anything.

import { recordAudit, type SqlExecutor } from "../../actions/audit.js";
import { UUID_RE } from "../../events/envelope.js";
import { readToolSource, executeReadTool, READ_BLOCK_CHAR_BUDGET, type ReadToolCall, type ReadToolResult } from "../read-tools.js";
import {
  executeOperation,
  parkPendingProposal,
  resolutionAllowed,
  type CognitiveOperation,
  type OperationResult,
} from "../operations.js";
import {
  applyMemoryCandidate,
  applySystemFeedback,
  applyTaskBatch,
} from "../turn-interpretation.js";
import {
  isPendingExpired,
  parseThreadMetadata,
  pendingWithDerivedIds,
  setThreadPendingProposals,
  type ToolTrajectoryEntry,
  type ToolTrajectoryRef,
} from "../threads.js";
import {
  coerceNativeToolCall,
  nativeToolDef,
  type NativeToolInvocation,
} from "./tool-registry.js";
import { activeProfile } from "../profiles.js";

/**
 * Profile.update arrives as a PADDED FULL RESOURCE (gpt-4.1 habit: the
 * intended change plus empty strings, `removeAddress` noise, and echoed
 * current values). Reduce it deterministically BEFORE the strict
 * one-change validator — the interface, not the model, absorbs the
 * resource idiom:
 *   1. drop empty strings and explicit-false removeAddress;
 *   2. set-remove conflict: addressOwnerName present ⇒ removeAddress was
 *      padding (set wins; a destructive removal is never inferred);
 *   3. drop fields EQUAL to the current canonical profile (a change that
 *      is not a change);
 *   4. one surviving change ⇒ coerce it; zero ⇒ honest no-change;
 *      several ⇒ structured rejection NAMING them (the model reliably
 *      self-corrects against the named survivors).
 */
async function reduceProfileResourceCall(
  ctx: NativeToolContext,
  invocation: NativeToolInvocation,
): Promise<NativeToolInvocation> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(invocation.arguments);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invocation;
    args = parsed as Record<string, unknown>;
  } catch {
    return invocation;
  }
  const changes: Record<string, unknown> = {};
  for (const key of ["addressOwnerName", "toneNote", "extraDirective"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) changes[key] = value.trim();
  }
  if (typeof args["brevityMaxSentences"] === "number") changes["brevityMaxSentences"] = args["brevityMaxSentences"];
  if (args["removeAddress"] === true) changes["removeAddress"] = true;
  if (changes["addressOwnerName"] !== undefined) delete changes["removeAddress"]; // rule 2

  let canonical: { ownerName: string | null; maxSentences: number | null } | null = null;
  try {
    const profile = await activeProfile(ctx.db, { principalId: ctx.principalId, surface: "imessage" });
    if (profile !== null) {
      canonical = {
        ownerName: profile.definition.address?.ownerName ?? null,
        maxSentences: profile.definition.brevity?.maxSentences ?? null,
      };
    }
  } catch {
    canonical = null; // canonical unavailable — only the deterministic drops apply
  }
  if (canonical !== null) {
    if (typeof changes["addressOwnerName"] === "string" && canonical.ownerName !== null && changes["addressOwnerName"] === canonical.ownerName) {
      delete changes["addressOwnerName"]; // rule 3 — echoed current value
    }
    if (canonical.maxSentences !== null && changes["brevityMaxSentences"] === canonical.maxSentences) {
      delete changes["brevityMaxSentences"]; // rule 3
    }
  }

  const count = Object.keys(changes).length;
  if (count === 0) {
    return { ...invocation, arguments: JSON.stringify({ noChange: true }) };
  }
  if (count > 1) {
    // Structured rejection: name the survivors so the model's retry is exact.
    return {
      ...invocation,
      arguments: JSON.stringify({ ambiguousChanges: Object.keys(changes) }),
    };
  }
  return { ...invocation, arguments: JSON.stringify(changes) };
}

/** Per-tool repeat caps (§5.5; gmail.read gets its drill-down headroom). */
const TOOL_REPEAT_CAPS: Readonly<Record<string, number>> = {
  "gmail.read": 4,
  default: 3,
};

const TOOL_RESULT_CHAR_BUDGET = READ_BLOCK_CHAR_BUDGET * 2;
const STAGED_LABEL_MAX_CHARS = 300;

export type NativeAuthority =
  | "current_authenticated_turn"
  | "pending_owner_confirmation"
  | "confirm_token"
  | "staging_required";

export interface NativeToolOutcome {
  readonly tool: string;
  readonly kind: "read" | "write" | "resolution";
  readonly status: "ok" | "staged" | "denied" | "error" | "invalid";
  readonly authority: NativeAuthority;
  /** The tool-role message content — structured, bounded, DATA-labelled. */
  readonly modelNote: string;
  /** Structured result refs for the trajectory ("open that one" fuel). */
  readonly refs: readonly ToolTrajectoryRef[];
  readonly argsDigest: string | null;
  /** True when a read result (data) entered the trajectory this call. */
  readonly closedWindow: boolean;
  /** Verifier ledger line (kind resolution|operation mirrors §22.9). */
  readonly ledger: { readonly kind: "operation" | "resolution"; readonly opType: string; readonly status: string; readonly detail?: string };
}

export interface NativeToolTurnState {
  /** Successful read results so far this turn (the inline-window gate). */
  readResultsSoFar: number;
  /** Write tool calls so far this turn (blast-radius cap). */
  writeCount: number;
  /** Per-tool invocation counts (repeat caps). */
  readonly perTool: Map<string, number>;
  /** Resolution ids already resolved this turn (replay guard). */
  readonly resolvedIds: Set<string>;
}

export function newNativeToolTurnState(): NativeToolTurnState {
  return { readResultsSoFar: 0, writeCount: 0, perTool: new Map(), resolvedIds: new Set() };
}

export interface NativeToolContext {
  readonly db: SqlExecutor;
  readonly principalId: string;
  readonly principalName: string;
  readonly threadId: string;
  readonly now: () => Date;
  /** policy.reads sources allowed for this principal (fail-closed gate). */
  readonly policyReads: readonly string[];
  /** Eval-only seam: scripted read results by tool name (never affects writes). */
  readonly readOverrides?: { take: (tool: string) => { readonly result: unknown } | null };
  /** Eval-only seam: typed observation of every gateway execution. */
  readonly onToolCall?: (outcome: NativeToolOutcome) => void;
}

function audit(db: SqlExecutor, action: string, outputs: Record<string, unknown>): Promise<void> {
  return recordAudit(db, {
    actor: "system:native-gateway",
    action,
    reversible: true,
    outputsRef: JSON.stringify(outputs),
  });
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function argsDigestOf(invocation: NativeToolInvocation): string | null {
  const args = (() => {
    try {
      return JSON.parse(invocation.arguments) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  if (args === null) return null;
  const parts: string[] = [];
  for (const key of ["selector", "query", "message_id", "ref", "title", "verb", "id"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) parts.push(`${key}=${value.replace(/\|/g, "/")}`);
  }
  if (Array.isArray(args["items"])) parts.push(`items=${args["items"].length}`);
  return parts.length > 0 ? clip(parts.join("|"), 120) : null;
}

/** Extract structured result refs from a read payload (A4: the model's
 *  "open that one" fuel — the tool's own ids, never interpretation). */
function refsOfRead(result: ReadToolResult): ToolTrajectoryRef[] {
  const refs: ToolTrajectoryRef[] = [];
  const data = result.data as Record<string, unknown> | null;
  if (data !== null && typeof data === "object") {
    if (result.tool === "gmail.search" && Array.isArray(data["matches"])) {
      for (const match of data["matches"] as readonly unknown[]) {
        if (refs.length >= 8) break;
        if (typeof match !== "object" || match === null) continue;
        const row = match as Record<string, unknown>;
        if (typeof row["messageId"] !== "string" || row["messageId"].length === 0) continue;
        const label = [row["from"], row["subject"]].filter((v): v is string => typeof v === "string").join(" — ");
        refs.push({ ref: clip(row["messageId"], 64), label: clip(label || row["messageId"], 120) });
      }
    }
    if (result.tool === "gmail.read" && typeof data["messageId"] === "string") {
      const label = [data["from"], data["subject"]].filter((v): v is string => typeof v === "string").join(" — ");
      refs.push({ ref: clip(data["messageId"], 64), label: clip(label || String(data["messageId"]), 120) });
    }
    if (result.tool === "work.status" && typeof data["ref"] === "string") {
      refs.push({ ref: clip(data["ref"], 64), label: clip(String(data["title"] ?? data["ref"]), 120) });
    }
  }
  return refs.slice(0, 8);
}

function outcome(
  ctx: NativeToolContext,
  invocation: NativeToolInvocation,
  kind: "read" | "write" | "resolution",
  base: Omit<NativeToolOutcome, "tool" | "kind" | "refs" | "argsDigest" | "closedWindow">,
  extras: { refs?: ToolTrajectoryRef[]; argsDigest?: string | null; closedWindow?: boolean } = {},
): NativeToolOutcome {
  const full: NativeToolOutcome = {
    tool: invocation.name,
    kind,
    refs: extras.refs ?? [],
    argsDigest: extras.argsDigest === undefined ? argsDigestOf(invocation) : extras.argsDigest,
    closedWindow: extras.closedWindow ?? false,
    ...base,
  };
  void ctx;
  // Per-call audit (§6.5): tool + kind + authority + status only — never
  // message content. Best-effort: an audit failure never blocks the result.
  void audit(ctx.db, "native.tool_call", {
    tool: full.tool,
    kind: full.kind,
    status: full.status,
    authority: full.authority,
    principalId: ctx.principalId,
  }).catch(() => {});
  try {
    ctx.onToolCall?.(full);
  } catch {
    // observation is best-effort
  }
  return full;
}

/** The staged-offer label shown in PENDING OFFERS next turn (bounded). */
function stagedLabel(tool: string, argsDigest: string | null): string {
  return clip(`${tool}${argsDigest !== null ? ` ${argsDigest}` : ""} — awaiting the user's yes`, STAGED_LABEL_MAX_CHARS);
}

/**
 * Execute ONE native tool call through the full deterministic boundary.
 * Never throws — every terminal path returns a structured outcome the
 * driver appends as a tool message.
 */
export async function executeNativeTool(
  ctx: NativeToolContext,
  state: NativeToolTurnState,
  invocation: NativeToolInvocation,
): Promise<NativeToolOutcome> {
  if (!UUID_RE.test(ctx.principalId)) {
    return outcome(ctx, invocation, "read", {
      status: "denied", authority: "current_authenticated_turn",
      modelNote: "denied: invalid principal", ledger: { kind: "operation", opType: invocation.name, status: "rejected", detail: "invalid-principal" },
    });
  }
  const def = nativeToolDef(invocation.name);
  if (def === null) {
    return outcome(ctx, invocation, "read", {
      status: "invalid", authority: "current_authenticated_turn",
      modelNote: `invalid: unknown tool "${clip(invocation.name, 64)}" — use only the provided tools`,
      ledger: { kind: "operation", opType: invocation.name, status: "rejected", detail: "unknown-tool" },
    });
  }
  const repeatCap = TOOL_REPEAT_CAPS[invocation.name] ?? TOOL_REPEAT_CAPS["default"]!;
  const repeats = state.perTool.get(invocation.name) ?? 0;
  if (repeats >= repeatCap) {
    return outcome(ctx, invocation, def.kind, {
      status: "denied", authority: def.kind === "resolution" ? "pending_owner_confirmation" : "current_authenticated_turn",
      modelNote: `denied: tool cap — you have already called ${invocation.name} ${repeats}× this turn; answer from the evidence you have`,
      ledger: { kind: "operation", opType: invocation.name, status: "rejected", detail: "tool-cap" },
    });
  }
  state.perTool.set(invocation.name, repeats + 1);

  let effectiveInvocation = invocation;
  if (invocation.name === "profile.update") {
    const reduced = await reduceProfileResourceCall(ctx, invocation);
    const reducedArgs = (() => {
      try {
        return JSON.parse(reduced.arguments) as Record<string, unknown>;
      } catch {
        return null;
      }
    })();
    if (reducedArgs !== null && reducedArgs["noChange"] === true) {
      return outcome(ctx, invocation, "write", {
        status: "ok", authority: "current_authenticated_turn",
        modelNote: "no change — the profile already says that; answer the user plainly",
        ledger: { kind: "operation", opType: "profile_update", status: "applied", detail: "no-change (already current)" },
      }, { argsDigest: null });
    }
    if (reducedArgs !== null && Array.isArray(reducedArgs["ambiguousChanges"])) {
      // Several REAL changes in one call — the resource idiom applied
      // literally. Profile fields are low-risk, reversible, and grounded
      // in the current turn's instruction: execute them as sequential
      // single-change ops (each through the same strict validator), one
      // user-facing action.
      const changes = reducedArgs["ambiguousChanges"] as string[];
      const canonicalArgs = argsDigestOf(invocation);
      const results: string[] = [];
      let applied = 0;
      for (const key of changes) {
        const single: NativeToolInvocation = {
          id: `${invocation.id}-${key}`,
          name: "profile.update",
          arguments: JSON.stringify({ [key]: (() => {
            try {
              return JSON.parse(invocation.arguments)[key];
            } catch {
              return undefined;
            }
          })() }),
        };
        const op = coerceNativeToolCall(single);
        if (op === null || op.kind !== "write") {
          results.push(`${key}: rejected`);
          continue;
        }
        const r = await executeOperation(ctx.db, op.op, {
          principalId: ctx.principalId,
          principalName: ctx.principalName,
          threadId: ctx.threadId,
          now: ctx.now(),
          calendarPolicy: null,
        });
        results.push(`${key}: ${r.status}`);
        if (r.status === "applied") applied += 1;
      }
      const okAll = applied === changes.length && applied > 0;
      return outcome(ctx, invocation, "write", {
        status: okAll ? "ok" : applied > 0 ? "staged" : "error",
        authority: "current_authenticated_turn",
        modelNote: `OPERATION RESULT profile_update: ${applied}/${changes.length} applied — ${results.join("; ")}`,
        ledger: {
          kind: "operation", opType: "profile_update",
          status: okAll ? "applied" : applied > 0 ? "queued" : "failed",
          detail: results.join("; ").slice(0, 200),
        },
      }, { argsDigest: canonicalArgs });
    }
    effectiveInvocation = reduced;
  }
  const coerced = coerceNativeToolCall(effectiveInvocation);
  if (coerced === null) {
    return outcome(ctx, invocation, def.kind, {
      status: "invalid", authority: "current_authenticated_turn",
      modelNote: `invalid: ${invocation.name} arguments failed the schema — re-read the tool's parameter shape and retry once with corrected arguments`,
      ledger: { kind: "operation", opType: invocation.name, status: "rejected", detail: "schema-invalid" },
    });
  }

  if (coerced.kind === "read") return executeNativeRead(ctx, state, invocation, coerced.read);
  if (coerced.kind === "resolution") return executeNativeResolution(ctx, state, invocation, coerced.id, coerced.action);
  return executeNativeWrite(ctx, state, invocation, coerced.op);
}

// ------------------------------------------------------------------ reads

async function executeNativeRead(
  ctx: NativeToolContext,
  state: NativeToolTurnState,
  invocation: NativeToolInvocation,
  read: ReadToolCall,
): Promise<NativeToolOutcome> {
  const source = readToolSource(read.tool);
  if (!ctx.policyReads.includes(source)) {
    return outcome(ctx, invocation, "read", {
      status: "denied", authority: "current_authenticated_turn",
      modelNote: `denied by policy for this chat: the ${source} source is not enabled — answer honestly that you cannot check it`,
      ledger: { kind: "operation", opType: read.tool, status: "rejected", detail: "policy-denied" },
    });
  }
  const override = ctx.readOverrides?.take(read.tool) ?? null;
  let result: ReadToolResult;
  if (override !== null) {
    result = {
      tool: read.tool,
      source,
      coverage: "scripted (eval)",
      data: override.result,
    };
  } else {
    try {
      result = await executeReadTool(ctx.db, read, {
        now: ctx.now,
        principalId: ctx.principalId,
        queryText: undefined,
        policyReads: ctx.policyReads,
      });
    } catch (err) {
      // FAILED reads do NOT close the inline window (no data entered).
      return outcome(ctx, invocation, "read", {
        status: "error", authority: "current_authenticated_turn",
        modelNote: `error: ${read.tool} failed (${err instanceof Error ? err.name : "unknown"}) — answer with the coverage gap honestly`,
        ledger: { kind: "operation", opType: read.tool, status: "failed", detail: "read-failed" },
      }, { closedWindow: false, argsDigest: null });
    }
  }
  const serialized = JSON.stringify(result.data);
  const bounded = clip(serialized, TOOL_RESULT_CHAR_BUDGET);
  state.readResultsSoFar += 1;
  return outcome(ctx, invocation, "read", {
    status: "ok", authority: "current_authenticated_turn",
    modelNote: `[tool ${result.tool} | coverage: ${result.coverage}] ${bounded}`,
    ledger: { kind: "operation", opType: read.tool, status: "applied", detail: "read-ok" },
  }, { refs: refsOfRead(result), closedWindow: true, argsDigest: null });
}

// ----------------------------------------------------------------- writes

const INLINE_ELIGIBLE: ReadonlySet<string> = new Set([
  "commitment_transition",
  "reminder_create",
  "profile_update",
]);

async function executeNativeWrite(
  ctx: NativeToolContext,
  state: NativeToolTurnState,
  invocation: NativeToolInvocation,
  op: CognitiveOperation,
): Promise<NativeToolOutcome> {
  if (state.writeCount >= 4) {
    return outcome(ctx, invocation, "write", {
      status: "denied", authority: "staging_required",
      modelNote: "denied: write cap — at most 4 write actions per turn; finish with what you have",
      ledger: { kind: "operation", opType: op.type, status: "rejected", detail: "write-cap" },
    });
  }
  state.writeCount += 1;

  // Consequential classes stage through their OWN lanes inside
  // executeOperation (outcome_spec → confirm token; task_batch → offer).
  // Everything else obeys the ratified structural inline rule.
  const inlineEligible = INLINE_ELIGIBLE.has(op.type);
  const postRead = state.readResultsSoFar > 0;
  if (inlineEligible && postRead) {
    // STAGE — never a silent write after retrieved data entered the turn.
    const payload = { type: "native_write" as const, op };
    const result = await parkPendingProposal(ctx.db, {
      principalId: ctx.principalId,
      principalName: ctx.principalName,
      threadId: ctx.threadId,
      now: ctx.now(),
    }, "native_write", payload, stagedLabel(invocation.name, argsDigestOf(invocation)));
    return outcome(ctx, invocation, "write", {
      status: "staged", authority: "pending_owner_confirmation",
      modelNote: `${result.status}${result.id !== undefined ? ` (${result.id})` : ""}: ${result.detail ?? ""} — staged, NOT executed: your target selection used data retrieved this turn, so the user must confirm. Tell them exactly what is staged and ask for a yes.`,
      ledger: { kind: "operation", opType: op.type, status: "parked", detail: result.detail ?? "staged-post-read" },
    });
  }
  const result: OperationResult = await executeOperation(ctx.db, op, {
    principalId: ctx.principalId,
    principalName: ctx.principalName,
    threadId: ctx.threadId,
    now: ctx.now(),
    calendarPolicy: null,
  });
  return outcome(ctx, invocation, "write", {
    status: result.status === "applied" ? "ok" : result.status === "parked" || result.status === "queued" ? "staged" : "error",
    authority: result.status === "parked" || result.status === "queued" ? "pending_owner_confirmation" : "current_authenticated_turn",
    modelNote: `OPERATION RESULT ${op.type}: ${result.status}${result.id !== undefined ? ` (${result.id})` : ""}${result.detail !== undefined ? ` — ${result.detail}` : ""}`,
    ledger: { kind: "operation", opType: op.type, status: result.status, detail: result.detail },
  });
}

// ------------------------------------------------------------ resolutions

async function executeNativeResolution(
  ctx: NativeToolContext,
  state: NativeToolTurnState,
  invocation: NativeToolInvocation,
  id: string,
  action: "apply" | "decline",
): Promise<NativeToolOutcome> {
  // Replay guard: ≤1 resolution per pending id per turn (A1/turn-12 gate).
  if (state.resolvedIds.has(id)) {
    return outcome(ctx, invocation, "resolution", {
      status: "denied", authority: "pending_owner_confirmation",
      modelNote: `denied: offer ${id} was already resolved this turn`,
      ledger: { kind: "resolution", opType: id, status: "rejected", detail: "already-resolved" },
    });
  }
  state.resolvedIds.add(id);
  const meta = await ctx.db.query("SELECT metadata FROM interaction_threads WHERE id = $1::uuid", [ctx.threadId]);
  const derived = pendingWithDerivedIds(parseThreadMetadata(meta.rows[0]?.metadata ?? null));
  const entries = derived?.pendingProposals ?? [];
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    return outcome(ctx, invocation, "resolution", {
      status: "error", authority: "pending_owner_confirmation",
      modelNote: `no such pending offer: ${id} — check the PENDING OFFERS ids in your context`,
      ledger: { kind: "resolution", opType: id, status: "rejected", detail: "unknown-id" },
    });
  }
  if (entry.expiresAt !== undefined && isPendingExpired(entry, ctx.now())) {
    return outcome(ctx, invocation, "resolution", {
      status: "error", authority: "pending_owner_confirmation",
      modelNote: `offer ${id} expired — be honest that it can no longer be applied`,
      ledger: { kind: "resolution", opType: entry.type, status: "rejected", detail: "expired" },
    });
  }
  if (action === "decline") {
    const survivors = entries.filter((candidate) => candidate.id !== id);
    await setThreadPendingProposals(ctx.db, {
      threadId: ctx.threadId,
      principalId: ctx.principalId,
      pending: survivors.length > 0 ? survivors : null,
      now: ctx.now(),
    });
    return outcome(ctx, invocation, "resolution", {
      status: "ok", authority: "pending_owner_confirmation",
      modelNote: `offer ${id} (${entry.type}) dropped — it will not be applied`,
      ledger: { kind: "resolution", opType: entry.type, status: "applied", detail: "declined" },
    });
  }
  if (!resolutionAllowed(entry.type)) {
    return outcome(ctx, invocation, "resolution", {
      status: "denied", authority: "confirm_token",
      modelNote: `rejected: ${entry.type} resolves ONLY through its confirm token — ask the user to send the token they were given`,
      ledger: { kind: "resolution", opType: entry.type, status: "rejected", detail: "consent-class" },
    });
  }
  let result: OperationResult;
  if (entry.type === "task_batch") {
    const applied = await applyTaskBatch(ctx.db, {
      proposal: (entry as { payload: unknown }).payload,
      principalId: ctx.principalId,
      now: ctx.now(),
    });
    result = { status: applied.applied ? "applied" : "failed", detail: applied.applied ? `${applied.commitmentIds.length} to-do(s) created` : applied.reply };
  } else if (entry.type === "system_feedback") {
    const applied = await applySystemFeedback(ctx.db, {
      proposal: (entry as { payload: unknown }).payload,
      principalId: ctx.principalId,
      now: ctx.now(),
    });
    result = { status: applied.applied ? "applied" : "failed", detail: applied.reply };
  } else if (entry.type === "memory_candidate") {
    const applied = await applyMemoryCandidate(ctx.db, {
      proposal: (entry as { payload: unknown }).payload,
      principalId: ctx.principalId,
      now: ctx.now(),
    });
    result = { status: applied.applied ? "applied" : "failed", detail: applied.reply };
  } else if (entry.type === "native_write") {
    const payload = (entry as { payload: { op: CognitiveOperation } }).payload;
    result = await executeOperation(ctx.db, payload.op, {
      principalId: ctx.principalId,
      principalName: ctx.principalName,
      threadId: ctx.threadId,
      now: ctx.now(),
    });
  } else {
    result = { status: "rejected", detail: `unsupported resolution type ${entry.type}` };
  }
  if (result.status === "applied") {
    const survivors = entries.filter((candidate) => candidate.id !== id);
    await setThreadPendingProposals(ctx.db, {
      threadId: ctx.threadId,
      principalId: ctx.principalId,
      pending: survivors.length > 0 ? survivors : null,
      now: ctx.now(),
    });
  }
  return outcome(ctx, invocation, "resolution", {
    status: result.status === "applied" ? "ok" : result.status === "failed" ? "error" : "staged",
    authority: "pending_owner_confirmation",
    modelNote: `offer ${id} (${entry.type}) → ${result.status}${result.detail !== undefined ? ` — ${result.detail}` : ""}`,
    ledger: { kind: "resolution", opType: entry.type, status: result.status, detail: result.detail },
  });
}

/** Trajectory entry for one gateway outcome (§8.2 persistence). */
export function trajectoryEntryOf(outcome: NativeToolOutcome): ToolTrajectoryEntry {
  const entry: ToolTrajectoryEntry = {
    tool: outcome.tool,
    kind: outcome.kind,
    status: outcome.status,
    summary: clip(outcome.modelNote.replace(/\s+/g, " "), 200),
    ...(outcome.argsDigest !== null ? { argsDigest: outcome.argsDigest } : {}),
    ...(outcome.refs.length > 0 ? { refs: [...outcome.refs] } : {}),
  };
  return entry;
}
