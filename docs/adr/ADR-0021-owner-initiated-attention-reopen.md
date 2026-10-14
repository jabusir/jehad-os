# ADR-0021 — Owner-initiated attention reopen (undo for resolve/dismiss)

Date: 2026-10-13
Status: Accepted
Waves: U1 (Today UX overhaul, `docs/plans/today-ux-overhaul.md` §3 Lane B)
Supersedes: nothing. Extends ADR-0018 (attention semantics); constrains
ADR-0019 surfaces.

## Context

Dismiss and Resolve are one-tap terminal actions on an attention item; a
mis-tap silently drops a live condition off the owner's action list. Calm-UX
practice (Apple HIG: undo over confirmation) is to make terminal actions
reversible instead of stacking confirmation dialogs in front of every close.
The data already supports reversibility: resolve + dismiss stamp
`resolved_at` / `resolved_by` / `resolution_reason` (no migration needed), and
the three-branch producer write (ADR-0018 §1.3) already proves a terminal row
can honestly return to `open`.

The producer-side reopen is NOT owner undo: it fires on a new producer
occurrence of a recurring condition and re-delivers (`deliverNow: true`,
`bumpOrReopen` in `attention/service.ts`). Owner undo is a different actor
with different intent, and must not re-push.

## Decision

1. **Owner-only, windowed reopen.** `reopenAttentionByOwner` (attention
   service) is legal ONLY when ALL of the following hold:
   - state ∈ {`resolved`, `dismissed`} — the terminal states;
   - `resolved_by = 'owner'` — producer/liveness/system closes are machine
     truth; owner undo never overrides them;
   - `resolved_at` within the last 24h — a bounded undo; beyond the window a
     closure is history (a recurring condition re-opens naturally via the
     producer path).

   On success: state → `open`; `resolved_at` / `resolved_by` /
   `resolution_reason` cleared; `first_raised_at` and `occurrences` untouched
   — undo is not a new occurrence (§1.3 counts producer occurrences only).

2. **Additive event `attention.item.reopened`** — catalog v1 member 43, pin
   bumped 42 → 43 (`catalog.test.ts` is the runtime build blocker; ADR-0006
   additive-only discipline, schemaVersion stays 1). Content-free payload in
   the W1 family style: ids + `priorState`; item text lives only on the row.

3. **Dedicated non-registry endpoint `POST /ui/reopen`** — deliberately NOT an
   actions-registry key (ADR-0018 §1.6 reasoning):
   - Registry keys are typed refs the PRODUCER stores on a row. Reopen is an
     owner-UI affordance; making it a registry key would let any producer
     store it — and thereby pre-authorize it — on rows. That must never be
     producer-storable.
   - `/ui/action`'s ownership gate is the `listOpenAttention` open-set
     (`open`/`seen`/`snoozed`) — it excludes the terminal states undo must
     reach, by design. Reopen needs its own principal-scoped fetch, failing
     closed the same way: unknown/foreign item → 404, indistinguishable.

4. **NO PUSH.** Owner reopen mints NO notification and enqueues NO delivery —
   `reopenAttentionByOwner` never calls `deliverOutcomeAttentionNow` /
   `notifyAttentionItem`. The owner is standing in the UI when they undo; a
   push would reach a person who just demonstrated they are present. Contrast:
   the producer-side reopen carries `deliverNow: true` because the owner is
   (presumably) away when recurrence news arrives. Acceptance test: ZERO rows
   in `notifications` (`kind='attention'`, `source_id` = item id) after a
   legal reopen.

5. **Fail-closed everything.** Unknown/foreign item → null → 404; illegal
   reopen (non-terminal state, non-owner close, expired window) → typed
   `AttentionReopenError` surfaced as a 400 inline-remedy page; session + CSRF
   handling identical to `/ui/action` (401 / 403 / 404 matrix).

## Consequences

- Snooze presets ride a sibling `POST /ui/snooze` for the same family of
  reasons: `/ui/action`'s `storedActionMatches` gate 403s non-stored args by
  design, and preset minutes are chosen at submit time, never stored by
  producers. Token → minutes translation happens at POST time, server-local,
  per the shared map (overhaul plan §2); the <30-min evening roll to next-day
  20:00 is a snooze-floor artifact of that endpoint only — deadlines (U2)
  never roll.
- `/ui/action` success redirects append `?done=<key>` so the U0 flash banner
  can name the aftermath (and destructive closes carry an inline Undo form to
  `/ui/reopen` — Lane A render, this ADR's canonical contract).
- GC interplay: terminal rows purge at 30d (ADR-0018 §4), far beyond the 24h
  undo window — no retention change.
- Event consumers see exactly one new type; additive per ADR-0006, no
  replay/reindex obligations.
