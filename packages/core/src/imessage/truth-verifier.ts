// packages/core/src/imessage/truth-verifier.ts — §22.9 truth verification
// (intelligence-reset build item 3): the ledger-based verifier that replaces
// claim-audit prose policing. One bounded verification prompt (the draft
// reply + the turn's typed execution ledger rendered as JSON — INCLUDING
// rejected and failed entries, owner correction 3, 2026-09-24) → one
// strict-parsed JSON verdict; one regeneration prompt that states the
// finding as ledger fact. Pure builders/parsers only — the cognitive loop
// owns dispatch, the §22.9 ladder (one verification + one regeneration +
// one forced-final), and the `converse.claim_audit` findings row.
//
// Scope (§22.9): ACTION claims only — mutations, resolutions, and their
// outcomes. No style/vocabulary/opinion policing; deterministic code never
// edits user-facing prose.

/** Maximum length of a contradiction finding, wherever one is rendered or
 *  accepted (§22.9 bounds the regeneration prompt; the parser truncates
 *  verbose verifier findings to this). */
export const FINDING_CHAR_CAP = 300;

/** Render cap for the draft reply inside both prompts. §22.2 caps a real
 *  envelope `reply` at 1500 chars; 2000 is the defensive bound for callers
 *  that exceed it. */
export const DRAFT_REPLY_CHAR_CAP = 2000;

/** Render cap for the original-context summary inside the regeneration
 *  prompt (caller-supplied digest, bounded defensively). */
export const REGENERATION_CONTEXT_CHAR_CAP = 2000;

/** Render cap for the canonical WORK STATE section (shell-trust R1). */
export const WORK_STATE_CHAR_CAP = 1400;

/** Ledger entries rendered into a prompt. A legal turn cannot exceed 6
 *  (§22.2: ≤4 operations + ≤2 resolutions per envelope; a validation
 *  re-prompt's rejects double that at most) — 16 is the defensive render
 *  bound. When exceeded, the MOST RECENT entries survive: the forced-final
 *  rejects owner correction 3 protects are the newest. */
export const LEDGER_RENDER_MAX_ENTRIES = 16;

const LEDGER_FIELD_CHAR_CAP = 120;
const LEDGER_DETAIL_CHAR_CAP = 240;

/**
 * One recorded terminal outcome from the turn's execution ledger. Callers
 * (the cognitive loop) construct these from EVERY operation and resolution
 * the turn attempted — applied, parked, queued, failed, AND rejected
 * (owner correction 3, 2026-09-24: a forced-final `reminder_create`
 * rejected as over-budget must be visible to the verifier, so a reply
 * claiming "Done, I set the reminder" is flagged).
 */
export interface LedgerEntry {
  readonly kind: "operation" | "resolution";
  /** Operation type (e.g. "reminder_create") / the resolution's target type. */
  readonly opType?: string;
  readonly status: "applied" | "parked" | "queued" | "failed" | "rejected";
  /** Deterministic id when the writer minted one (e.g. "task_batch:a1b2"). */
  readonly id?: string;
  /** Machine outcome detail (e.g. the failure or rejection reason). */
  readonly detail?: string;
  /** Caller-written one-line plain-language summary for the verifier. */
  readonly summaryForVerifier?: string;
}

/**
 * Verdict of one verification pass over a draft reply vs the turn's
 * execution ledger.
 *
 * FAIL-OPEN CONTRACT: when `parseVerificationVerdict` returns `null`,
 * callers MUST treat it as `{ verdict: "consistent" }` and ship the draft —
 * a broken or chatty verifier must never block shipping (§22.9; the ladder
 * runs only on a parsed `contradicts`).
 */
export type VerificationVerdict =
  | { readonly verdict: "consistent" }
  | { readonly verdict: "contradicts"; readonly finding: string };

function clip(value: string, cap: number): string {
  return value.length <= cap ? value : value.slice(0, cap);
}

