# ADR-0018 — Watch and AttentionItem: durable loop-closing objects

- **Status:** ratified by owner (2026-10-11, with the product-reset plan
  `docs/plans/product-reset-watch-attention.md`). Decides the semantics of the
  two first-class objects the product reset adds.
- **Complements:** ADR-0008 (Postgres owns state), ADR-0011 (action
  intents/attempts), ADR-0013 (authorization invariant), ADR-0016 (gmail
  content boundaries), ADR-0017 (typed predicates). No prior ADR superseded.
- **Related:** product-reset plan §4–§12, §16; delegate-watch-roadmap §5.5/§6.

## 1. Decisions

### 1.1 Attention is a durable open set; delivery is a best-effort projection

`attention_items` is the canonical record of things waiting on the owner.
Delivery (iMessage today) is a projection: `last_delivered_at` is stamped only
on a successful channel accept; a failed or expired push never mutates or
deletes the item. The UI renders from items, never from push history. "seen"
≠ "resolved"; snooze is explicit state (`snoozed_until`), never a hidden timer.

### 1.2 Items require attention by construction

Item `level ∈ {inbox, digest, interrupt}` — there is **no `silent` item**. If
something requires no attention it is not an AttentionItem: silent watch
matches record `watch.triggered` events and match state on the watch row only.
Completed outcomes open no item (the brief "resolved" section is their
channel); no item auto-resolves because a brief rendered.

### 1.3 One open item per condition: three-branch write

Identity is `UNIQUE (principal_id, source_type, source_object_id,
fingerprint)`. The write is a read-modify-write in one transaction, branching
on pre-write state: no-row → insert and deliver; open → bump (occurrences++,
refresh text, no re-delivery unless meaningful change); closed → reopen
(preserve `first_raised_at`) and deliver. Duplicate source events collapse
into one row.

### 1.4 Meaningful change is the producer-supplied occurrence identity

`change_fingerprint` is keyed to the underlying occurrence id (gmail
messageId; home entity_id + last_changed; outcome id + status), never to the
rendered text and never to the event row id. Re-delivery on bump happens only
when this differs from the stored value or the level rose: ten replays of one
event do not re-notify; a second genuinely different occurrence that renders
identically does.

### 1.5 Match records are events; watch items are occurrence-news

Each watch match emits `watch.triggered` with `externalId
watch:<watchId>:<sourceEventRowId>`; `acceptEvent`'s idempotency-key dedupe is
the match record, committed in the same transaction as its attention write (a
no-op replay proves the whole step committed). Watch match items are
occurrence-news, not held conditions: **watch satisfaction never closes an
item**; owner ack or watch `cancelled` closes the watch's outstanding items;
the watch liveness resolver returns `gone` only for `cancelled`. Watch system
items (`missed_evidence`, `scan_gap`) close on owner ack or `cancelled` only —
never on a later terminal status, which would silently swallow the blindness
they exist to surface.

### 1.6 Actions are registry-backed, never persisted endpoints

Items store only typed `{key, args}` pairs. A server-side action registry maps
keys to handlers bound to producer-owned, principal-authorized routes with
per-action argument validators. No endpoint strings or URLs are stored in or
rendered from item rows.

### 1.7 Salience is deterministic and fails open

Level comes from owner-declared policy; safety class forces `interrupt` and
bypasses quiet hours and cooldown; quiet hours (22:00–07:00 PT) defer
inbox/digest delivery without dropping it; cooldown suppresses re-delivery,
not bumps. Every suppression gate fails toward delivering — the durable item
bounds the worst case at one duplicate push, never a lost issue.

### 1.8 Watches: typed predicates, owner-only creation, principal-scoped refs

`watches` (reserved migration 025) carries a closed, versioned, non-executable
predicate vocabulary (ADR-0017 §1.2 discipline; unknown fields rejected, never
coerced). Creation authority is the owner (UI/API/CLI) — never chat, never
model output, never email content. Human-typed refs are
`UNIQUE (principal_id, ref)`, 4-char Crockford, mint-once. Match evidence is
ids/refs only, validated against the actual candidate set.

### 1.9 W1–W6 contain zero model calls

Semantic (model-assisted) watches are deferred behind a post-dogfood gate
(plan W7): classification is data, never authority, and the deterministic
product must prove itself first.

## 2. Migration 025: reserved-number landing, proven empirically (W0)

`025_watches.sql` lands after 026–028 were written. Proven 2026-10-11 on
scratch databases, exactly as plan §16 requires:

1. **Late-apply at state 028** (fresh DB built without 025, then real dir):
   applies exactly `025_watches` — clean; watches table created; checksum
   recorded.
2. **Down + re-up round-trip**: `down --to 024_outcomes` rolls back
   028/027/026/025 cleanly (watches dropped); re-`up` re-applies 025 in
   lexical position — clean.
3. **Fresh full lexical run** (000…028 with 025 present): 29 migrations clean.
4. **Checksum tamper**: a modified 025 against an applied DB throws the
   runner's hard error (`applied with a different checksum`).

**Proven draft sha256 (binding):**
`de9c179cd742862d544e5026afdfee9728864368e734d94694c1af920ef5eafc`.
The committed file must hash to exactly this value; a W1 round-trip test
asserts it.

## 3. Live-database bookkeeping reconciliation (W0 finding)

The live `jehad` database's schema was hand-synced past its
`schema_migrations` bookkeeping during D0–D3 (pre-existing, unrelated to this
plan): the recorded `024_outcomes` checksum predates later tranches that
edited the file, and 026/028 were never recorded although their schema is
fully present. This blocked *any* `migrate up` on live. W0 proved the repair
on a pg_dump copy of live: fix the 024 checksum row to the current file's
hash, insert 026/028 rows with their current checksums, apply 025 — the
resulting schema is **byte-identical** (pg_dump diff) to a canonical fresh
000…028+025 build. The same reconciliation is applied to live at W1 deploy,
before `migrate up`.

## 4. Consequences

- Notifications gain one `attention` kind (CHECK widening, auto-approved
  owner-directed like `brief`; never rides the reply conjunction).
- Outcome transitions `waiting_user | blocked | failed` produce attention
  in-transaction via a producer hook in `transitionOutcome`; `completed`
  produces none.
- A `attention-liveness` sweep is the resolver backstop (producer closes are
  primary; resolvers return live/gone/unknown; unknown never closes).
- Terminal item rows are retained 30 days for metrics, then purged; open rows
  are never age-deleted.
