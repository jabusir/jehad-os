// Research web reconciliation (mission-execution v1) — PURE helpers, no I/O.
//
// The worker's citation list is model prose; the response annotations are the
// PROVIDER's mechanical record of which URLs were actually retrieved and
// cited during the server-tool loop. Honesty rule: a web citation survives
// only when its URL is corroborated by that mechanical record. A URL the
// model invented is dropped — never stored as provenance. The artifact text
// is untouched; only the machine-checked citation set is persisted.

import type { WebCitation } from "@jehad/adapters";

/** A citation as the worker returned it (loose shape — pre-validation). */
export interface WorkerCitation {
  readonly ref: string;
  readonly note?: string;
  readonly url?: string;
  readonly title?: string;
}

export interface CitationReconciliation {
  /** Citations that survive mechanical corroboration (or carry no URL). */
  readonly kept: WorkerCitation[];
  /** Web citations whose URL no annotation corroborates — dropped. */
  readonly dropped: number;
}

/** Canonical form for URL matching: host lowercased, hash stripped, trailing "/" stripped. */
export function normalizeUrlForMatch(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

/**
 * Reconcile the worker's citations against the provider's annotation record.
 * Non-URL citations (personal-context block labels) pass through — they are
 * grounded in the bounded package, not the web. URL citations must match an
 * annotation URL (normalized); a matching annotation's title backfills a
 * missing title (mechanical truth over model prose).
 */
export function reconcileWebCitations(
  citations: readonly unknown[],
  annotations: readonly WebCitation[],
): CitationReconciliation {
  const byUrl = new Map<string, WebCitation>();
  for (const a of annotations) {
    if (typeof a?.url === "string" && a.url.length > 0) {
      byUrl.set(normalizeUrlForMatch(a.url), a);
    }
  }
  const kept: WorkerCitation[] = [];
  let dropped = 0;
  for (const raw of citations) {
    if (typeof raw !== "object" || raw === null) {
      dropped += 1;
      continue;
    }
    const c = raw as Record<string, unknown>;
    if (typeof c.ref !== "string" || c.ref.length === 0) {
      dropped += 1;
      continue;
    }
    const base: WorkerCitation = {
      ref: c.ref,
      ...(typeof c.note === "string" && c.note.length > 0 ? { note: c.note } : {}),
      ...(typeof c.url === "string" && c.url.length > 0 ? { url: c.url } : {}),
      ...(typeof c.title === "string" && c.title.length > 0 ? { title: c.title } : {}),
    };
    if (base.url === undefined) {
      kept.push(base);
      continue;
    }
    const match = byUrl.get(normalizeUrlForMatch(base.url));
    if (match === undefined) {
      dropped += 1;
      continue;
    }
    kept.push({
      ...base,
      ...(base.title === undefined && match.title !== undefined ? { title: match.title } : {}),
    });
  }
  return { kept, dropped };
}

/** The strict-envelope parse shared by the executor: strip fences, parse, object-or-null. */
export function parseJsonEnvelope(text: string): Record<string, unknown> | null {
  const direct = tryParseObject(
    text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim(),
  );
  if (direct !== null) return direct;
  // Deterministic healing: models occasionally prepend/append a sentence
  // around the single-line envelope. Extract the FIRST balanced {…} object
  // (string-aware) and parse THAT. Discipline is unchanged — the object must
  // still parse as JSON and pass the full envelope validation downstream;
  // unparseable output still rejects.
  const trimmed = text.trim();
  // A payload that IS an array (or starts with one) is never an object
  // envelope — extraction must not fish an object out of an array.
  if (trimmed.startsWith("[")) return null;
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return tryParseObject(trimmed.slice(start, i + 1));
    }
  }
  return null;
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
