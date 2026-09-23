# Threat Model

- **Status:** Phase 0 artifact (derived; not yet implementation)
- **Derived from:** plan §11 (top set — this doc is the full matrix it defers
  to), plan §13 (acceptance tests), plan §15 (milestone acceptance), plan §9
  (policy model), plan §10 (domain boundaries); review §24 (T11–T16
  originated there), review §25 (additional acceptance tests); cleanup §3
  (opaque/federated semantics); directive §26 (security architecture),
  §36 (threat model requirements), §40 (test items 11/14/15/19).
- **Companion docs:** `docs/policy-model.md` (mitigation mechanics),
  `docs/domain-boundaries.md` (domain isolation).
- **Citation convention (same as plan):** bare `§N` = directive section;
  `plan §N` = `docs/plans/phase0.md` (canonical, rev 3); `review §N` =
  `docs/reviews/phase0-external-review.md`; `cleanup §N` =
  `docs/reviews/phase0-final-cleanup.md`. `§40 item N` = item N of
  directive §40's numbered list.

---

## 1. Assets and trust zones

Assets at risk: canonical PostgreSQL state; secrets and credentials; domain
content (employer/work content above all — §4.3); the event stream; the audit
trail; money; and human attention (the scarcest resource — plan §3, §28).

Trust zones per §26.1 — mitigations below assume this separation:

```text
UNTRUSTED INPUT (web, email, Slack/chat, external documents, user files)
    ↓ extraction / sanitization
TRUSTED REASONING
    ↓ proposal
ACTION LAYER
    ↓ policy / approval
HIGH-RISK ACTIONS (production, money, contracts, credentials,
                   irreversible communications)
```

Design stance (plan §3, plan §9): **deny by default; no dangerous permissions
to make demos work; never rely on prompts for security.**

---

## 2. Threat matrix (T1–T16)

T1–T10 from plan §11; T11–T16 added from review §24. Postures are not weakened
anywhere: every mitigation is deny-by-default.

| # | Threat | Vector | Mitigation (v1) | Source |
| --- | --- | --- | --- | --- |
| T1 | Prompt injection via ingested content | email/web/channel text reaching a model with tools | Untrusted text is data, never instructions: extraction-only prompts, no tool grants for untrusted-source runs, injection fixtures in evals (§40 item 15) | plan §11 |
| T2 | Edge harness bypassing policy | OpenClaw executing privileged action directly | Privileged actions exist only behind Jehad OS API + grant; test §40 item 19 | plan §11 |
| T3 | Cross-domain leakage (employer → personal memory) | semantic promotion of work content | domain gate in promotion pipeline; abstract-learning allowlist | plan §11 |
| T4 | Secret leakage into prompts/logs/events | config drift, logging payloads | secrets from env/Keychain only; redaction at logger; events store references not bodies where sensitive; egress policy `secret → never in model context` | plan §11 |
| T5 | Duplicate/replayed events | adapters retrying | idempotency keys, at-least-once + handlers idempotent | plan §11 |
| T6 | Conflicting state across harness memories | OpenClaw memory vs canonical | OpenClaw memory is cache-only (documented in tito AGENTS.md); canonical queries go through API | plan §11 |
| T7 | Workflow runtime compromise / runaway spend | compromised package, loop bug | budget field on runs, enforced per model_call; kill switch (revoke grants by domain) | plan §11 |
| T8 | Multiple schedulers double-firing | tito cron + Jehad OS cron | ownership table (plan §5); business schedules only in Jehad OS | plan §11 |
| T9 | Mistaken entity resolution | extraction merges two people | commitments keep counterparty as text + optional entity link with confidence; never auto-merge | plan §11 |
| T10 | Stale context packages | delegated work uses outdated state | packages carry event watermark; verifier checks freshness (Phase 3) | plan §11 |
| T11 | Local unauthenticated API access | malicious local process / browser / harness on this Mac | local identity credential per principal; deny all unauthenticated calls (plan §9); loopback is not identity | review §24 |
| T12 | Model egress violation | sensitive domain content sent to unauthorized provider/model | provider/domain/sensitivity egress policy enforced before context leaves the control plane (plan §9) | review §24 |
| T13 | External action ambiguity | network timeout after non-idempotent side effect | action intent/attempt/outcome states incl. `unknown`; provider idempotency keys; reconciliation workflow (plan §9) | review §24 |
| T14 | False semantic canonization | user statement or model inference promoted as objective fact | assertion_kind provenance; external claims remain claims until evidence supports them (plan §6.2) | review §24 |
| T15 | Employer perimeter violation | proprietary employer state stored in personal Postgres or sent to personal model providers | remote/opaque DomainBackend modes (plan §10); egress policy forbidding personal providers for work-remote (plan §9) | review §24 |
| T16 | Artifact backup gap | Postgres restored but filesystem artifacts lost | Phase 1 stores small artifacts in Postgres (single backup domain); restore verification covers rows + artifact content (plan §7, M1) | review §24 |

