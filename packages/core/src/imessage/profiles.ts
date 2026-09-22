// W4 — versioned interaction profiles (jarvis-v1.md §7 W4 rev2 R2; §5
// invariant 2). A profile is PRESENTATION ONLY: register, brevity caps,
// explanation order, address terms, bounded extra directives. It can never
// alter reads, tools, budgets, egress, or authorization — the rendered
// fragment is structurally pinned against authorization vocabulary
// (PERSONA_FRAGMENT_FORBIDDEN_WORDS, substring-checked, fail-closed throw),
// and policy.yaml's `personas:` section holds only the on/off flag + the
// principal allowlist. No prompt text lives in policy.
//
// Versioning is append-only (migration 018 storage trigger rejects UPDATE
// and DELETE): the active version of a (principal, surface) is
// max(version) via the interaction_profiles_active view.
//
// Thread-scoped overrides ("be brief") live in interaction_threads.metadata
// .profile_override and expire with the thread — they never touch the
// profile. Persistent self-configuration ("always call me Chief") parses
// to a definitionDelta for the orchestrator's propose→confirm flow; the
// confirmed application is a NEW version row (nextProfileVersion), audited
// upstream, and a principal can only ever write their own rows (repository
// scoping + the storage guard).

import { randomUUID } from "node:crypto";
import type { QueryExecutor } from "../queries/executor.js";
import { redactContent } from "./redact.js";
import { parseThreadMetadata } from "./threads.js";
import type { ThreadProfileOverride } from "./threads.js";
// ---------------------------------------------------------------------------
// Strict schema (fail-closed parser — any deviation is null, never a guess)
// ---------------------------------------------------------------------------

export type ProfileExplanationStyle = "lead_with_answer" | "lead_with_context";

/**
 * W6(a)/R11 — persona is BEHAVIOR policy, not just voice. Presentation-only
 * switches the deterministic offer layer consults; they cannot alter reads,
 * tools, budgets, egress, or authorization (§5 invariant 2 — same ceiling as
 * every other definition field). Strict booleans; absent = true (the
 * attentive default), unknown keys fail the whole definition closed.
 */
export interface ProfileBehaviors {
  readonly detectTasks?: boolean;
  readonly proposeCapture?: boolean;
  readonly convertDirectives?: boolean;
  readonly surfaceDeadlines?: boolean;
  readonly preferNextAction?: boolean;
}

/** All-true resolution of a definition's behaviors (defaults when absent). */
export function resolveProfileBehaviors(
  definition: Pick<ProfileDefinition, "behaviors">,
): Required<ProfileBehaviors> {
  const b = definition.behaviors ?? {};
  return {
    detectTasks: b.detectTasks ?? true,
    proposeCapture: b.proposeCapture ?? true,
    convertDirectives: b.convertDirectives ?? true,
    surfaceDeadlines: b.surfaceDeadlines ?? true,
    preferNextAction: b.preferNextAction ?? true,
  };
}

export interface ProfileBrevity {
  readonly maxSentences: number;
  readonly maxChars: number;
}

export interface ProfileAddress {
  readonly ownerName?: string;
}

export interface ProfileDefinition {
  /** One-line voice descriptor (e.g. "terse, serious, judgment-forward"). */
  readonly register: string;
  readonly brevity: ProfileBrevity;
  readonly explanation: ProfileExplanationStyle;
  readonly address: ProfileAddress;
  readonly extraDirectives?: readonly string[];
  /** W6(a) behavior flags — all default true when absent. */
  readonly behaviors?: ProfileBehaviors;
}

/** Schema ceilings — the parser, the merge clamps, and the deltas all share these. */
export const PROFILE_REGISTER_MAX_CHARS = 200;
export const PROFILE_BREVITY_MAX_SENTENCES = 20;
export const PROFILE_BREVITY_MAX_CHARS = 4000;
export const PROFILE_OWNER_NAME_MAX_CHARS = 60;
export const PROFILE_EXTRA_DIRECTIVES_MAX = 5;
export const PROFILE_EXTRA_DIRECTIVE_MAX_CHARS = 120;

