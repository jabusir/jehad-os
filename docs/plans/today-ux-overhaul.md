# Today control panel — UX overhaul plan

Status: READY FOR BUILD — plan-review loop concurrence (turn 13); claims verified against main @ 7217fb3, 2026-10-13
Waves: U0–U4 (executed as parallel lanes A–D; integration + U4 sequential)
Owner surfaces: `https://jejos-mac-mini.taild8be04.ts.net/ui*`

## 0. Objective + invariants

> Opening Today on my phone feels like opening a native app designed by someone
> who respects my attention. Every tap lands somewhere obvious, every action
> confirms itself calmly, and nothing makes me think about the database.

Invariants (ADR-0018/0019/W1.2): principal-scoped + fail-closed; session + CSRF
on every state-changing POST; principal never from a form; output escaped; API
localhost-only; Serve-only transport; no Funnel; no model calls, no chat, no
intent inference; canonical system stays the source of truth.

Research basis (compressed): Nielsen's 10 heuristics (fetched 2026-10-13 — the
audit below is a heuristic evaluation); Apple HIG iOS (44pt targets, undo over
confirmation, grouped inset lists, dark mode, safe-area, segmented controls);
Material 3 (48dp, semantic color only); GOV.UK (field-level remedies); calm
technology. Prior art: Things 3 (calm lists), Reminders/Clear (row actions +
undo), Linear (optimistic speed), Superhuman (<100ms feel), Todoist (deadline
quick-picks), iOS Settings (inset-grouped vocabulary). Audit findings A1–A13 in
the reviewed working copy (`.review/today-ux-overhaul/plan.md`) — form-spam
buttons, reload-per-action, no undo, raw enums/ISO timestamps, dead-end errors,
tax-form delegate, no dark mode/active nav/CTAs, read-only outcome detail, no
app identity, submit-only validation.

## 1. Design direction — "the calm mission control"

- Tokens: system font stack; 17px base / 15px secondary / 13px captions;
  large-title headers; 8pt grid; inset-grouped cards (12px radius, hairline
  borders); light/dark via `prefers-color-scheme`; one accent + semantic red
  (destructive) + green (completed); contrast ≥ 4.5:1; 150–200ms ease-out,
  `prefers-reduced-motion` disables; sticky translucent nav with blur,
  segmented control with `aria-current`, `env(safe-area-inset-*)`.
- Language map (render-time only, canonical values untouched):
  `waiting_user → "Waiting for you"`, `blocked → "Blocked"`,
  accepted/queued/running/waiting_external → "In motion" variants,
  `verifying → "Verifying"`, completed/failed/cancelled → "Done/Failed/
  Cancelled". Relative times everywhere; ISO only in `title` attributes.

## 2. Shared time-token map (defined ONCE; U1 snooze + U2 deadlines)

`evening`/Tonight = 20:00 server-local. `tomorrow` = 09:00 next server-local
day. `Next week` = 09:00 +7d (deadline side only). The <30-min roll to the next
day's 20:00 is a **snooze-floor artifact**: applies ONLY to `/ui/snooze` token
translation (snooze floor 5 min, ceiling 4320 min verified
`ui.ts:405`/`attention.ts:93`); deadlines have no floor (route rule is only
"must be in the future", `ui.ts:516`) so the roll never applies there. Same
words → same target hour on both surfaces; hours owner-tunable at U4, pinned
here so code never chooses silently. All interpretation is **server-local**
(the existing route already parses `datetime-local` server-local).

## 3. Waves → lanes

### Lane A — U0 Foundations (no ADR, no JS)

1. Rewrite `page()` CSS: tokens §1, dark mode, sticky segmented nav, safe-area.
2. Language map + relative times in Today, Missions, outcome detail.
3. Error pages: what happened → remedy → way back (CSRF failures re-render the
   originating form with an inline banner; never a dead end).
4. Empty states with CTAs (Today-empty → "Delegate something"; Missions-empty →
   "Create your first mission").
5. Outcome detail: local times, status pill, link back to Missions.

**Accept:** existing suites green (CSP string unchanged); no JS; <60KB/page.

### Lane B — U1 Action UX (ADR-0021 first)

0. **ADR-0021 owner-initiated attention reopen** (docs/adr/ — next free number;
   covers: owner-only reopen from terminal states, 24h legality window from
   `resolved_at`, additive `attention.item.reopened`, non-registry dedicated
   endpoint per ADR-0018 §1.6, and the no-push decision below).
1. **Undo (the only canonical addition)**:
   - Event: `attention.item.reopened` in `packages/core/src/events/catalog.ts`;
     **bump catalog pin `catalog.test.ts` 42 → 43** (runtime build blocker).
   - Service: `reopenAttentionByOwner` (distinct from producer-side
     bump/wake) — legal only from `resolved`/`dismissed` with
     `resolved_by = 'owner'`, within 24h of `resolved_at` (columns exist; both
     resolve+dismiss stamp them → no migration). Reopen → `open`, clears
     resolution columns, records the event with `user:<name>` provenance.
     Producer-resolved items never reopen.
   - **No delivery**: reopen mints NO notification/delivery row — never calls
     `deliverOutcomeAttentionNow` (producer-side reopen uses `deliverNow: true`,
     verified `attention/service.ts` — owner undo must not mimic it). This is
     an ADR-0021 decision with a named-call acceptance test.
   - Route: dedicated `POST /ui/reopen` (session + CSRF; principal-scoped
     fetch by item id). NOT in `actions-registry.ts` — registry keys are
     producer-stored row refs and reopen must never be producer-storable;
     `/ui/action`'s ownership gate (`listOpenAttention` open-set) excludes the
     terminal states undo must reach.
