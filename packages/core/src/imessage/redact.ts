// Denylist redaction pass (Phase D §2.1, ig-phase-d-contracts.md;
// ADR-0014): secrets in conversation content are masked BEFORE anything
// is persisted to interaction_messages — the single canonical content
// path. Conservative denylist: mask only shapes that are overwhelmingly
// credentials (Luhn-valid card numbers, known API-token prefixes,
// bearer tokens, long standalone opaque runs); everything else is left
// verbatim so normal prose, URLs, dates, and identifiers survive.
//
// Documented decisions:
// - The mask token is the literal "⦙redacted⦙" — distinctive, greppable,
//   and inert: it matches NONE of the denylist patterns, so the pass is
//   idempotent (redact(redact(x)) === redact(x)).
// - Pure lowercase-hex runs ([0-9a-f]+, e.g. sha256 digests) are hashes,
//   not secrets: left unmasked at any length (owner decision, §2.1
//   redaction scope). Uppercase-hex 40+ runs ARE masked (conservative).
// - Loop-defense lineage is unaffected by construction: fingerprints
//   (rendered_text_sha256) and sensor hashes (normalized_text_sha256)
//   are computed upstream from RAW content at delivery/observation time;
//   nothing hashes stored interaction_messages.content.
// - This module is pure and deterministic, and NEVER logs content.

/** The mask substituted for every denylist hit. */
export const REDACTED_TOKEN = "⦙redacted⦙";

/** Luhn checksum over an ASCII digit string (no separators). */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits.charCodeAt(i) - 48;
    if (double) {
      const dd = d * 2;
      sum += dd > 9 ? dd - 9 : dd;
    } else {
      sum += d;
    }
    double = !double;
  }
  return sum % 10 === 0;
}

// Card candidates: a digit followed by 12–18 more digits with optional
// spaces/dashes/dots BETWEEN digit groups — 13–19 digits total, ending
// on a digit (trailing punctuation is never consumed). The Luhn check
// in the replacer keeps phones, dates, and UUID digit groups safe.
const CARD_CANDIDATE = /\d(?:[ .-]?\d){12,18}/g;

// Known API-token prefixes (OpenAI/Anthropic, AWS, GitHub, Slack,
// Google). \b keeps prefixes from firing mid-word.
const KNOWN_TOKEN_PREFIX =
  /\b(?:sk-ant-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/g;

// Bearer credentials: the scheme word is kept (readable provenance in
// history), only the credential is masked.
const BEARER_TOKEN = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi;

// Long standalone opaque runs (pasted keys/JWTs without known
// prefixes): 40+ chars of [A-Za-z0-9+/_-] containing BOTH letters and
// digits. The lookaround bounds make the run truly standalone — a run
// embedded in a larger token or URL component (after ".", "/", ":",
// "=", …) is never touched, so URLs are structurally never masked.
const OPAQUE_RUN = /(?<![A-Za-z0-9+/:._-])[A-Za-z0-9+/_-]{40,}(?![A-Za-z0-9+/:._-])/g;

/**
 * Pure, deterministic denylist pass over conversation content. One
 * linear pass per pattern class; multi-line safe (operates on the
 * whole string); idempotent (the mask matches no pattern).
 */
export function redactContent(text: string): string {
  const maskedPrefixes = text
    .replace(KNOWN_TOKEN_PREFIX, REDACTED_TOKEN)
    .replace(BEARER_TOKEN, `$1${REDACTED_TOKEN}`);
  const maskedCards = maskedPrefixes.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits)
      ? REDACTED_TOKEN
      : match;
  });
  return maskedCards.replace(OPAQUE_RUN, (run) => {
    if (!/[A-Za-z]/.test(run) || !/[0-9]/.test(run)) return run;
    if (/^[0-9a-f]+$/.test(run)) return run; // pure lowercase hex = digest, not a secret
    return REDACTED_TOKEN;
  });
}