const EXPLANATION_STYLES: ReadonlySet<string> = new Set([
  "lead_with_answer",
  "lead_with_context",
]);

function oneLine(text: string, maxChars: number): string | null {
  if (text.includes("\n")) return null;
  const trimmed = redactContent(text.trim());
  if (trimmed.length === 0 || trimmed.length > maxChars) return null;
  return trimmed;
}

function parseIntInRange(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function exactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) return false;
  }
  return true;
}

/**
 * STRICT parser for stored/seeded profile definitions. Fail-closed: any
 * structural deviation — unknown keys, missing required fields, non-integer
 * or out-of-ceiling numbers, multi-line text, over-cap extras — returns
 * null. Callers treat null as "no profile" (inert), never as a guess.
 */
export function parseProfileDefinition(value: unknown): ProfileDefinition | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (
    !exactKeys(obj, [
      "register",
      "brevity",
      "explanation",
      "address",
      "extraDirectives",
      "behaviors",
    ])
  ) {
    return null;
  }
  if (typeof obj.register !== "string") return null;
  const register = oneLine(obj.register, PROFILE_REGISTER_MAX_CHARS);
  if (register === null) return null;

  if (typeof obj.brevity !== "object" || obj.brevity === null || Array.isArray(obj.brevity)) {
    return null;
  }
  const brevity = obj.brevity as Record<string, unknown>;
  if (!exactKeys(brevity, ["maxSentences", "maxChars"])) return null;
  const maxSentences = parseIntInRange(brevity.maxSentences, 1, PROFILE_BREVITY_MAX_SENTENCES);
  const maxChars = parseIntInRange(brevity.maxChars, 1, PROFILE_BREVITY_MAX_CHARS);
  if (maxSentences === null || maxChars === null) return null;

  if (typeof obj.explanation !== "string" || !EXPLANATION_STYLES.has(obj.explanation)) {
    return null;
  }
  const explanation = obj.explanation as ProfileExplanationStyle;

  let address: ProfileAddress = {};
  if (obj.address !== undefined) {
    if (typeof obj.address !== "object" || obj.address === null || Array.isArray(obj.address)) {
      return null;
    }
    const raw = obj.address as Record<string, unknown>;
    if (!exactKeys(raw, ["ownerName"])) return null;
    if (raw.ownerName !== undefined) {
      if (typeof raw.ownerName !== "string") return null;
      const ownerName = oneLine(raw.ownerName, PROFILE_OWNER_NAME_MAX_CHARS);
      if (ownerName === null) return null;
      address = { ownerName };
    }
  }

  let extraDirectives: string[] | undefined;
  if (obj.extraDirectives !== undefined) {
    if (!Array.isArray(obj.extraDirectives)) return null;
    if (obj.extraDirectives.length > PROFILE_EXTRA_DIRECTIVES_MAX) return null;
    const parsed: string[] = [];
    for (const item of obj.extraDirectives) {
      if (typeof item !== "string") return null;
      const line = oneLine(item, PROFILE_EXTRA_DIRECTIVE_MAX_CHARS);
      if (line === null) return null;
      parsed.push(line);
    }
    extraDirectives = parsed;
  }

  let behaviors: ProfileBehaviors | undefined;
  if (obj.behaviors !== undefined) {
    if (typeof obj.behaviors !== "object" || obj.behaviors === null || Array.isArray(obj.behaviors)) {
      return null;
    }
    const raw = obj.behaviors as Record<string, unknown>;
    if (
      !exactKeys(raw, [
        "detectTasks",
        "proposeCapture",
        "convertDirectives",
        "surfaceDeadlines",
        "preferNextAction",
      ])
    ) {
      return null;
    }
    const flags: { detectTasks?: boolean; proposeCapture?: boolean; convertDirectives?: boolean; surfaceDeadlines?: boolean; preferNextAction?: boolean } =
      {};
    let carried = false;
    for (const [key, flag] of Object.entries(raw)) {
      if (flag !== undefined) {
        if (typeof flag !== "boolean") return null;
        flags[key as "detectTasks"] = flag;
        carried = true;
      }
    }
    behaviors = carried ? flags : {};
  }

  return {
    register,
    brevity: { maxSentences, maxChars },
    explanation,
    address,
    ...(extraDirectives !== undefined && extraDirectives.length > 0 ? { extraDirectives } : {}),
    ...(behaviors !== undefined ? { behaviors } : {}),
  };
}