---

## 3. Expanded entries

Each entry restates the mitigation with its enforcement mechanics and the
tests that prove it. "Proven in Phase 1" follows the plan §13/§15 test list;
gaps are flagged in §5, not silently resolved.

### T1 — Prompt injection via ingested content

Untrusted text (email, web, channels, documents) is **data, never
instructions**. Runs that process untrusted sources get extraction-only
prompts and **no tool grants** — the trust-zone separation of §26.1 made
mechanical by the grant system (plan §11, plan §9): an untrusted-source run
literally holds no capability token capable of a side effect, so injected
instructions have nothing to act through. Injection-resistance fixtures are
part of evals from the start (§40 item 15).

*Tests:* injection-resistance fixtures 5/5 blocked from side effects — the
policy/capability gate denies **before any model call** (hermetic, plan §13);
M4 injection eval 5/5 (plan §15); prompt-injection text is also a hard case
in the extraction golden set (plan §13).

### T2 — Edge harness bypassing policy

Privileged actions exist **only behind the Jehad OS API + grant** (plan §11);
policy evaluation happens only in Jehad OS, and edge harnesses receive
time-boxed, single-purpose grants they cannot escalate — the API rejects
out-of-grant actions, full stop (plan §9). Covers harness compromise and
capability leakage across harness adapters (§36) in v1 posture: per-principal
credentials (review §4) + non-escalatable tokens (review §5) mean one
harness's grant is unusable by another.

*Tests:* §40 item 19 (edge/integration harness cannot bypass policy for a
privileged action); §40 item 11 (one capability denial demo); M4: grant-less
action → 403 + audited; token outside its scope → rejected (plan §15).

### T3 — Cross-domain leakage (employer → personal memory)

The promotion pipeline's **domain gate** (plan §6.2 gate 2) blocks work-domain
content from the personal semantic store; an **abstract-learning allowlist**
permits portable methods ("user has experience with webhook idempotency") and
prohibits employer specifics ("Employer X has vulnerability Y in table Z" —
§4.2/§4.3). Federated/opaque semantics (cleanup §3) constrain what remote work
domains can contribute at all — see `docs/domain-boundaries.md`.

*Tests:* §40 item 14 — a work-domain capture whose semantic promotion is
blocked by the gate while its episodic event persists (plan §13); M4
fake-domain isolation tests (with T15).

### T4 — Secret leakage into prompts/logs/events

Secrets come from **env/Keychain only**; the logger **redacts**; events store
**references, not bodies** where sensitive; the egress policy enforces
`secret → never in model context` (plan §11, plan §9). §26.5: real secrets
manager; never in prompts, event logs, telemetry, or long-term memory.
AGENTS.md hard rule: secrets never enter git, logs, prompts, or event
payloads; `.env*` gitignored.

*Tests:* hermetic egress-denial test (the `secret` class is denied at context
build — plan §13); eval API key lives in gitignored local `.env` (plan §13).
*Gap:* no dedicated logger-redaction fixture in the v1 hermetic list —
flagged in §5.

### T5 — Duplicate/replayed events

Every event envelope carries a unique `idempotency_key`
(`sha256(source + external id)`) enforced by constraint; handlers are
idempotent; outbox dispatch is at-least-once (plan §8, plan §7). Adapter
retries reuse the key; distinct real-world occurrences mint a new one (CLI
mints a fresh uuid per capture — plan §8). Covers replay attacks (§36) on
the ingest path.

*Tests:* M2 — duplicate event → 200-noop; replay of outbox is safe
(plan §15).

### T6 — Conflicting state across harness memories

OpenClaw memory is **cache-only** (documented in the tito AGENTS.md);
canonical queries go through the API (plan §11). The ownership table (plan §5)
makes Jehad OS the sole canonical owner of structured truth; harness memories
are disposable caches.

*Tests:* none automated in Phase 1 — the boundary is documented ownership +
API-mediated reads; exercised when harnesses attach (Phase 3/E4). Flagged in
§5.