function renderLedgerEntry(entry: LedgerEntry): string {
  const out: Record<string, string> = { kind: entry.kind, status: entry.status };
  if (entry.opType !== undefined) out["opType"] = clip(entry.opType, LEDGER_FIELD_CHAR_CAP);
  if (entry.id !== undefined) out["id"] = clip(entry.id, LEDGER_FIELD_CHAR_CAP);
  if (entry.detail !== undefined) out["detail"] = clip(entry.detail, LEDGER_DETAIL_CHAR_CAP);
  if (entry.summaryForVerifier !== undefined) {
    out["summaryForVerifier"] = clip(entry.summaryForVerifier, LEDGER_DETAIL_CHAR_CAP);
  }
  return JSON.stringify(out);
}

function renderLedgerJson(ledger: readonly LedgerEntry[]): string {
  if (ledger.length === 0) return "[]";
  const omitted = Math.max(0, ledger.length - LEDGER_RENDER_MAX_ENTRIES);
  const kept = omitted > 0 ? ledger.slice(-LEDGER_RENDER_MAX_ENTRIES) : ledger;
  const body = kept.map(renderLedgerEntry).join(",\n  ");
  if (omitted === 0) return `[\n  ${body}\n]`;
  const unit = omitted === 1 ? "entry" : "entries";
  return `[\n  (${omitted} earlier ${unit} omitted — ledger truncated for length),\n  ${body}\n]`;
}

/**
 * The bounded verification prompt (§22.9 + shell-trust R1): the draft
 * reply + the execution ledger as JSON + the canonical WORK STATE, judged
 * on ACTION claims and WORK claims. Instructs EXACTLY one line of JSON
 * back — `{"verdict":"consistent"}` or `{"verdict":"contradicts",
 * "finding":"…"}` — with no prose outside it. Both the reply and every
 * ledger field are clipped to their caps, so the prompt is bounded for any
 * input.
 *
 * WORK STATE semantics (owner amendment 1): the snapshot is the ONLY
 * sanctioned source for claims that work exists / is underway / has
 * progressed. It proves EXISTENCE-class facts (an assignment is running, a
 * worker produced an artifact, criterion N is verified); it does NOT make
 * an artifact's substantive sentences true — "found three viable
 * verticals" is truthful only with verified criteria, else the truthful
 * form is "an assignment completed and produced an artifact".
 */
export function buildVerificationPrompt(
  reply: string,
  ledger: readonly LedgerEntry[],
  workState?: string,
  todayLine?: string,
): string {
  return [
    "You are verifying a draft assistant reply against the execution ledger of what this turn's actions actually did.",
    ...(todayLine !== undefined ? [todayLine] : []),
    "",
    "<draft_reply>",
    clip(reply, DRAFT_REPLY_CHAR_CAP),
    "</draft_reply>",
    "",
    "<execution_ledger>",
    renderLedgerJson(ledger),
    "</execution_ledger>",
    "",
    "<work_state>",
    clip(workState ?? "NO DELEGATED WORK EXISTS (canonical work state is empty)", WORK_STATE_CHAR_CAP),
    "</work_state>",
    "",
    'The execution ledger is ground truth for ACTION claims; the work state is ground truth for WORK claims. Judge ACTION claims: whether the reply\'s statements about operations and proposal resolutions — mutations, resolutions, and their outcomes, INCLUDING failed and rejected attempts — match the ledger. An EMPTY ledger ([]) means NO action ran this turn: any claim that the reply set, created, tracked, scheduled, reminded, changed, or completed something contradicts. Judge WORK claims: statements that DELEGATED work (multi-day projects, research, assignments, outcomes) exists, is underway, in progress, paused, or finished — and any deadline, checkpoint, or timeline attached to them — are true ONLY if the work_state shows it. Ordinary to-dos, reminders, and calendar events are NOT delegated work: claims about them are ACTION claims judged against the ledger, never against work_state. Ledger parked/queued is an OFFER or queued work, never "underway" or "started". History, memory, or the user having discussed an idea NEVER establishes that work exists; work_state saying NO WORK EXISTS + any work-existence claim contradicts. Substantive findings claims ("we found three viable verticals") are truthful only with verified criteria in work_state; "an assignment completed and produced an artifact" is the honest form otherwise. A reply that only offers, asks, recommends, or explains makes no action claim — including general explanations of how the assistant or its features work ("reminders work by..."), which say nothing about THIS turn actions. Do not judge style, vocabulary, tone, opinions, or any other non-action content; a reply making no action or work claim is consistent.',
    "",
    "Respond with EXACTLY one line of JSON and no other text — no markdown fences, no prose:",
    '{"verdict":"consistent"}',
    "or",
    '{"verdict":"contradicts","finding":"<one sentence: what the reply claims vs what the ledger/work state shows>"}',
  ].join("\n");
}