/**
 * The initial josctl chief-of-staff profile (owner direction 2026-09-21:
 * terse, serious, judgment-forward, low-filler; he tunes through use).
 * Activation is gated on the one-time owner approval (jarvis-v1.md §18-2)
 * plus the `personas:` policy flag — the constant itself is inert data.
 */
export const JOSCTL_PROFILE_DEFINITION: ProfileDefinition = {
  register: "chief of staff: terse, serious, judgment-forward, no filler",
  brevity: { maxSentences: 4, maxChars: 500 },
  explanation: "lead_with_answer",
  address: { ownerName: "Chief" },
  extraDirectives: [
    "State what you cannot see rather than papering over it.",
    "Lead with the judgment, then the smallest sufficient support.",
  ],
  // R11 — the chief-of-staff behaviors are ON: detect tasks, propose
  // capture, convert directives, surface deadlines, prefer next action.
  behaviors: {
    detectTasks: true,
    proposeCapture: true,
    convertDirectives: true,
    surfaceDeadlines: true,
    preferNextAction: true,
  },
};

// ---------------------------------------------------------------------------
// Fragment rendering (deterministic, structurally pinned)
// ---------------------------------------------------------------------------

/**
 * The persona fragment can NEVER carry authorization vocabulary — the
 * profile is presentation only (§5 invariant 2). Substring-checked
 * (case-insensitive): "threads" contains "reads", so even incidental
 * substrings fail closed. Adversarially pinned in tests.
 */
export const PERSONA_FRAGMENT_FORBIDDEN_WORDS = [
  "reads",
  "policy",
  "grant",
  "capability",
  "budget",
] as const;

function flattenLine(text: string): string {
  return text.replace(/\r?\n/g, "\\n");
}

/**
 * Deterministic prompt fragment: voice register + brevity caps + explanation
 * style + address + extras, one line each, nothing else. Throws (fail
 * closed) if any input text would smuggle a forbidden word into the
 * fragment — the caller then ships no persona at all, never a contaminated
 * one. Pure: no DB, no clock, no randomness.
 */
export function renderPersonaFragment(
  definition: ProfileDefinition,
  opts: { readonly principalName: string },
): string {
  const principalName = opts.principalName.trim();
  if (principalName.length === 0 || /[\r\n]/.test(principalName)) {
    throw new Error("renderPersonaFragment: principalName must be a single non-empty line");
  }
  const lines: string[] = [
    `PERSONA for ${flattenLine(principalName)}.`,
    `Voice: ${flattenLine(definition.register)}`,
    `Brevity: at most ${definition.brevity.maxSentences} sentences and ${definition.brevity.maxChars} characters per reply.`,
    definition.explanation === "lead_with_answer"
      ? "Answer first: lead with the answer, then only the context that is needed."
      : "Context first: lead with the necessary context, then the answer.",
  ];
  if (definition.address.ownerName !== undefined) {
    lines.push(`Address: call the principal "${flattenLine(definition.address.ownerName)}".`);
  }
  for (const directive of definition.extraDirectives ?? []) {
    lines.push(`- ${flattenLine(directive)}`);
  }
  const fragment = lines.join("\n");
  const lower = fragment.toLowerCase();
  for (const word of PERSONA_FRAGMENT_FORBIDDEN_WORDS) {
    if (lower.includes(word)) {
      throw new Error(
        `renderPersonaFragment: fragment must never contain '${word}' — profiles are presentation only`,
      );
    }
  }
  return fragment;
}