### T7 — Workflow runtime compromise / runaway spend

`runs.budget` is **enforced per model_call** (plan §11, plan §7); the kill
switch is **grant revocation by domain** (plan §11, plan §9). Inngest is an
executor only, never a source of truth for world state (plan §12), so a
compromised runtime cannot rewrite canonical truth — only the Jehad OS API
path mutates state, through grants.

*Tests:* spend recorded per call in `model_calls` against the A13 `$20/$50`
caps (M5 evals, plan §13); M3 kill -9 → restart → resume proves execution
durability (adjacent, not a compromise test). *Gap:* no explicit kill-switch
drill in the v1 test list — flagged in §5.

### T8 — Multiple schedulers double-firing

The ownership table (plan §5) draws the line: **business-domain schedules
live only in Jehad OS**; true local edge schedules stay in OpenClaw (tito);
the rule is enforced in code review (plan §5). tito keeps its own local
schedules (A8) — the split is deliberate, so each side has exactly one owner
per schedule.

*Tests:* none automated in Phase 1 (single-scheduler reality); the ownership
table is the control. Flagged in §5.

### T9 — Mistaken entity resolution

Commitments keep `counterparty_text` plus an **optional** entity link with
link confidence; the system **never auto-merges** entities (plan §11,
plan §7). Extraction errors stay recoverable: the text is the record; the
link is a hypothesis.

*Tests:* per-field counterparty/direction accuracy reported in the extraction
eval; the third-party-promise hard case — "John said yesterday he'd send it
Friday" must NOT become *Jehad owes John* (plan §13).

### T10 — Stale context packages

Context packages carry an **event watermark**; the verifier checks freshness
(Phase 3) (plan §11). Recorded now because delegation (Phase 3) will rely on
it; nothing in Phase 1 delegates.

*Tests:* deferred to Phase 3 with the HarnessAdapter/delegation work
(plan §15/§16). Flagged in §5.

### T11 — Local unauthenticated API access (review §24)

Vector: malicious local process/browser/harness on this Mac — loopback is a
network boundary, not an identity boundary (review §4). Mitigation: local
identity credential per principal (Keychain bearer); **deny all
unauthenticated calls** (plan §9); bootstrap migration `000_bootstrap_auth.sql`
means the API never exists unauthenticated (cleanup §2).

*Tests:* M0 — unauthenticated API request → 401 (plan §15); M2/review §25 —
unauthenticated localhost request → rejected.

### T12 — Model egress violation (review §24)

Vector: sensitive domain content sent to an unauthorized provider/model —
including via context assembly, not just explicit calls. Mitigation: the
**provider/domain/sensitivity egress policy enforced before context leaves
the control plane** (plan §9, ADR-0012); denial raises + audits before any
model call; every `model_calls` row implies the check passed (plan §7).

*Tests:* M4/M5 — finance/work-sensitive context + unauthorized provider →
denied before the model call (plan §15, review §25); hermetic egress-denial
test (plan §13).

### T13 — External action ambiguity (review §24)

Vector: network timeout after a non-idempotent side effect — did the email
send? The audit log cannot honestly say sent or not-sent without provider
confirmation. Mitigation: the intent/attempt/outcome state machine with
`unknown` as a first-class outcome; provider idempotency keys; a
reconciliation workflow that resolves via provider refs; one intent → many
appended attempts (plan §9, review §6, cleanup §5; mechanics in
`docs/policy-model.md` §5). Audit proves intent, never completion.

*Tests:* M4 — action attempt timeout → outcome `unknown`, audit never claims
success (fake provider) (plan §15, review §25); hermetic
action-timeout→unknown test (plan §13).

### T14 — False semantic canonization (review §24)

Vector: a user statement or model inference promoted as objective fact
("Company X has 3M customers" becoming verified truth because Jehad said it).
Mitigation: `assertion_kind` provenance (observed | user_declared |
externally_sourced | model_inferred | computed); user-declared external-world
claims remain evidence-linkable **claims**, never auto-promoted to verified
semantic fact; promotion rules are config, not model judgment (plan §6.2).

*Tests:* M5 — claim-not-fact test: user claim persisted as claim/episode,
never silently promoted to verified fact (plan §13, review §25); the
7-class promotion eval (≥0.9 bootstrap accuracy) explicitly includes the
claim-vs-fact distinction (plan §13).

### T15 — Employer perimeter violation (review §24)

