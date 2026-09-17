# Policy Model: Authentication, Grants, Autonomy, Actions, Egress

- **Status:** Phase 0 artifact (derived; not yet implementation)
- **Derived from:** plan §9 (canonical, rev 3), plan §7 (schema:
  `principals`, `capability_grants`, `action_intents`, `action_attempts`,
  `audit_log`, `model_calls`), plan §15 (M0/M4 milestones), A3/A5/A13/A15;
  review §4 (authentication), §5 (verifiable possession), §6 (action
  semantics), §7 (egress), §25 (tests); cleanup §2 (auth bootstrap
  migration), §5 (action state ownership); directive §26 (security
  architecture), §35 (policy examples), §40 items 11/15/19.
- **Decision records:** ADR-0007 (extended — capability grants with verifiable
  possession), ADR-0009 (local authentication), ADR-0011 (action
  intent/attempt/outcome), ADR-0012 (model/data egress policy) — in
  `docs/adr/`.
- **Citation convention (same as plan):** bare `§N` = directive section;
  `plan §N` = `docs/plans/phase0.md` (canonical, rev 3); `review §N` =
  `docs/reviews/phase0-external-review.md`; `cleanup §N` =
  `docs/reviews/phase0-final-cleanup.md`.

---

## 1. Principles

1. **Deny by default.** No capability, no action, no egress, no composition
   without an explicit grant or policy rule. No dangerous permissions to make
   demos work (plan §3).
2. **Policy evaluation happens only in Jehad OS** (plan §9). Edge harnesses
   (OpenClaw) and future coding harnesses receive time-boxed, single-purpose
   grants and cannot escalate them: the API rejects actions outside the grant,
   full stop (§40 item 19 is the test).
3. **Policy is data, not model judgment.** The autonomy ceiling ships as
   versioned `policy.yaml` (§35 pattern); promotion rules are config
   (plan §6.2). Models propose; policy disposes.
4. **Least privilege, per task** (§26.2): capabilities are granted per
   principal/run, are short-lived, and die with the run. Agents are
   disposable; capabilities are controlled.
5. **Never rely on prompts for security** (review §7): "don't expose this" in
   a prompt is not a control; the egress gate is.

---

## 2. Principals and authentication (ADR-0009)

**Every API call is authenticated from day one (M0).** The API requires an
authenticated principal on every call; there is no unauthenticated window
during bootstrap (plan §9, plan §15 M0).

- **Mechanism:** a random local **bearer credential stored in macOS Keychain**
  (plan §9). `josctl` and each future harness get **their own credential** —
  one credential per principal (review §4). The alternative — Unix-domain
  socket + filesystem permissions — was considered; bearer wins for the later
  OpenClaw path (plan §9, review §4).
- **Bootstrap:** M0 ships a minimal migration, `000_bootstrap_auth.sql`
  (**principals table only**: id, type, name, `credential_hash`, created_at),
  so authentication never waits on the full M1 schema (cleanup §2, plan §15
  M0). M1 then applies the remaining schema-v1 migrations; M0/M1 ownership is
  unambiguous (cleanup §2). Invariant (cleanup §2):
  > The API must never exist in an unauthenticated state merely because the
  > full world-model schema has not yet landed.
- **Loopback is not identity** (review §4): binding to 127.0.0.1 is retained
  as defense-in-depth, but it is a *network* boundary, not an *identity*
  boundary. A compromised browser, local process, agent, package, or script on
  this Mac gets nothing by default (plan §9, review §4).
- **Principal types:** `user | harness | service | workflow` (plan §7, plan §9,
  review §4). Even with a single user at the API boundary in v1 (A3), every
  caller authenticates as a principal.
- **Secrets handling:** the principals table stores only `credential_hash`;
  the credential itself lives in Keychain (plan §7, review §4/§5; AGENTS.md
  hard rule — secrets never enter git, logs, prompts, or event payloads).
- **Later phases:** harness identities and transport hardening arrive with the
  first non-loopback caller at E4 (A15); OpenClaw's initial grant scope is
  read/delivery only (plan §19 E4).

**Proving tests (plan §15):** M0 — unauthenticated API request → 401;
M2 — unauthenticated request rejected (review §25).

---

## 3. Capability grants with verifiable possession (ADR-0007 extended)

Deny by default. **A run acts only through `capability_grants` issued at
dispatch** to a principal/run (plan §9). A grant carries:

```text
capability:  "read_events"
           | "write_entity:<type>"
           | "call_model:<provider>"
           | "send_channel:<id>"
           | "spend_budget:<usd>"
           | "act:<provider>"
resource, domainId, expiresAt
```

(plan §9; schema per plan §7: `capability_grants` — principal_id, run_id,
capability, resource, domain_id, expires_at, revoked_at, `token_hash`.)

### 3.1 Why tokens — grants must be possessable, not just nameable

Review §5: do not eventually send `{"grantId": "123"}` and trust the caller.
A grant row plus a caller-supplied id is "just database metadata." Possession
must be **verifiable**: the caller presents an **opaque random capability
token** whose claims are:

```text
principal · run_id · capability · resource · domain · expires_at · nonce
```

(review §5, plan §9.)

Token properties (review §5, plan §9): **short-lived · scope-limited ·
revocable · auditable · non-escalatable · unusable outside the granted
resource/domain.**

### 3.2 Storage and phase split

- The canonical grant row stores **only a token hash** (`token_hash`,
  plan §7) — the token itself is presented, never stored in the clear.
- **Phase 1 ships the token primitive** so grants are never "just database
  metadata" trusted from a caller-supplied id (plan §9): M4 acceptance
  includes *token outside its scope rejected* (plan §15 M4).
- **Exact signing/rotation machinery is Phase 2+** (plan §9, review §5).

### 3.3 Lifecycle and kill switch

- Grants are **revoked on run end** (plan §9).
- Kill switch: grants may be **revoked by domain** (plan §11 T7 mitigation for
  runaway spend / workflow compromise).
- Grant issuance and revocation are events (`grant.issued`, `grant.revoked`,
  plan §8).

**Proving tests (plan §15 M4):** grant-less action → 403 + audited; token
outside its scope → rejected. Program-level: §40 item 11 (one capability
denial demo) and §40 item 19 (edge harness cannot bypass policy for a
privileged action).

---

## 4. Autonomy ceiling

Per action type, from versioned `policy.yaml` (the §35 pattern). **v1 ships**
(plan §9):

```yaml
read:                 autonomous
propose:              autonomous
write_canonical:      gated
external_side_effect: approval_required
money_and_contracts:  prohibited
```

- `read`/`propose` autonomous: cheap, reversible, reviewable.
- `write_canonical` gated: semantic writes are proposals that land in the
  review queue unless they qualify under the promotion gate's narrow
  user-declared/episodic exceptions (plan §6.2 — truth semantics live in
  `docs/memory-architecture.md`).
- `external_side_effect` approval_required: every external side effect is an
  approved action intent (see §5 below).
- `money_and_contracts` prohibited: no autonomous agent moves money or signs
  contracts; high-risk execution is human approval gate + (later) hardened
  path (plan §5, §18.10 direction).

This instantiates §26.1's trust zones (untrusted input → trusted reasoning →
action layer → high-risk actions) and §26.3's approval gates (money movement,
trading, material production deployment, destructive database operations,
contracts/legal commitments, credential changes, irreversible external
communications, high-impact architectural migrations). §35 also names further
policy dimensions — domain, amount/impact, reversibility, confidence, data
sensitivity, user-defined rules — that later policy versions may add; v1
ships the five levels above.

---

## 5. External actions: intent / attempt / outcome (ADR-0011)

Every external side effect is modeled as **`action_intents` →
`action_attempts`** (plan §9, review §6, cleanup §5). This is designed **now**
because Finance eventually enters this control plane (plan §9); Phase 1
exercises it with a **fake provider adapter** — no real external actions until
E3/E4 (plan §9, plan §15 M4).

### 5.1 State ownership — exactly one canonical owner per state

Per cleanup §5 (so implementation does not create two competing state
machines):

| Record | Field | States owned |
| --- | --- | --- |
| `ActionIntent` | `status` | `proposed → approved → prepared \| cancelled` |
| `ActionAttempt` | `outcome` | `executing → succeeded \| failed \| unknown → reconciled` |

Combined lifecycle as presented (cleanup §5, plan §9):

```text
intent proposed → approved → prepared
  → attempt executing
  → attempt outcome (succeeded | failed | unknown)
  → (if unknown) reconciled
```

### 5.2 The rules that make it honest

- **One intent → many attempts.** Retries and reconciliation **append** new
  attempts; the history of an earlier ambiguous attempt is never overwritten
  (cleanup §5, plan §7).
- **Provider idempotency keys** are used where available (plan §9;
  `action_attempts.idempotency_key`, plan §7).
- **A pre-effect audit entry proves intent, never completion** (plan §9,
  plan §7 `audit_log`). After a lost response (e.g. response timeout), the
  honest state is **`unknown`** until a reconciliation workflow resolves it
  via provider refs (review §6, plan §9). The audit log must never claim
  success the system has not observed (review §6/§25).
- Audit references these records directly (`audit_log.action_intent_id`,
  `action_attempt_id` nullable — plan §7).

**Proving tests (plan §15 M4, review §25):** action attempt timeout →
outcome `unknown`; audit never claims success (fake provider). Hermetic
action-timeout→unknown test in `pnpm test` (plan §13).

---

## 6. Model / data egress policy (ADR-0012)

`call_model` as a capability is **too coarse** (review §7). The question is
not "can this run call an LLM?" but:

> May **this data** (domain × sensitivity) leave for **this provider/model**?

(plan §9, review §7.)

```ts
interface ModelEgressPolicy {
  domainId: string;
  sensitivity: Sensitivity;
  allowedProviders: string[];
  allowedModels?: string[];
  allowRemote: boolean;
  requireRedaction: boolean;
}
```

(plan §9; shape per review §7.)

Starter postures (plan §9):