2. **Card action bar**: primary filled button (context-aware) + `⋯` sheet
   (`details`-based, no JS): Snooze presets (1h / This evening / Tomorrow /
   Pick…), Feedback pills, Dismiss in red at the end. Presets submit tokens
   translated to minutes at POST time (shared map §2; a translation outside
   5..4320 fails to the U0 inline-remedy page). Presets ride a dedicated
   `POST /ui/snooze` (session + CSRF; same `listOpenAttention` ownership fetch)
   — `/ui/action`'s `storedActionMatches` gate 403s non-stored args by design;
   producer-stored snooze actions keep working.
3. **Flash feedback (no JS)**: actions redirect `?done=<action>` → one
   dismissible banner naming the aftermath; destructive actions carry an inline
   Undo POST form to `/ui/reopen` (works JS-less; toast wording arrives in D).
4. **Outcome detail controls**: dedicated POST route (session + CSRF,
   principal-scoped via `getOutcomeByRef`), legality from the outcome service's
   own state guards (`setCriterionStatus` legal statuses, wait transitions) —
   only guard-legal owner paths; fail-closed. Any descriptor table is a
   render-time label table, never an authorization gate.

**Accept:** ADR-0021 before the catalog change; pin 42→43 asserted; undo
round-trip tests (legal window, expiry, non-terminal, producer-resolved,
owner provenance, **zero delivery rows minted**); fail-closed route tests for
BOTH new POSTs (401 no-session / 403 bad CSRF / 404 foreign item, matching
`/ui/action` suite codes); `/ui/action` still 403s non-stored snooze args;
sheet/destructive-separation asserted in card tests.

### Lane C — U2 Delegate form

1. Single grouped card; real labels + helper lines ("Done means — How will you
   judge this? You verify it later."; constraints as "Limits — Rules the
   executor must respect."); criteria AND constraints: 3 visible + "Add
   another" (server renders 4 in DOM; D reveals extras).
2. Deadline quick-picks: radio (None / Tonight / Tomorrow / Next week / Custom)
   → shared map §2, server-local; past-valued picks render disabled; Custom
   reveals `datetime-local` with a server-local helper line.
3. Policy context inline: "N of 3 mission slots used"; at cap render the notice
   before submit (prevent, don't reject).
4. Submit: "Delegate — an executor starts immediately." Success → redirect
   `/ui/missions?created=REF` with one highlight pulse (no confirmation page).
5. Inline field-level validation with remedies, values preserved (never a bare
   400 page).

**Accept:** quick-pick→canonical deadline mapping tests; cap pre-vention;
redrive-preserves-input; on-device dictation (U4).

### Lane D — U3 Speed-of-feel (ADR-0022 amends ADR-0019)

1. One inline vanilla script (~10–15KB, no framework, template literal in the
   API). CSP becomes exactly: `default-src 'none'; script-src 'sha256-<hash>';
   style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action
   'self'; base-uri 'none'` — hash pinned in the same module that serves the
   script, fails closed on drift; `connect-src` required for fetch-on-focus,
   `img-src` for the icon. Header test pins the full string.
2. Enhancements only (each degrades to A/C server behavior): optimistic action
   buttons (disable + spinner; server authoritative); undo toast → `/ui/reopen`;
   refresh-on-focus (`visibilitychange` fetch + main-region swap); delegate
   extras reveal + character hints.
3. App identity: `/ui/icon.svg` from the API + `apple-touch-icon` + minimal
   web-app meta. No manifest/service worker.

**Accept:** CSP-hash tests; script-stripped parity tests; security review
section in ADR-0022 (static script, data stays escaped).

### U4 — Dogfood polish + sign-off (sequential, after merge)

Thumb reach (bottom-nav variant if verdict), dictation on every field, a11y
(aria-current, aria-live, focus-visible, contrast, VoiceOver), <100KB/page,
zero external requests, then re-run the W1.2 live acceptance + owner verdict;
sign-off in `docs/deploy/`.

## 4. Test strategy

Existing escape/CSRF/principal suites are the security regression net — green
always. New: language-map units; undo round-trip; flash banners; quick-pick and
snooze token mapping (floor/ceiling + inline remedy); CSP-hash drift fails
closed; no-JS parity; golden HTML snapshots for page chrome.

## 5. Non-goals

No SPA, framework, build toolchain, external assets/fonts/analytics, push, new
auth surface, Watches/cognition/model work; no canonical-semantics change
beyond `attention.item.reopened`.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| CSP hash breakage | Hash + script in one module; build-time header==sha256 test |
| Undo reversibility | Additive audited event; 24h; owner-resolved only; never touches outcomes |
| Clever CSS interactions | `details`-based; JS-free paths stay boring |
| Gold-plating | Wave acceptance gates; polish only in U4 |
| Word-hours feel wrong | Pinned in §2; owner-tunable at U4, one place to change |