// ---------------------------------------------------------------------------
// Versioned storage (append-only; active = max version per principal×surface)
// ---------------------------------------------------------------------------

export type ProfileCreatedVia = "owner_seed" | "self";

const CREATED_VIA: ReadonlySet<string> = new Set(["owner_seed", "self"]);

const SURFACE_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

function assertSurface(surface: string): void {
  if (!SURFACE_RE.test(surface)) {
    throw new Error(`profiles: invalid surface '${surface}'`);
  }
}

function assertDefinition(definition: ProfileDefinition): ProfileDefinition {
  const parsed = parseProfileDefinition(definition);
  if (parsed === null) {
    throw new Error("profiles: definition failed the strict schema (fail-closed refuse-to-store)");
  }
  return parsed;
}

export interface ActiveProfile {
  readonly definition: ProfileDefinition;
  readonly version: number;
}

/**
 * The principal's active profile: max version for (principal, surface) via
 * the interaction_profiles_active view. An unparseable stored definition is
 * INERT (null), never an error surface — presentation degradation, not a
 * turn failure.
 */
export async function activeProfile(
  db: QueryExecutor,
  opts: {
    readonly principalId: string;
    readonly surface: string;
  },
): Promise<ActiveProfile | null> {
  assertSurface(opts.surface);
  const result = await db.query(
    `SELECT version, definition FROM interaction_profiles_active
      WHERE principal_id = $1::uuid AND surface = $2`,
    [opts.principalId, opts.surface],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const definition = parseProfileDefinition(row.definition);
  if (definition === null) return null;
  return { definition, version: Number(row.version) };
}

/** Single-statement append: next version = max(version)+1 (UNIQUE guards races). */
async function appendVersion(
  db: QueryExecutor,
  opts: {
    readonly principalId: string;
    readonly surface: string;
    readonly definition: ProfileDefinition;
    readonly via: ProfileCreatedVia;
  },
): Promise<number> {
  assertSurface(opts.surface);
  if (typeof opts.via !== "string" || !CREATED_VIA.has(opts.via)) {
    throw new Error(`profiles: invalid created_via '${String(opts.via)}'`);
  }
  const definition = assertDefinition(opts.definition);
  const id = randomUUID();
  const result = await db.query(
    `INSERT INTO interaction_profiles
       (id, principal_id, surface, version, definition, created_via, created_at)
     VALUES ($1, $2::uuid, $3,
             (SELECT COALESCE(MAX(version), 0) + 1 FROM interaction_profiles
               WHERE principal_id = $2::uuid AND surface = $3),
             $4::jsonb, $5, now())
     RETURNING version`,
    [id, opts.principalId, opts.surface, JSON.stringify(definition), opts.via],
  );
  return Number(result.rows[0]!.version);
}

/** Seed a profile version (created_via='owner_seed') — the owner-ratified path. */
export async function seedProfile(
  db: QueryExecutor,
  opts: {
    readonly principalId: string;
    readonly surface: string;
    readonly definition: ProfileDefinition;
  },
): Promise<number> {
  return appendVersion(db, { ...opts, via: "owner_seed" });
}

/**
 * Append the next profile version. NEVER updates: the 018 storage trigger
 * rejects UPDATE (and DELETE) outright; version history is immutable.
 * `via: "self"` rows are the confirmed end of the propose→confirm flow —
 * the orchestrator wires the confirmation; this only writes the row.
 */
export async function nextProfileVersion(
  db: QueryExecutor,
  opts: {
    readonly principalId: string;
    readonly surface: string;
    readonly definition: ProfileDefinition;
    readonly via: ProfileCreatedVia;
  },
): Promise<number> {
  return appendVersion(db, opts);
}

// ---------------------------------------------------------------------------
// Thread-scoped overrides (interaction_threads.metadata.profile_override)
// ---------------------------------------------------------------------------

function clampInt(value: number, min: number, max: number): number {
  const truncated = Number.isInteger(value) ? value : Math.trunc(value);
  return Math.min(max, Math.max(min, truncated));
}

function sanitizeDirective(text: string): string {
  return flattenLine(redactContent(text.trim())).slice(0, PROFILE_EXTRA_DIRECTIVE_MAX_CHARS);
}

/**
 * Pure merge of a thread-scoped override into a definition. Brevity deltas
 * are additive and clamped to the schema ceilings (fail-closed bounds);
 * the extra directive is appended with the ≤5 / ≤120-char caps. `null`
 * returns the definition unchanged. NEVER writes anything anywhere — the
 * override expires with the thread and never persists to the profile
 * (DB-pinned in tests).
 */
export function mergeThreadOverride(
  definition: ProfileDefinition,
  override: ThreadProfileOverride | null,
): ProfileDefinition {
  if (override === null) return definition;
  let maxSentences = definition.brevity.maxSentences;
  let maxChars = definition.brevity.maxChars;
  if (override.brevityDelta?.maxSentences !== undefined) {
    maxSentences = clampInt(
      maxSentences + override.brevityDelta.maxSentences,
      1,
      PROFILE_BREVITY_MAX_SENTENCES,
    );
  }
  if (override.brevityDelta?.maxChars !== undefined) {
    maxChars = clampInt(
      maxChars + override.brevityDelta.maxChars,
      1,
      PROFILE_BREVITY_MAX_CHARS,
    );
  }
  const extras = [...(definition.extraDirectives ?? [])];
  if (override.extraDirective !== undefined) {
    const line = sanitizeDirective(override.extraDirective);
    if (line.trim().length > 0) extras.push(line);
  }
  const extraDirectives =
    extras.length > PROFILE_EXTRA_DIRECTIVES_MAX
      ? extras.slice(extras.length - PROFILE_EXTRA_DIRECTIVES_MAX)
      : extras;
  return {
    ...definition,
    brevity: { maxSentences, maxChars },
    ...(extraDirectives.length > 0 ? { extraDirectives } : {}),
  };
}

/**
 * Write (or clear, with null) the thread's profile override. Lives in
 * interaction_threads.metadata.profile_override — an ADDITIVE key the W1
 * thread-state merge preserves; it disappears with thread turnover/retention
 * and never touches interaction_profiles. Cross-principal writes fail
 * closed (owner check under FOR UPDATE, the retractThreadStance pattern).
 */
export async function setThreadProfileOverride(
  db: QueryExecutor,
  opts: {
    readonly threadId: string;
    readonly principalId: string;
    readonly override: ThreadProfileOverride | null;
  },
): Promise<void> {
  if (opts.override !== null) {
    const delta = opts.override;
    const hasBrevity =
      delta.brevityDelta !== undefined &&
      (delta.brevityDelta.maxSentences !== undefined ||
        delta.brevityDelta.maxChars !== undefined);
    const hasExtra =
      delta.extraDirective !== undefined && sanitizeDirective(delta.extraDirective).length > 0;
    if (!hasBrevity && !hasExtra) {
      throw new Error("setThreadProfileOverride: override must carry a brevity delta or a directive");
    }
  }
  const row = await db.query(
    `SELECT principal_id, metadata FROM interaction_threads WHERE id = $1::uuid FOR UPDATE`,
    [opts.threadId],
  );
  const thread = row.rows[0];
  if (thread === undefined || String(thread.principal_id) !== opts.principalId) {
    throw new Error("setThreadProfileOverride: thread does not belong to the requesting principal");
  }
  const existing = parseThreadMetadata(thread.metadata) ?? {};
  const merged: Record<string, unknown> = {
    ...(existing.topic !== undefined ? { topic: existing.topic } : {}),
    ...(existing.referents !== undefined ? { referents: existing.referents } : {}),
    ...(existing.lastStance !== undefined ? { lastStance: existing.lastStance } : {}),
    ...(existing.pendingProposal !== undefined
      ? { pendingProposal: existing.pendingProposal }
      : {}),
    ...(existing.pendingProbe !== undefined ? { pendingProbe: existing.pendingProbe } : {}),
    ...(opts.override !== null ? { profile_override: opts.override } : {}),
  };
  await db.query(
    `UPDATE interaction_threads SET metadata = $2::jsonb WHERE id = $1::uuid`,
    [opts.threadId, JSON.stringify(merged)],
  );
}

// ---------------------------------------------------------------------------
// Self-configuration verbs (deterministic grammar; parse + apply helpers)
// ---------------------------------------------------------------------------

/** Fixed deterministic steps for "be brief" / "be more detailed". */
export const DIRECTIVE_BREVITY_STEP_SENTENCES = 2;
export const DIRECTIVE_BREVITY_STEP_CHARS = 300;

/** Persistent (propose→confirm) delta over a definition; applied by applyDefinitionDelta. */
export interface ProfileDefinitionDelta {
  readonly brevityDelta?: { readonly maxSentences?: number; readonly maxChars?: number };
  readonly addressOwnerName?: string;
  readonly removeAddress?: boolean;
  readonly extraDirective?: string;
}

/**
 * A parsed self-configuration verb. Thread-scoped verbs carry an override
 * delta (applied to the thread's override via applyOverrideDelta); the
 * "always"/"from now on" prefix upgrades the verb to a persistent
 * definitionDelta for the orchestrator's propose→confirm flow.
 */
export type ProfileDirective =
  | { readonly persist: false; readonly overrideDelta: ThreadProfileOverride }
  | { readonly persist: true; readonly definitionDelta: ProfileDefinitionDelta };

const ADDRESS_TERM_RE = /^[A-Za-z0-9' .-]{1,60}$/;

function validAddressTerm(term: string): boolean {
  if (!ADDRESS_TERM_RE.test(term)) return false;
  const lower = term.toLowerCase();
  for (const word of PERSONA_FRAGMENT_FORBIDDEN_WORDS) {
    if (lower.includes(word)) return false;
  }
  return true;
}

/**
 * Deterministic grammar over free text (case-insensitive, whitespace-
 * normalized, trailing punctuation tolerated):
 *
 *   "be brief"                    → thread brevity −2 sentences / −300 chars
 *   "be more detailed"            → thread brevity +2 / +300
 *   "call me <Term>"              → thread-scoped address directive
 *   "stop calling me <Term>"      → thread-scoped no-address directive
 *   "always …" / "from now on …"  → same verbs, persistent definitionDelta
 *                                   ("always call me Chief" → address;
 *                                    "always stop calling me Chief" → remove)
 *
 * Returns null for anything else — the orchestrator falls through to
 * normal chat. Terms are 1–60 chars of name-shaped text and must not carry
 * the forbidden vocabulary (fail closed at the door, not at render time).
 */
export function parseProfileDirective(text: string): ProfileDirective | null {
  if (typeof text !== "string") return null;
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > 200) return null;
  const body = normalized.replace(/[.!?]+$/, "").trim();
  if (body.length === 0) return null;
  const prefix = body.match(/^(always|from now on)\b[,:]?\s*(.*)$/i);
  const persist = prefix !== null;
  const core = (prefix?.[2] ?? body).trim();
  if (core.length === 0) return null;

  const brief = core.match(/^be brief$/i);
  const detailed = core.match(/^be more detailed$/i);
  const call = core.match(/^call me (.+)$/i);
  const stop = core.match(/^stop calling me (.+)$/i);

  if (brief !== null || detailed !== null) {
    const sign = brief !== null ? -1 : 1;
    const brevityDelta = {
      maxSentences: sign * DIRECTIVE_BREVITY_STEP_SENTENCES,
      maxChars: sign * DIRECTIVE_BREVITY_STEP_CHARS,
    };
    return persist
      ? { persist: true, definitionDelta: { brevityDelta } }
      : { persist: false, overrideDelta: { brevityDelta } };
  }

  if (call !== null) {
    const term = call[1]!.trim();
    if (!validAddressTerm(term)) return null;
    return persist
      ? { persist: true, definitionDelta: { addressOwnerName: term } }
      : {
          persist: false,
          overrideDelta: { extraDirective: `Address the principal as "${term}" for this thread only.` },
        };
  }

  if (stop !== null) {
    const term = stop[1]!.trim();
    if (!validAddressTerm(term)) return null;
    return persist
      ? { persist: true, definitionDelta: { removeAddress: true } }
      : {
          persist: false,
          overrideDelta: { extraDirective: `Do not address the principal as "${term}" for this thread.` },
        };
  }

  return null;
}

/**
 * Apply a persistent definitionDelta (pure; the confirm step of the
 * propose→confirm flow persists the result as a NEW version via
 * nextProfileVersion). All fields clamp to the strict schema — a delta can
 * never push a definition out of bounds.
 */
export function applyDefinitionDelta(
  definition: ProfileDefinition,
  delta: ProfileDefinitionDelta,
): ProfileDefinition {
  let maxSentences = definition.brevity.maxSentences;
  let maxChars = definition.brevity.maxChars;
  if (delta.brevityDelta?.maxSentences !== undefined) {
    maxSentences = clampInt(
      maxSentences + delta.brevityDelta.maxSentences,
      1,
      PROFILE_BREVITY_MAX_SENTENCES,
    );
  }
  if (delta.brevityDelta?.maxChars !== undefined) {
    maxChars = clampInt(maxChars + delta.brevityDelta.maxChars, 1, PROFILE_BREVITY_MAX_CHARS);
  }
  let address = definition.address;
  if (delta.removeAddress === true) {
    address = {};
  }
  if (delta.addressOwnerName !== undefined) {
    const ownerName = sanitizeDirective(delta.addressOwnerName).slice(0, PROFILE_OWNER_NAME_MAX_CHARS).trim();
    address = ownerName.length > 0 ? { ownerName } : {};
  }
  const extras = [...(definition.extraDirectives ?? [])];
  if (delta.extraDirective !== undefined) {
    const line = sanitizeDirective(delta.extraDirective);
    if (line.trim().length > 0) extras.push(line);
  }
  const extraDirectives =
    extras.length > PROFILE_EXTRA_DIRECTIVES_MAX
      ? extras.slice(extras.length - PROFILE_EXTRA_DIRECTIVES_MAX)
      : extras;
  return {
    ...definition,
    brevity: { maxSentences, maxChars },
    address,
    ...(extraDirectives.length > 0 ? { extraDirectives } : {}),
  };
}

/**
 * Fold a thread-scoped overrideDelta into the thread's existing override
 * (pure). Brevity deltas accumulate component-wise; the extraDirective
 * slot is single-valued — the newest directive replaces the previous one.
 * A null existing starts fresh.
 */
export function applyOverrideDelta(
  existing: ThreadProfileOverride | null,
  delta: ThreadProfileOverride,
): ThreadProfileOverride {
  const base = existing ?? {};
  const brevityDelta: { maxSentences?: number; maxChars?: number } = {
    ...(base.brevityDelta ?? {}),
  };
  if (delta.brevityDelta?.maxSentences !== undefined) {
    brevityDelta.maxSentences =
      (brevityDelta.maxSentences ?? 0) + delta.brevityDelta.maxSentences;
  }
  if (delta.brevityDelta?.maxChars !== undefined) {
    brevityDelta.maxChars = (brevityDelta.maxChars ?? 0) + delta.brevityDelta.maxChars;
  }
  return {
    ...(Object.keys(brevityDelta).length > 0 ? { brevityDelta } : {}),
    ...(delta.extraDirective !== undefined ? { extraDirective: delta.extraDirective } : {}),
  };
}
