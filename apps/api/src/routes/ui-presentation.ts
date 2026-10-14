/**
 * U0 foundations — the Today control panel's presentation layer (Lane A of
 * the UX overhaul; docs/plans/today-ux-overhaul.md §1/§3-Lane-A). Pure render
 * helpers: no DB, no session, no routes, no JS — everything here could run in
 * a unit test. Route code (ui.ts) owns behavior; this module owns tokens,
 * language, and page chrome so every surface (and later lane) speaks the same
 * design.
 *
 * Design direction — "the calm mission control" (plan §1):
 *   system font stack, 17/15/13px type on an 8pt grid, inset-grouped cards
 *   (12px radius, hairline borders), light + dark via prefers-color-scheme,
 *   one accent + semantic red/green at ≥4.5:1 contrast, sticky translucent
 *   blurred segmented nav with aria-current, env(safe-area-inset-*), 150–200ms
 *   ease-out transitions disabled under prefers-reduced-motion.
 *
 * Language map (plan §1): canonical status enums are NEVER edited — the map
 * below is render-time only, and unknown canonical values pass through
 * unmodified (fail-open for display, never for authorization).
 *
 * Escape rule: every string derived from external content is escaped through
 * escapeHtml before interpolation, same as the route module.
 */

import { scriptTags } from "./ui-script.js";
import { escapeHtml } from "../escape-html.js";

// ------------------------------------------------------------ design tokens

/**
 * The full stylesheet for every Today page (sent as inline <style>; CSP is
 * style-src 'unsafe-inline'). One accent + semantic red/green; all pairings
 * hold ≥4.5:1 contrast in BOTH color schemes.
 */