Vector: proprietary employer state stored in personal Postgres or sent to
personal model providers. Mitigation: `remote`/`opaque` `DomainBackend` modes
(plan §10, ADR-0010) — employer content can be incapable of entering personal
storage at all — plus egress policy forbidding personal providers for
`work.remote-employer` (plan §9). This is §4.4 (intelligence comes to the
data) made mechanical.

*Tests:* M4 (cleanup §3, review §25) — fake **federated** domain exports only
policy-approved sanitized metadata; fake **opaque** domain exports **no
semantic payload at all** — personal DB clean.

### T16 — Artifact backup gap (review §24)

Vector: Postgres restored but filesystem artifacts lost — rows recovered,
briefs/eval reports/evidence silently gone. Mitigation: Phase 1 stores small
textual artifacts **in Postgres** (Option A — single backup domain, review §11;
plan §7 `artifacts.storage_backend`), so pg_backup covers them; the practiced
restore verifies **database rows AND artifact content** (plan §7, plan §15 M1).

*Tests:* M1 — backup → destroy → restore → database + artifact both
verifiably restored (plan §13, review §25).

### T17 — Gmail content store: leak, over-retention, injection amplification (ADR-0016, 2026-09-22)

Vector: bounded Gmail **body** persistence (ADR-0016 `gmail.content` class)
creates a new sensitive store. Three sub-risks: (a) bodies leak into
audit_log / event payloads / `model_calls` / metrics / logs; (b) bodies are
retained indefinitely ("available ⇒ kept forever"); (c) hostile body text
amplifies into authority (injection via stored source). Mitigations:
ids/refs-only ledger payloads (existing rule, now scan-test-enforced);
policy-gated class `sensors.gmail.content {enabled, retention_days,
max_body_bytes}` with a deterministic retention sweeper and outcome/verifier
artifact-pinning as the only extension path; `source_trust_class=
'untrusted_external'` on every row + the ADR-0013 authorization invariant
extended to stored-source reads (content may inform prose/evidence, never
mint work, criteria, grants, actions, spend, or completion). Principal
isolation is structural (principal_id scoping; cross-principal reads deny).

*Tests:* GC0 suite — MIME variant fixtures; injection fixtures (hostile
bodies quoted, never obeyed); no-body-leak scans across audit/events/
model_calls; retention deletion test; foreign message-id/thread-id/
cross-principal-search denial tests (roadmap §19 GC0).

---

## 4. Threat → acceptance-test mapping

Consolidated from plan §13 (acceptance criteria + hermetic checks + live
evals), plan §15 (M0–M6 milestone acceptance), review §25 (additional tests),
and §40 items. "Status" reflects the plan's own scheduling; deferred does not
mean waived.

| Threat | Proving test | Milestone | Status in plan |
| --- | --- | --- | --- |
| T1 | Injection-resistance fixtures 5/5 blocked from side effects (gate denies before any model call); §40 item 15; prompt-injection hard case in extraction eval | M4 + hermetic (plan §13) | Phase 1 |
| T2 | §40 item 19 (edge cannot bypass policy); §40 item 11 (capability denial demo); grant-less action → 403 + audited; token outside scope rejected | M4 | Phase 1 |
| T3 | §40 item 14 (work capture: semantic promotion blocked, episodic event persists) | M4/M5 (plan §13) | Phase 1 |
| T4 | Egress-denial hermetic test (`secret` never in model context); secrets in gitignored `.env`/Keychain only | M4 + hermetic | Partial (see §5) |
| T5 | Duplicate event → 200-noop; outbox replay safe; unauthenticated request rejected (ingest path) | M2 | Phase 1 |
| T6 | — (documented cache-only boundary; API-mediated canonical reads) | — | Deferred (§5) |
| T7 | Per-call spend ledger in `model_calls` against A13 caps; kill -9 → restart → resume (durability, adjacent) | M3/M5 | Partial (see §5) |
| T8 | — (ownership table plan §5 is the control) | — | Deferred (§5) |
| T9 | Per-field counterparty/direction accuracy + third-party-promise hard case ("John said…" ≠ Jehad owes) | M5 evals | Phase 1 |
| T10 | — (event watermark + freshness verifier) | Phase 3 | Deferred by design |
| T11 | Unauthenticated API request → 401; unauthenticated localhost request → rejected | M0, M2 | Phase 1 |
| T12 | Finance/work-sensitive context + unauthorized provider → denied before model call; hermetic egress-denial test | M4/M5 | Phase 1 |
| T13 | Action attempt timeout → outcome `unknown`, audit never claims success (fake provider); hermetic action-timeout→unknown test | M4 | Phase 1 |
| T14 | Claim-not-fact test ("Company X has 3M customers" stays a claim/episode); 7-class promotion eval incl. claim-vs-fact | M5 | Phase 1 |
| T15 | Fake federated domain exports only policy-approved sanitized metadata; fake opaque domain exports no semantic payload — personal DB clean | M4 (cleanup §3) | Phase 1 |
| T16 | Backup → destroy → restore → database + artifact both verifiably restored | M1 | Phase 1 |
| T17 | GC0 suite: injection fixtures; no-body-leak scans (audit/events/model_calls); retention sweeper; cross-principal denial (ADR-0016; roadmap §19 GC0) | GC0 (roadmap) | Accepted 2026-09-22 |

