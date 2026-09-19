// Paired-handle sensor config (multi-principal onboarding —
// docs/plans/ig-multiprincipal-contracts.md, "Heartbeat response carries
// sensor config"). The server tells the sensor, in every health heartbeat
// RESPONSE, which handles are paired principals (canonical: +E.164 or
// lowercase email). This module is where that config lands.
//
// PRIVACY INVARIANT (binding): message content is forwarded ONLY for
// non-own rows whose handle is in this cache; every other non-own row
// carries a pairing_attempt_hash instead (poll.ts). A missing, invalid,
// or absent config → EMPTY cache → NO content ever leaves the process
// (fail closed; the server discards+audits stray content regardless).
//
// Handle comparison is canonical on BOTH sides through the ONE shared
// normalizer below — the server's canonical handles and chat.db's raw
// handles (formatting/case vary) are normalized identically:
//   - email-shaped (contains "@"): trim + lowercase
//   - phone-shaped: strip every non-digit (spaces, (), -, ., +) → "+" + digits
// Local normalization collapses FORMATTING ONLY. It deliberately never
// adds a country code (a bare 10-digit local form does NOT match +1… —
// no silent region assumptions) and never merges an unproven handle onto
// a principal — the server's pairing state stays authoritative.

/** Minimal lookup the poll classifier needs (PairedHandleCache implements it). */
export interface PairedHandleLookup {
  has(rawHandle: string | null): boolean;
}

/**
 * Canonicalize one handle for comparison (shared by both sides: the
 * server-provided paired list and chat.db's raw handle strings).
 */
export function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length > 0) return `+${digits}`;
  return trimmed.toLowerCase();
}

export type PairedHandlesBody =
  | { readonly ok: true; readonly handles: readonly string[] }
  | { readonly ok: false; readonly reason: "absent" | "invalid" };

/**
 * Validates a heartbeat response body against
 * `{ paired_handles: string[] }`. `null` (204-without-body, the old
 * server) → absent; any other non-matching shape → invalid. Both are the
 * caller's signal to fail closed.
 */
export function parsePairedHandlesBody(body: unknown): PairedHandlesBody {
  if (body === null || body === undefined) {
    return { ok: false, reason: "absent" };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "invalid" };
  }
  const handles = (body as Record<string, unknown>)["paired_handles"];
  if (!Array.isArray(handles)) {
    return { ok: false, reason: "invalid" };
  }
  for (const handle of handles) {
    if (typeof handle !== "string" || handle.trim().length === 0) {
      return { ok: false, reason: "invalid" };
    }
  }
  return { ok: true, handles };
}

/** In-memory paired-handle set; refreshed wholesale on every heartbeat. */
export class PairedHandleCache implements PairedHandleLookup {
  private normalized: ReadonlySet<string> = new Set();

  /** Replace the cache with a fresh server-provided canonical list. */
  refresh(canonicalHandles: readonly string[]): void {
    this.normalized = new Set(canonicalHandles.map((handle) => normalizeHandle(handle)));
  }

  /** true iff the raw chat.db handle canonicalizes to a paired handle. */
  has(rawHandle: string | null): boolean {
    if (rawHandle === null || rawHandle.length === 0) return false;
    return this.normalized.has(normalizeHandle(rawHandle));
  }

  get size(): number {
    return this.normalized.size;
  }
}