export const UI_CSS = `
:root{
  --font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --size-body:17px;--size-secondary:15px;--size-caption:13px;
  --bg:#f2f2f7;--card:#ffffff;--text:#16161a;--text2:#51515b;--hairline:#dcdce2;
  --accent:#0b5cc2;--on-accent:#ffffff;--danger:#c0392f;--on-danger:#ffffff;--ok:#1e7b3c;
  --pill:#e4e6ec;--nav-bg:rgba(242,242,247,.82);
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0b0b0e;--card:#17171c;--text:#f0f0f4;--text2:#a3a3ae;--hairline:#2c2c34;
  --accent:#7cb3ff;--on-accent:#0a2545;--danger:#ff7a6e;--on-danger:#3a0b06;--ok:#67c98a;
  --pill:#23232b;--nav-bg:rgba(11,11,14,.82);
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0 auto;max-width:40rem;font-family:var(--font);font-size:var(--size-body);
  line-height:1.45;color:var(--text);background:var(--bg);overflow-wrap:break-word;
  padding:0 calc(16px + env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))}
a{color:var(--accent)}
h1{font-size:2rem;line-height:1.15;letter-spacing:-.02em;margin:16px 0 8px}
h2{font-size:var(--size-secondary);font-weight:600;color:var(--text2);
  text-transform:uppercase;letter-spacing:.06em;margin:24px 0 8px}
h3{font-size:var(--size-body);font-weight:600;margin:0 0 4px}
.card{background:var(--card);border:1px solid var(--hairline);border-radius:12px;
  padding:12px 16px;margin:8px 0;
  transition:border-color 160ms ease-out,background-color 160ms ease-out}
.meta{color:var(--text2);font-size:var(--size-caption);margin:4px 0}
.top-nav{position:sticky;top:0;z-index:10;margin:0 calc(-16px - env(safe-area-inset-right)) 8px calc(-16px - env(safe-area-inset-left));
  padding:calc(8px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 8px calc(16px + env(safe-area-inset-left));
  background:var(--nav-bg);border-bottom:1px solid var(--hairline);
  -webkit-backdrop-filter:saturate(1.8) blur(14px);backdrop-filter:saturate(1.8) blur(14px)}
.segmented{display:flex;gap:4px;background:var(--pill);border-radius:12px;padding:4px}
.segmented a{flex:1;display:flex;align-items:center;justify-content:center;min-height:44px;
  padding:8px 12px;border-radius:9px;font-size:var(--size-secondary);font-weight:600;
  text-decoration:none;color:var(--text2);
  transition:background-color 160ms ease-out,color 160ms ease-out}
.segmented a[aria-current="page"]{background:var(--card);color:var(--text);
  box-shadow:0 1px 2px rgba(0,0,0,.14)}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;
  font-family:inherit;font-size:var(--size-secondary);font-weight:600;cursor:pointer;
  border-radius:10px;border:1px solid transparent;padding:8px 16px;text-decoration:none;
  transition:filter 160ms ease-out,background-color 160ms ease-out}
.btn-primary{background:var(--accent);color:var(--on-accent)}
.btn-secondary{background:var(--card);color:var(--accent);border-color:var(--hairline)}
.btn-danger{background:var(--danger);color:var(--on-danger)}
button:hover,.btn:hover{filter:brightness(1.06)}
form{margin:0}
.actions{display:flex;gap:8px;align-items:flex-start;margin-top:8px;flex-wrap:wrap}
.actions form{flex:0 0 auto}
.sheet{margin-top:8px}
.sheet-toggle{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;
  border-radius:10px;border:1px solid var(--hairline);background:var(--card);color:var(--text2);
  font-size:var(--size-body);cursor:pointer;list-style:none;user-select:none}
.sheet-toggle::-webkit-details-marker{display:none}
.sheet-body{border:1px solid var(--hairline);border-radius:12px;padding:8px;margin-top:8px;
  display:flex;flex-direction:column;gap:8px;background:var(--card)}
.sheet-body form{margin:0}
.sheet-danger{border-top:1px solid var(--hairline);padding-top:8px}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:var(--size-caption);
  font-weight:600;border:1px solid var(--hairline);color:var(--text2)}
.pill-needs{color:var(--accent);border-color:var(--accent)}
.pill-motion{color:var(--text);border-color:var(--hairline);background:var(--pill)}
.pill-done{color:var(--ok);border-color:var(--ok)}
.pill-failed{color:var(--danger);border-color:var(--danger)}
.empty{background:var(--card);border:1px dashed var(--hairline);border-radius:12px;
  padding:24px 16px;text-align:center;margin:8px 0}
.empty p{color:var(--text2);margin:0 0 16px;font-size:var(--size-secondary)}
.flash{position:relative;background:var(--pill);border:1px solid var(--hairline);
  border-radius:12px;padding:12px 48px 12px 16px;margin:8px 0}
.flash p{margin:0;font-size:var(--size-secondary)}
.flash summary{position:absolute;top:6px;right:6px;min-width:44px;min-height:44px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;color:var(--text2);list-style:none;border-radius:10px}
.flash summary::-webkit-details-marker{display:none}
.error-what{color:var(--text2);margin:0 0 16px}
.error-remedy{background:var(--card);border:1px solid var(--hairline);border-radius:12px;
  padding:12px 16px;margin:0 0 16px;font-size:var(--size-secondary)}
.error-remedy p{margin:0}
.error-remedy strong{display:block;margin-bottom:4px}
.error-form{margin:0 0 16px}
.error-form form{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.banner-error{background:var(--card);border:1px solid var(--danger);border-radius:12px;
  padding:12px 16px;margin:0 0 16px;font-size:var(--size-secondary)}
.banner-error p{margin:0;color:var(--danger)}
.crumb{margin:8px 0}
.crumb a{text-decoration:none;font-size:var(--size-secondary);font-weight:600}
label{display:block;margin:8px 0;font-size:var(--size-secondary)}
input[type=password],input[type=text],input[type=datetime-local],textarea{
  width:100%;padding:8px 12px;margin:4px 0 8px;font-family:inherit;font-size:16px;
  border-radius:10px;border:1px solid var(--hairline);background:var(--card);color:var(--text)}
ul{padding-left:1.25rem}
.criteria li{margin:4px 0}
.glyph{font-weight:600}
time{white-space:nowrap}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}
}
.snooze-presets{display:flex;flex-wrap:wrap;gap:.4rem;margin:.25rem 0}
.snooze-presets form{display:inline}
.field-error{color:#b3261e;margin:.25rem 0}
.deadline-custom{display:none}
form:has(input[name="deadlinePick"][value="custom"]:checked) .deadline-custom{display:block}
@keyframes createdPulse{0%{outline:3px solid #4a90d9;outline-offset:2px}100%{outline:3px solid transparent;outline-offset:8px}}
.created-pulse{animation:createdPulse 1.2s ease-out 2}
@media(prefers-reduced-motion:reduce){.created-pulse{animation:none}}
`;

