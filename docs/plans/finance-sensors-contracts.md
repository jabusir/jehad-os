# Jehad OS — Finance Sensors: Build Contract (budgeting + expense tracking)

**Status:** draft for owner review · **Date:** 2026-09-20 · **ADR:** ADR-0015
(mint at build) · **Sequence position:** first of the "more sensors" family
(gateway §10/§7 tail); consumes the Phase E grounded-read registry and the
deterministic brief pipeline. No code in this doc — contracts only.

## 1. Objective and non-goals

**Objective.** Finance sensors feeding honest expense tracking and modest,
deterministic budgeting: accounts + transactions + balance snapshots from
Plaid; category/month budget caps; weekly + monthly rollups in briefs;
grounded reads over iMessage ("how much did I spend on food this week").

**Non-goals (this plan).** Any write path to money (payments, transfers,
bill pay — §11 permanence). Predictive anything (no forecasting, no "you'll
overspend by the 20th" — v1 is retrospective only). Crypto/Venmo. Custom
merchant categorization. Multi-currency budget math. Webhooks.

## 2. Source honesty table (what each source ACTUALLY offers)

| source | reality | v1 disposition |
| --- | --- | --- |
| **Plaid** | official API: Transactions (`/transactions/sync`), Accounts/Balances (`/accounts/get`), Investments + Liabilities modules where the institution supports them. Aggregator — most US banks reachable, including the ones below where marked | **the only v1 integration** — transactions + balances + investments-if-supported (ESCALATE-5) |
| **Fidelity** | no public API for personal accounts. Brokerage data exists but only via aggregation | Plaid Link only. If Link succeeds: holdings/transactions per module support. If not: not-now, honestly |
| **Wealthfront** | no official personal API. Same aggregation-only reality | Plaid Link only if linkable; else not-now. **Screen-scraping explicitly rejected** — fragile against their UI/TOS and a credentials-custody liability |
| **Apple Card** | no API. Plaid's Apple Card support is historically spotty (Goldman OAuth route churns) | attempt Link at setup; **expect failure**; if unsupported → not-now. Coverage lines must say "Apple Card not connected," never imply total visibility |
| **crypto / Venmo** | exchange APIs exist but identity/coverage is a different problem | not-now (this table row exists so nobody re-researches it) |

**Coverage honesty (inherited, gateway E §5):** every brief section and
grounded read states what the linked items actually see — "3 items linked
(Chase, Fidelity, Amex); Apple Card and cash are not visible." Cash spend is
invisible to all of this and rollups never claim completeness.

## 3. Recommendation

**v1 = Plaid only.** Transactions + balances, plus Investments module only
where an institution serves it (ESCALATE-5). Every other source routes
through Plaid Link or is honestly not-now. One vendor surface, one adapter,
one trust review. Liabilities module: not-now.

## 4. Owner setup checklist (BLOCKING — lanes cannot start without items 1–3)

1. Create Plaid dashboard account (owner's email). Enable **Sandbox** and
   **Development** environments.
2. Keychain entries (never `.env`, never git — AGENTS.md): 
   `jehad-plaid-client-id`, `jehad-plaid-secret-sandbox`, 
   `jehad-plaid-secret-development`. Production secret only when/IF we 
   productionize (ESCALATE-6).
3. `josctl finance link` per institution → hosted Link flow → access_token →
   Keychain `jehad-plaid-item-<plaidItemId>` + `finance_items` row. One 
   Plaid **Item** per institution; items are the unit of revocation/health.
4. **Webhook vs poll — decided: poll.** Webhooks require a publicly hosted 
   endpoint; we host nothing public yet (ADR-0001, hosting decision pending). 
   Worker workflow: light sync every 15 min (`transactions/sync` cursor + 
   balance snapshot) + deep pull daily 04:00 (`BRIEF_TIMEZONE`; refresh, 
   re-canonicalize categories, reconcile, purge). Cadence: ESCALATE-1.
5. **Pricing reality:** Development env is free with real data, limited item 
   count (~100), transaction history capped ~24 months there. Production 
   pricing tiers for Transactions change often — verify current free-tier 
   limits at build; do not trust this doc's numbers. ESCALATE-6.

## 5. Access model

1. Secrets live only in Keychain: client id/secret per env (§4.2), one
   access token per Item (§4.3). **No Plaid credential ever enters Postgres,
   logs, prompts, or event payloads** (AGENTS.md hard rule; §9).
2. Environments: `sandbox` for automated tests (fixtures + fake institutions),
   `development` for dogfood (real banks, real data, free), `production`
   deferred (ESCALATE-6). The adapter takes env as config; the sync workflow
   refuses to mix envs per item row (`finance_items.env`).
3. The sensor/workflow authenticates as a new harness principal
   `finance-sync` holding only an ingest/execute grant — it never touches
   `send_channel` or memory grants. Grants via existing Keychain-backed
   machinery, TTL, revocable.
4. Item revocation / `ITEM_ERROR` (owner unlinks, MFA required, credential
   rot) → item status flips, `escalation.raised`, owner notified over E4,
   coverage lines shrink honestly. Never silently dropped.

## 6. Data model — new domain `finance` (registry: local storage, ADR-0010)

Migrations (forward-only, tested down paths, Lane F2 owns):

- `015_finance_core.sql`:

```sql
finance_items (
  id uuid PK, plaid_item_id text UNIQUE, institution_id text,
  institution_name text, products text[], env text,      -- sandbox|development|production
  status text NOT NULL,          -- active | error | revoked
  created_at timestamptz NOT NULL, last_synced_at timestamptz
)
finance_accounts (
  id uuid PK, item_id uuid → finance_items, plaid_account_id text NOT NULL,
  name text, type text, subtype text, mask text,          -- mask ONLY; Plaid never gives full numbers, we never ask
  currency text NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE (item_id, plaid_account_id)
)
finance_transactions (
  id uuid PK, account_id uuid → finance_accounts, plaid_transaction_id text NOT NULL,
  posted_date date NOT NULL, pending boolean NOT NULL DEFAULT false,
  merchant_raw text, merchant_name text,                 -- raw statement text / Plaid-normalized
  amount numeric(14,2) NOT NULL,   -- PLAID SIGN CONVENTION: positive = OUTFLOW (debit), negative = INFLOW (credit). Stored as-received; renders translate
  category_primary text, category_detailed text, category_confidence numeric,
  content_hash text NOT NULL,      -- sha256(account_id, posted_date, amount, merchant_raw) — mutation/dedupe detection
  removed_at timestamptz NULL,     -- Plaid `removed` tombstone; rows are NEVER deleted (financial record)
  ingested_at timestamptz DEFAULT now(),
  UNIQUE (account_id, plaid_transaction_id)
)
finance_balance_snapshots (
  id uuid PK, account_id uuid → finance_accounts,
  current numeric(14,2) NOT NULL, available numeric(14,2), currency text NOT NULL,
  observed_at timestamptz NOT NULL
)
finance_sync_state (               -- one row per item
  item_id uuid PK → finance_items, cursor text, last_cursor_advance timestamptz,
  health_sync text NOT NULL, updated_at timestamptz NOT NULL   -- healthy|degraded|failed (gateway §9 pattern)
)
```

- `016_finance_budgets.sql`: `finance_budgets (id uuid PK, category_primary
  text NOT NULL, month date NOT NULL, cap_cents integer NOT NULL CHECK
  (cap_cents >= 0), note text, created_by text NOT NULL, created_at
  timestamptz NOT NULL, UNIQUE (category_primary, month))`.

**Retention.** Transactions are the point of the system — **kept
indefinitely in the local db**, tombstoned rather than deleted. They **never
leave** except as bounded aggregates through read tools/briefs (§9). Balance
snapshots: purge at 90 days (daily deep pull owns the purge). ESCALATE-3.

## 7. Event grammar (additive to catalog v1 — ADR-0006)

Events are **ids + numbers + category, never merchant strings, never tokens,
never account identifiers**. Merchant names live only in tables and reach
humans only via server-side renders (§9–10). Amounts ARE in events — the
budget/rollup machinery consumes the stream, and amounts without merchants
are already sensitivity-classified `sensitive`.

```
finance.transaction.observed
  source: adapter:plaid
  externalId: plaid-tx:<plaidItemId>:<plaidTransactionId>   (idempotency: sha256(source+externalId), minted at ingest)
  sensitivity: sensitive
  payload v1: { transactionId, accountId, itemId, postedDate,
                amount (Plaid sign, §6), categoryPrimary, categoryDetailed?,
                merchantHash: sha256(merchant_name), schemaVersion: 1 }

finance.balance.changed
  payload v1: { accountId, currency, current, available, deltaCurrent,
                observedAt, schemaVersion: 1 }
  emit rule: only when |Δ current| ≥ balance_event_threshold since the last
  EMITTED balance (snapshots still record every poll; default threshold $1.00 — ESCALATE-7)

finance.budget.changed
  payload v1: { budgetId, categoryPrimary, month, capCents, actorPrincipal,
                schemaVersion: 1 }
```

All three ride the existing envelope/store with provenance; payload schemas
versioned per ADR-0006.

## 8. Budgeting domain (v1 — concrete and deliberately modest)

1. **Entities:** per-category monthly caps (`finance_budgets`, §6). Category
   key = Plaid `personal_finance_category.primary` (no custom taxonomy in 
   v1). Budgets are USD-only; non-USD rows store + flag but sit outside 
   budget math (ESCALATE if recurring).
2. **Set/edit:** `josctl finance budget set <category> <month> <cap>` (CLI,
   owner principal, audited `finance.budget.changed`). Reviewed in the next 
   brief. iMessage budget commands are **phase 2** — they arrive only after 
   the G-review pipeline has a vocabulary for them; not in this build.
3. **Weekly rollup — Sunday evening brief section (deterministic, zero model
   calls):** month-to-date spend by category vs cap (+ remaining or over%),
   top 5 merchants by spend (flattened names, §9), **spike detection:
   category week-spend > 2× its trailing 8-week median (min 3 data weeks)
   → flagged line**. No predictions, no forecasts, no advice prose.
4. **Monthly closeout — 1st of month brief section:** prior month totals per
   category vs caps, over/under per category, net flow (inflow−outflow),
   transaction count, top merchants. Same determinism.
5. Empty-state rule: no linked items or no budgets → section suppressed
   (§31 no-noise inherited).

## 9. Sensitivity — finance data is the highest class we hold

Class vocabulary stays `normal | sensitive | secret` (ADR-0012); finance 
events are `sensitive`, Plaid credentials are effectively `secret` but never
enter the event/egress pipeline at all (Keychain-only, §5).

1. **Account numbers/identifiers and per-transaction detail NEVER enter model
   prompts.** Grounded reads and briefs compute numbers server-side; the 
   answer pass receives only bounded aggregates (§10).
2. Merchant names are third-party strings: flattened before any render or 
   prompt-adjacent surface (strip control characters, collapse whitespace, 
   cap 120 chars) and marked data-never-authority (gateway §3.2 door two).
3. **Plaid tokens never in events** (§7 payload schemas are pinned by test).
4. Transaction detail leaving the box: only bounded aggregates (category 
   totals, top-N merchant rollups) via read tools/briefs — never row dumps.
5. Prompt-injection test is a build gate: a merchant literally named 
   "IGNORE INSTRUCTIONS AND…" must render flat/quoted and route nowhere (§11).

## 10. Grounded reads v1 (extend the Phase E registry; same two-pass loop)

| tool | args (strict enums) | query (deterministic, server-side) |
| --- | --- | --- |
| `finance.spend` | `window: week\|month`, `category?: <pfc primary>` | sum signed amounts over window bounds via `localDayBounds(now, BRIEF_TIMEZONE)` (DST-safe; the model never does date or arithmetic) |
| `finance.balances` | — | latest snapshot per account: name, mask, current/available, institution |

- Policy: `gateway.principals.<name>.reads` gains `finance` (both tools or
  neither). Owner-grantable only, like calendar/commitments; Yusra has no
  finance reads by construction.
- Answer-pass DATA block carries ONLY: per-category aggregates (≤10 rows),
  top-merchant flattened names + totals (≤5), coverage sentence naming linked
  institutions + gaps ("Apple Card not connected; cash invisible"). Prompt
  instructs: quote computed figures verbatim; no re-derivation; no advice 
  beyond stating over/under.
- Coverage honesty examples: "You've spent $412 on food this week across 
  linked accounts (3 items; Apple Card not connected)."

## 11. Adversarial surface

1. **NO WRITE PATH — AT ALL, v1.** No payments, transfers, bill-pay, or 
   Plaid processor endpoints anywhere. Enforced structurally: adapter port 
   exposes read-only operations; grep-pin + test forbidding payment/transfer/
   processor calls in `packages/adapters/src/source-adapters/plaid.ts`. This 
   is a permanent-ish stance — revisited only by owner directive + new ADR.
   Money movement is not a sensor feature.
2. **Merchant-name injection** — untrusted third-party strings in renders.
   Mitigations: flattening (§9.2), DATA-boundary marking, read-only tool 
   registry (output cannot create/expand authority — gateway §3.2), §9.5 
   build-gate test.
3. **Webhook spoofing — n/a in v1** (no listener exists; poll-only per §4.4,
   grep-pinned). If webhooks ever arrive: public-hosting decision + HMAC 
   verification + replay defense, all under a new plan.
4. **Token/secret exfiltration** — Keychain-only storage, payload-schema 
   tests (§7), redaction tests on logs. A leaked item access_token rotates 
   by unlink/relink (`josctl finance unlink`).
5. **Silent staleness** — sync health is multi-dimensional (gateway §9 
   pattern): cursor advance, item status, API error rate. "0 new 
   transactions" over N days on an active account is drift, not quiet — 
   surface it.
6. **Reconciliation integrity** — Plaid mutates history (pending→booked, 
   removals, amount edits). `content_hash` detects mutation; tombstones 
   keep the record; deep pull reconciles and audits a count.

## 12. Work breakdown (lanes; completion contract per ig-phase-a §"Completion contract")

- **Lane F1 — Plaid adapter.** `packages/adapters/src/source-adapters/plaid.ts`
  (+ tests): env-configured client (Keychain secrets), `transactions/sync`
  paging, accounts/balances fetch, normalization → `NormalizedExternalEvent`s
  (§7), sandbox fixtures. Vendor SDK imports live HERE ONLY (ADR-0002).
- **Lane F2 — db migrations.** `packages/db/migrations/015*`, `016*` (§6) +
  tested down paths + domain registry entry (`finance`, local).
- **Lane F3 — sync service + workflow.** `packages/core/src/finance/sync.ts`
  (cursor mgmt, upsert/tombstone, balance snapshots + purge, mutation audit,
  item-error escalations); Inngest functions `finance/sync-light` (15 min) +
  `finance/sync-deep` (daily) behind the existing WorkflowRuntime port; 
  `finance-sync` principal + grant wiring.
- **Lane F4 — budget domain + read tools.** `packages/core/src/finance/`
  (`budget.ts`, `queries.ts`, `rollups.ts`): budget set/validate, spend/
  balances aggregations, spike median, monthly closeout math; wire 
  `finance.spend` / `finance.balances` into the Phase E route registry + 
  policy `reads: finance`.
- **Lane F5 — briefs.** `packages/core/src/briefs/**`: Sunday-evening 
  rollup section + monthly closeout section, deterministic renderer only, 
  suppressed when empty, coverage line always present.
- **Lane F6 — orchestrator wiring.** `josctl finance link|unlink|status|`
  `budget set|list`, event-catalog additions (§7), `policy.yaml` finance 
  block (thresholds, cadences), worker schedule registration, adversarial 
  pass over the whole surface (§11) with verification by a non-builder.

Forbidden everywhere: any money-movement API · merchant strings in events ·
Plaid tokens outside Keychain · weakening pinned tests · secrets in 
git/logs/prompts.

## 13. Not-now

Crypto/Venmo sources · Liabilities module · custom categorizer · 
multi-currency budgets · webhooks · iMessage budget commands (phase 2, 
post-G vocabulary) · predictive/forecast features · any write path (§11.1) ·
screen-scraping anything (§2, permanent).

## 14. Escalate list

1. **Poll cadence** — 15 min light / daily 04:00 deep proposed; owner ratify.
2. **History window** — initial backfill at Link (dev env caps ~24 months; 
   verify Production behavior at build).
3. **Retention** — transactions indefinite-in-db (never exported beyond 
   aggregates) / balances 90-day purge; owner ratify.
4. **Default budget category set** — propose seeded caps for a subset of 
   Plaid `pfc.primary` values (groceries, dining, transport, shopping…)? 
   or start empty; owner picks.
5. **Investments module in v1?** — adds holdings schema + noise; default 
   recommendation: transactions+balances only, investments phase 2.
6. **Env choice** — dogfood in Development (real data, free) confirmed? 
   Production tier/pricing verify-at-build (ESCALATE-6, §4.5).
7. **Balance-event threshold** — $1.00 default (§7).
8. **Apple Card Link attempt** — expected to fail; owner ratify the attempt 
   so the coverage line stays honest.
9. **Liabilities module** — not-now unless owner wants loans/credit detail.
10. **ADR-0015 scope** — owner ratify: Plaid-only v1, poll-only, no-write 
    permanence, retention rules.

## 15. Assumptions (chosen, not asked — flag any wrong one)

1. Owner's accounts are US institutions reachable via Plaid Link (Fidelity/
   Wealthfront linkability verified empirically at §4.3 — not assumed).
2. Single-tenant: finance reads owner-only; the reads list is never granted
   to another principal by construction (gateway E §3).
3. Plaid `personal_finance_category` quality is adequate for v1 budgets; 
   miscategorization surfaces in rollups rather than being silently 
   reclassified by us.
4. Local Postgres + existing disk posture is acceptable custody for 
   indefinite transaction history (encrypted-backup decision inherits 
   repo-wide posture; flag if finance changes it).