/**
 * Strict parse of the verifier call's output. The ENTIRE text must be one
 * JSON object — the verdict on a single line, nothing outside it. Markdown
 * fences, prose before/after the JSON, extra keys, unknown verdict values,
 * or a missing/empty/non-string `finding` all parse to null. A finding
 * longer than {@link FINDING_CHAR_CAP} is truncated to it, never widened.
 *
 * FAIL-OPEN CONTRACT: `null` MUST be treated by callers as
 * `{ verdict: "consistent" }` and the draft shipped — a broken verifier
 * never blocks shipping (§22.9).
 */
export function parseVerificationVerdict(text: string): VerificationVerdict | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const keys = new Set(Object.keys(obj));
  if (obj["verdict"] === "consistent") {
    return keys.size === 1 && keys.has("verdict") ? { verdict: "consistent" } : null;
  }
  if (obj["verdict"] === "contradicts") {
    if (keys.size !== 2 || !keys.has("finding")) return null;
    const finding = obj["finding"];
    if (typeof finding !== "string") return null;
    const bounded = finding.trim();
    if (bounded.length === 0) return null;
    return { verdict: "contradicts", finding: clip(bounded, FINDING_CHAR_CAP) };
  }
  return null;
}

/**
 * The one-shot regeneration prompt (§22.9's single regeneration round,
 * + shell-trust R1's work state): the finding stated as FACT, with the
 * original context summary, the ledger, the work state, and the
 * contradicted draft. Instructs a truthful final reply — ledger statuses
 * are what happened; the work state is what exists — and forbids ever
 * mentioning verification mechanics to the user. All inputs clipped to
 * their caps; bounded for any input.
 */
export function buildRegenerationPrompt(
  originalContextSummary: string,
  ledger: readonly LedgerEntry[],
  finding: string,
  draftReply: string,
  workState?: string,
  todayLine?: string,
): string {
  return [
    "Regenerate the final user-facing reply for this turn. Your draft made a claim the execution ledger or the canonical work state contradicts.",
    ...(todayLine !== undefined ? [todayLine] : []),
    "",
    "<original_context>",
    clip(originalContextSummary, REGENERATION_CONTEXT_CHAR_CAP),
    "</original_context>",
    "",
    "<execution_ledger>",
    renderLedgerJson(ledger),
    "</execution_ledger>",
    "",
    "<work_state>",
    clip(workState ?? "NO DELEGATED WORK EXISTS (canonical work state is empty)", WORK_STATE_CHAR_CAP),
    "</work_state>",
    "",
    "<contradiction_finding>",
    clip(finding, FINDING_CHAR_CAP),
    "</contradiction_finding>",
    "",
    "<draft_reply>",
    clip(draftReply, DRAFT_REPLY_CHAR_CAP),
    "</draft_reply>",
    "",
    "The finding is an established fact from the execution ledger or the work state — treat it as ground truth; never dispute, re-litigate, or soften it. Write the truthful final reply:",
    "- ledger statuses are what happened: applied = done; parked/queued = offered or queued, NOT done and NOT underway; failed/rejected = did NOT happen, and the reply must say so plainly (\"that didn't land — nothing was set\" class).",
    "- the work state is what work exists: a claim that work is underway/progressing/finished is true ONLY if the work state shows it; if it shows NO WORK EXISTS, the reply must say plainly that nothing is set up. Never re-narrate work claims from the draft the work state does not support.",
    "- keep everything in the draft the ledger AND the work state do not contradict.",
    "- at most 1500 characters.",
    "- never mention verification, findings, drafts, ledgers, or any internal mechanics to the user — the user sees only this final reply, as though it were the only draft.",
    "",
    "Output ONLY the regenerated reply text — no JSON, no explanation.",
  ].join("\n");
}