Items from plan §13 not threat-bearing (audit trail item 10, human-blocked
time item 12, leverage query, brief determinism) are tracked in
`docs/evals.md` scope, not here.

---

## 5. Coverage gaps (flagged, not resolved)

Faithfulness note: these are places where the plan's v1 test list does not
(yet) prove a stated mitigation. They are flagged for milestone planning; no
posture is weakened and nothing here silently resolves a gap.

1. **T4 logger redaction** — no dedicated redaction fixture in the v1
   hermetic list; only the egress-side (`secret → never in model context`)
   and secrets-handling rules are tested/enforced.
2. **T6 harness-memory conflict** — no automated Phase-1 test; control is the
   documented cache-only boundary. Exercise when harnesses attach (E4/Phase 3).
3. **T7 kill switch** — grant revocation by domain is the stated mitigation
   (plan §11) but no M-list test drills it.
4. **T8 scheduler ownership** — no automated test while only Jehad OS runs
   business schedules; revisit when tito schedules interact with kernel
   workflows.
5. **T10 stale-context freshness** — verification deferred to Phase 3 by the
   plan (plan §11); watermark design lands with context packaging.

---

## 6. Directive §36 coverage traceability

§36 requires these to be modeled before enabling tool use. Mapping to the
matrix (partial = the v1 posture covers part of the requirement; the rest is
scheduled):

| §36 requirement | Covered by | Notes |
| --- | --- | --- |
| prompt injection | T1 | |
| malicious email/web content | T1 | |
| poisoned documents | T1 | untrusted-input zone, no tool grants |
| compromised external integrations | T2 + grants (plan §9) | partial — first real integration at E3, grant-scoped |
| secret leakage | T4 | |
| cross-domain data leakage | T3, T15 | |
| privilege escalation | T2 + non-escalatable tokens (plan §9) | |
| unsafe tool chaining | T1 + T2 | no side-effect grants for untrusted-source runs |
| mistaken identity/entity resolution | T9 | |
| hallucinated actions | autonomy ceiling (plan §9) + T13 + T14 | partial — approval_required on external side effects; truth semantics on canonization |
| stale financial data | T10 (adjacent) + temporal validity (plan §7, review §19) | partial — finance vertical deferred (plan §16) |
| duplicate events | T5 | |
| replay attacks | T5 + T11 | idempotency + authenticated ingest |
| unintended irreversible communication | T13 + approval gates (§26.3) | |
| excessive model permissions | T12 + `call_model`/`spend_budget` grants (plan §9) | |
| malicious synthetic test behavior reaching production | — | synthetic customers on the not-now list (plan §16); model when that vertical is scheduled |
| compromised local edge node | T2, T6 + E4 read/delivery-only grant scope (plan §19) | |
| conflicting state between multiple harness memories | T6 | |
| duplicate execution caused by multiple schedulers | T8 | |
| harness compromise | T2 | |
| workflow-runtime compromise | T7 | |
| capability leakage across harness adapters | T2 + per-principal/run tokens (plan §9) | full proof at Phase 3 HarnessAdapter |
| stale context packages | T10 | |
| accidental persistence of employer data into personal cognitive memory | T3, T15 | |

---

## 7. Standing rules

- Deny by default at every layer — this table adds mechanisms, never
  exceptions (plan §3, plan §9).
- Mitigations are mechanical (data-layer checks, grant scope, policy gates),
  never prompt-borne or model-judgment-borne (plan §9, review §7).
- Every threat above keeps its mitigation even where its proving test is
  deferred; deferred tests are tracked in §5, not dropped.
