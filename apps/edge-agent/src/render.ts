// Notification → iMessage text rendering (E4-S). Pure; no DB, no clock, no
// transport. Notification payloads are DATA: rendered verbatim (kind-specific
// projection below), never executed, never re-parsed as instructions.
//
// FallbackTruncation: every rendered text is capped at 1500 chars (iMessage
// splits long bodies; the cap keeps one notification to one readable bubble).
//
// Loop-defense fingerprint (Phase A, ig-phase-a-contracts.md): the canonical
// hash of the EXACT rendered text handed to the send. Normalization is
// Unicode NFC + line-ending fold ONLY — no trimming, no punctuation rewrite
// (aggressive normalization trades false negatives for collisions).

import { createHash } from "node:crypto";

export const FALLBACK_TRUNCATION_LIMIT = 1500;
const TRUNCATION_MARKER = "…[truncated]";

/** The claim projection shape this agent receives (subset — send-only). */
export interface DeliverableNotification {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly payload: Record<string, unknown>;
}

export function truncateForImessage(text: string): string {
  if (text.length <= FALLBACK_TRUNCATION_LIMIT) return text;
  return text.slice(0, FALLBACK_TRUNCATION_LIMIT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Canonical text normalization BEFORE any hashing (binding contract):
 * NFC composition + CR/CRLF → LF. NO trimming, NO punctuation rewrite.
 */
export function canonicalNormalize(text: string): string {
  return text.normalize("NFC").replace(/\r\n|\r/g, "\n");
}

/** sha256 hex (UTF-8) of the canonical form — the loop-defense fingerprint. */
export function renderedTextSha256(text: string): string {
  return createHash("sha256").update(canonicalNormalize(text), "utf8").digest("hex");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Kind-specific projection:
 *   brief          → title + content
 *   reply          → title + content (conversational body = payload.content)
 *   calendar-change → title only (the title IS the message: `X: moved to Y`)
 *   escalation     → title + consequenceOfWaiting (when present)
 *   anything else  → title + payload JSON (forward-compatible fallback)
 */
export function renderNotificationText(notification: DeliverableNotification): string {
  let text: string;
  switch (notification.kind) {
    case "brief":
    case "reply":
      text = [notification.title, asString(notification.payload["content"])].filter(Boolean).join("\n");
      break;
    case "calendar-change":
      text = notification.title;
      break;
    case "escalation": {
      const consequence = asString(notification.payload["consequenceOfWaiting"]);
      text = consequence === null ? notification.title : `${notification.title}\n${consequence}`;
      break;
    }
    default:
      text = `${notification.title}\n${JSON.stringify(notification.payload)}`;
  }
  return truncateForImessage(text);
}