```text
personal.normal        → OpenRouter allowed
finance.sensitive      → selected providers only
work.remote-employer   → personal model providers forbidden
secret                 → never in model context
```

### 6.1 Enforcement point

- **Context building calls policy before provider dispatch** (plan §9). A
  denial **raises and is audited before any model call** — the context never
  leaves the control plane to find out it was not allowed to.
- Every `model_calls` row implies the egress-policy check passed (plan §7);
  denials raise + audit instead of producing a call record.
- This is the mechanical backstop for T4/T12/T15 in `docs/threat-model.md`
  (secret leakage, egress violation, employer perimeter violation).
- **Never rely on prompts saying "don't expose this"** (review §7); §26.5:
  secrets never enter model prompts, event logs, telemetry, or long-term
  memory.

**Proving tests (plan §15 M4/M5, review §25):** finance/work-sensitive
context + unauthorized provider → denied **before** the model call; hermetic
egress-denial test in `pnpm test` (plan §13).

---

## 7. Enforcement points summary

| Gate | Enforced at | Milestone |
| --- | --- | --- |
| Authenticated principal on every call | API entry (bearer credential, Keychain) | M0 (cleanup §2) |
| Valid capability grant + token possession | API, on every actuating call | M4 |
| Grant scope: resource + domain + expiry; revocation at run end; kill switch by domain | Grant service | M4 (kill switch per plan §11 T7) |
| Autonomy ceiling (`policy.yaml` v1) | Action dispatch (intent approval) | M4 |
| Intent/attempt/outcome honesty (`unknown` until reconciled) | Action service + audit | M4 (fake provider) |
| Model egress (domain × sensitivity × provider) | Context build, before dispatch | M4/M5 |
| Domain gate in memory promotion (incl. federated/opaque semantics) | Promotion pipeline (plan §6.2 gate 2) | M5 |
| Raw cross-domain access denied; composition only via policy-mediated least-data aggregation | Data layer + future aggregation layer (invariant now, engine not Phase 1 — cleanup §4) | recorded; engine later |

## 8. Phase split (what ships when)

| Capability | Phase 1 | Phase 2+ |
| --- | --- | --- |
| Bearer auth per principal, Keychain, 401 on unauthenticated | M0 | harness identities + transport hardening at E4 (A15) |
| Capability token primitive (opaque random token, claims, hash stored, scope checks) | M4 | exact signing/rotation machinery (plan §9) |
| `policy.yaml` v1 autonomy ceiling | M4 | richer §35 dimensions |
| Action intent/attempt/outcome incl. `unknown` + reconciliation | M4 (fake provider) | real providers at E3/E4 |
| `ModelEgressPolicy` checked pre-dispatch | M4/M5 | per-domain refinement |
| Cross-domain composition policy | invariant recorded | aggregation engine (cleanup §4) |

Every row keeps the same posture at every phase: **deny by default**.

---

## 9. Confidence and date-trust policy (owner directive 2026-09-17)

Two rules from the owner's 2026-09-17 directive, both mechanical denials of
model autonomy over judgment-sensitive state.

### 9.1 Decalibration: policy_confidence is empirical-capped

**`model_confidence` is uncalibrated evidence.** A model reporting 0.95 is
making a claim about itself, not a probability. `policy_confidence` — the only
number thresholds may act on — is derived from empirical eval history, never
copied from the model:

```text
policy_confidence = min(model_confidence, empirical_by_class ?? model_confidence)
```

- The empirical precision (observed precision of past predictions, from
  `evals/.empirical-precision.json` or derived from a live-run report) CAPS
  the model's claim; it can never raise it.
- Promotion gate 4 applies its thresholds to policy confidence whenever an
  empirical source is configured (`gate4Confidence.empiricalPrecisionPath`).
  **Never build "confidence > 0.9 → auto-promote" on raw model numbers.**
- Fail-closed rules: a configured-but-missing empirical source caps
  action-driving decisions at a conservative 0.5 (display-only numbers stay
  raw); a malformed source throws. Gates stay pure — the pipeline loads the
  source and injects the caps; `gate_result` records the model/policy/cap
  audit trail.

### 9.2 Date trust: three tiers for due dates

Free-text dates never autonomously drive overdue logic. A commitment's
`temporal` provenance (`TemporalProvenance`; extraction contract) places its
due date in one of three tiers:

| Tier | Provenance | Overdue automation |
| --- | --- | --- |
| **calendar-native** | `resolutionStatus="resolved"`, `resolutionMethod="calendar-native"` — structured calendar time | trusted |
| **normalized** | resolved by the deterministic normalizer with `resolutionConfidence ≥ 0.9` (configurable) | confidence-gated |
| **review** | ambiguous, unsupported, contradictory, malformed | never; surfaced as `needsReview: "ambiguous_due_date"` |

Absent temporal provenance — legacy rows, or schemas before the `commitments.temporal`
column lands — follows the strictest applicable rule: not calendar-native,
never auto-overdue, `needsReview` instead. Queries and briefs may SHOW an
untrusted past-due date for review; they must not ASSERT overdue from it.
