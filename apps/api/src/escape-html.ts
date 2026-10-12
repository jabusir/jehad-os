/**
 * The single escape-at-boundary helper (ADR-0019 §2: "Output encoding is a
 * hard rule" — every string rendered into Today HTML that derives from
 * external content passes through this function; no raw interpolation).
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}