// ------------------------------------------------------------- language map

/**
 * Render-time status language (plan §1). Canonical enums are untouched;
 * unknown canonical values pass through raw so a new status can never make a
 * page stop rendering.
 */
const STATUS_LANGUAGE: Readonly<Record<string, string>> = {
  waiting_user: "Waiting for you",
  blocked: "Blocked",
  accepted: "In motion — accepted",
  queued: "In motion — queued",
  running: "In motion",
  waiting_external: "In motion — waiting externally",
  verifying: "Verifying",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function humanizeStatus(status: string): string {
  return Object.hasOwn(STATUS_LANGUAGE, status)
    ? STATUS_LANGUAGE[status]!
    : status;
}

/** Pill family for coloring: semantic, never authorization-relevant. */
export function statusPillFamily(status: string): "needs" | "motion" | "done" | "failed" | "muted" {
  switch (status) {
    case "waiting_user":
      return "needs";
    case "blocked":
      return "failed";
    case "accepted":
    case "queued":
    case "running":
    case "waiting_external":
    case "verifying":
      return "motion";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "muted";
    default:
      return "muted";
  }
}

/** The full status pill: humanized label + semantic family class. */
export function statusPill(status: string): string {
  return `<span class="pill pill-${statusPillFamily(status)}">${escapeHtml(humanizeStatus(status))}</span>`;
}

/** Criterion status language (render-time only; unknown passes through). */
const CRITERION_LANGUAGE: Readonly<Record<string, string>> = {
  pending: "Not verified yet",
  verified: "Verified",
  failed: "Failed",
  unverified: "Unverified",
  waived_by_owner: "Waived by you",
};

export function humanizeCriterion(status: string): string {
  return Object.hasOwn(CRITERION_LANGUAGE, status)
    ? CRITERION_LANGUAGE[status]!
    : status;
}

// ------------------------------------------------------------ relative time

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function toDate(input: string | Date): Date {
  return input instanceof Date ? input : new Date(input);
}

/** "3:57 PM" in server-local time (12-hour clock, locale-independent). */
function clockTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

/**
 * Relative age for display: "just now" / "5m ago" / "2h ago" / "3d ago",
 * flipping at 7 days to a short local stamp ("Tue 3:57 PM"). Absolute ISO is
 * for title attributes only — callers pair this with `timeAttr`.
 */
export function relativeTime(input: string | Date, now: Date): string {
  const from = toDate(input);
  if (Number.isNaN(from.getTime())) return "";
  const seconds = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${WEEKDAYS[from.getDay()]} ${clockTime(from)}`;
}

/**
 * Absolute local time for detail pages: "Tue Oct 13, 3:57 PM" (server-local).
 */
export function formatLocalTime(input: string | Date): string {
  const d = toDate(input);
  if (Number.isNaN(d.getTime())) return "";
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${clockTime(d)}`;
}

/**
 * Machine-readable + hover-title attributes carrying the absolute ISO — the
 * only place ISO timestamps may appear (plan §1: ISO only in title attrs).
 */
export function timeAttr(iso: string): string {
  return `datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}"`;
}

// -------------------------------------------------------------- page chrome

export interface PageOptions {
  /** This request's UI path ("/ui", "/ui/delegate", "/ui/missions") — drives the nav's aria-current. */
  path?: string;
}

const NAV_ITEMS: readonly { href: string; label: string; matches: readonly string[] }[] = [
  { href: "/ui", label: "Today", matches: ["/ui"] },
  { href: "/ui/delegate", label: "Delegate", matches: ["/ui/delegate"] },
  { href: "/ui/missions", label: "Missions", matches: ["/ui/missions", "/ui/outcome"] },
];

/**
 * The shared page shell: sticky translucent blurred nav as a segmented
 * control with aria-current, safe-area padding, dark-mode tokens. No JS —
 * CSP stays `default-src 'none'`.
 */
export function page(body: string, opts: PageOptions = {}): string {
  const path = opts.path ?? "";
  const nav = NAV_ITEMS.map((item) => {
    const current = item.matches.includes(path);
    return (
      `<a href="${item.href}"${current ? ' aria-current="page"' : ""}>${item.label}</a>`
    );
  }).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${scriptTags()}
<title>Today</title>
<style>${UI_CSS}</style>
</head>
<body>
<nav class="top-nav"><div class="segmented">${nav}</div></nav>
<main data-main>
${body}
</main>
</body>
</html>`;
}

// -------------------------------------------------------------- empty state

/**
 * Calm empty state with an optional call-to-action button (e.g. Today-empty
 * → "Delegate something"; Missions-empty → "Create your first mission").
 */
export function emptyState(message: string, ctaLabel?: string, ctaHref?: string): string {
  const cta = ctaLabel !== undefined && ctaHref !== undefined
    ? `<a class="btn btn-primary" href="${escapeHtml(ctaHref)}">${escapeHtml(ctaLabel)}</a>`
    : "";
  return `<div class="empty"><p>${escapeHtml(message)}</p>${cta}</div>`;
}

// -------------------------------------------------------------- flash banner

/**
 * `?done=<action>` aftermath copy (plan Lane B §3 wording; U0 renders the
 * banner, the integration pass adds the redirects). Unknown actions → null:
 * never reflect arbitrary query input.
 */
const DONE_BANNER_TEXT: Readonly<Record<string, string>> = {
  resolve: "Resolved — that card is done and off your Today.",
  dismiss: "Dismissed — it won't come back on its own.",
  seen: "Marked seen — it stays on Today until you resolve it.",
  snooze: "Snoozed — it will come back at the time you picked.",
  feedback: "Thanks — your feedback was recorded.",
};

export function doneBannerText(action: string): string | null {
  return Object.hasOwn(DONE_BANNER_TEXT, action) ? DONE_BANNER_TEXT[action]! : null;
}

/** One dismissible confirmation banner (details-based; no JS to dismiss). */
export function flashBanner(text: string): string {
  return (
    `<details class="flash" open>` +
    `<summary aria-label="Dismiss this confirmation">✕</summary>` +
    `<p>${escapeHtml(text)}</p>` +
    `</details>`
  );
}

// ---------------------------------------------------------------- error page

export interface ErrorPageInput {
  /** Short, calm heading — never the raw status code. */
  heading: string;
  /** What happened, in one sentence. */
  what: string;
  /** The remedy — what the reader can do about it. */
  remedy: string;
  /** The way back (rendered as a button under the remedy). */
  backHref?: string;
  backLabel?: string;
  /** Raw HTML re-rendered under the remedy (e.g. the originating form for a CSRF retry). Escape at the call site. */
  formHtml?: string;
  /** Nav active-item path, when the error originates from a known surface. */
  navPath?: string;
}

/**
 * Remedy-oriented error page: what happened → what you can do → way back.
 * Dead ends are a bug (plan Lane A §3).
 */
export function errorPage(input: ErrorPageInput): string {
  const back = input.backHref !== undefined
    ? `<p class="error-form"><a class="btn btn-secondary" href="${escapeHtml(input.backHref)}">${escapeHtml(input.backLabel ?? "Go back")}</a></p>`
    : "";
  return page(
    `<h1>${escapeHtml(input.heading)}</h1>` +
      `<p class="error-what">${escapeHtml(input.what)}</p>` +
      `<div class="error-remedy"><p><strong>What you can do</strong>${escapeHtml(input.remedy)}</p></div>` +
      (input.formHtml ?? "") +
      back,
    { path: input.navPath },
  );
}
