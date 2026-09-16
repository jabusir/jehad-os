# Domain Boundaries & Data Isolation

- **Status:** Phase 0 artifact (derived; not yet implementation)
- **Derived from:** plan §10 (canonical, rev 3), plan §6.2 (promotion domain gate), plan §7
  (`domains` table), plan §16 (not-now list), A16; review §3 (physical separation);
  cleanup §3 (strict `opaque` semantics), cleanup §4 (policy-mediated composition);
  directive §4 (hard data boundaries), §4.3/§4.4, §5 (provenance), §40 item 14.
- **Decision record:** ADR-0010 (DomainBackend storage modes) — lives in `docs/adr/`.
- **Citation convention (same as plan):** bare `§N` = section N of the build directive
  (`docs/directive/JEHAD_OS_BUILD_DIRECTIVE.md`); `plan §N` =
  `docs/plans/phase0.md` (canonical, rev 3); `review §N` =
  `docs/reviews/phase0-external-review.md`; `cleanup §N` =
  `docs/reviews/phase0-final-cleanup.md`. `§40 item N` = item N of directive §40's
  numbered list.

---

## 1. The governing rule

**A domain is not synonymous with a row-level partition in the personal
PostgreSQL database** (plan §10, review §3). Row-level `domain_id` is good
logical isolation *inside* local domains, but it is insufficient for the
future-employer constraint (review §3): a future employer may require that
source code stay on a managed machine, that company Slack/Drive data never
leave company infrastructure, that only employer-approved models be used, that
no personal database contain company data, or that no personal device have
access at all. In that environment, employer data must be **capable of never
entering personal Jehad OS storage** (review §3; plan §3).

This is the faithful implementation of the directive's position that
employer-specific state is a **detachable module** (§4.3) and that when a work
environment restricts AI tooling, **intelligence comes to the data** — the
operating pattern is recreated inside the employer-approved environment rather
than context being exfiltrated out of it (§4.4).

Each domain therefore declares a `storage_mode` on the `domains` table
(`local | remote | federated | opaque` — plan §7, review §3), and every
boundary-crossing consults the `DomainBackend` for that domain (plan §10).

---

## 2. Storage modes

Semantics per cleanup §3 (which tightened and separated the modes) and plan §10:

| Mode | Canonical data location | What may cross into personal Jehad OS | v1 examples |
| --- | --- | --- | --- |
| `local` | Jehad OS PostgreSQL | Everything (it is already here) | `personal`, `finance`, `research`, `learning`, `creative`, current-startup work *if authorized* |
| `remote` | The remote environment | Only responses allowed by policy, via the `DomainBackend` adapter | none in v1 (A16 — fake adapter only, M4) |
| `federated` | The remote environment | A deliberately defined, **sanitized subset of metadata**; sensitive details stay remote | none in v1 (A16 — fake adapter only, M4); canonical signal examples: "2 decisions need review", "1 approval pending", "adapter healthy" |
| `opaque` | The remote environment | **Zero domain-content export by default** — existence/health/capability only, and even those only if policy permits | none in v1 (A16); the archetype is a future employer's domain (plan §10) |

### 2.1 `local`

Canonical domain data may live in Jehad OS PostgreSQL (plan §10). Isolation
between local domains is enforced in the data layer (see §4 below). All six v1
domains are `storage_mode=local` (A16).

### 2.2 `remote`

Canonical state remains in the remote environment. Jehad OS interacts only
through a `DomainBackend` adapter and may receive responses allowed by policy
(plan §10). Content stays at the source; only policy-permitted responses come
back.

### 2.3 `federated`

A **deliberately defined, sanitized subset of metadata** may cross the boundary
while sensitive details stay remote (plan §10). The canonical examples are
counts and health signals — "2 decisions need review", "1 approval pending",
"adapter healthy" (cleanup §3) — never the underlying proprietary content.
Note: the "2 work decisions need review" example was **moved from `opaque` to
`federated`** by cleanup §3; counts are metadata, not nothing, so they belong
here.

### 2.4 `opaque` — the strictest mode

**Zero domain-content export by default** (cleanup §3). Personal Jehad OS may
know only:

- that the domain (and its capabilities) **exists**;
- adapter availability / health, **if policy permits**;
- capability availability, **if policy permits**.

It must **not** assume that counts, titles, summaries, deadlines, project
names, or decision metadata may cross the boundary (cleanup §3, plan §10). No
semantic payload crosses unless the domain's policy is **explicitly changed**
— the default is silence, not a negotiated subset. This is the mode a future
employer's domain would use under the strictest posture (managed machines,
employer-approved models, no personal-DB copies, no personal device access —
plan §10, review §3).

### 2.5 Mode contrast at a glance

| Signal crossing the boundary | `local` | `remote` | `federated` | `opaque` |
| --- | --- | --- | --- | --- |
| Full content | n/a (lives here) | never | never | never |
| Sanitized metadata (e.g. "2 decisions need review") | n/a | only if policy allows | yes — that is the point | **no** (not by default) |
| Existence / health / capability | n/a | yes | yes | yes, if policy permits |
| Nothing at all beyond existence | n/a | — | — | the default posture |

---

## 3. The `DomainBackend` interface

The boundary is a port, established now; concrete remote backends are **not**
implemented in Phase 1 (plan §10, plan §16, review §22/§27 — minimal
abstraction only; A16: proven with a fake adapter at M4).

```ts
interface DomainBackend {
  id: string;
  mode: "local" | "remote" | "federated" | "opaque";
  query(request: DomainQuery, ctx: DomainAccessContext): Promise<DomainQueryResult>;
  context(request: ContextRequest, ctx: DomainAccessContext): Promise<ContextPacket>;
  capabilities(): Promise<DomainCapability[]>;
  health(): Promise<DomainHealth>;
}
```

(plan §10; shape per review §3.)

Three consumers are bound to consult this boundary, by design (plan §10,
review §3):

1. **Context-package design** — a context package built for a run may only
   include what the source domain's `DomainBackend` permits to leave; a work
   domain's content never crosses into another domain's context package
   (plan §10).
2. **Memory-promotion rules** — the promotion gate's domain check
   (plan §6.2 gate 2) applies the mode semantics: federated domains may
   contribute policy-sanitized metadata only (counts like "2 work decisions
   need review", never content); opaque domains contribute no semantic payload
   at all by default (cleanup §3).
3. **The future HarnessAdapter** — delegated execution against a remote domain
   goes through the backend, not through personal-storage copies (plan §10;
   HarnessAdapter's first concrete implementation is Phase 3, cleanup §1).

---

## 4. Isolation inside local domains

`storage_mode=local` does not mean "anything goes":

- **`domain_id` is enforced on every read/write path in the data layer** — not
  by model discipline (plan §10). Every table carries `domain_id` +
  `sensitivity` where the directive requires provenance (§5, plan §7).
- **Work domain (`detachable=true`)** (plan §10, §4.3):
  - excluded from personal semantic promotion by the promotion gate
    (plan §6.2 gate 2: work-domain content is blocked from the personal
    semantic store; abstract method-level learning is allowed, employer
    specifics are not — §4.2/§4.3);
  - exportable + deletable as a unit (the detachable module of §4.3: when
    access ends, the module is revoked/deleted without breaking the personal
    system);
  - never crosses into another domain's context package.
- **Finance rows** carry stricter sensitivity defaults, and a stricter model
  egress policy applies (plan §9, plan §10; e.g. `finance.sensitive` →
  selected providers only; see `docs/policy-model.md`).

---

## 5. Cross-domain composition

Per cleanup §4 (which replaced an earlier audit-only rule as too restrictive
for the product):

> **Raw cross-domain data access is denied by default. Cross-domain
> composition is allowed only through an explicit, policy-mediated aggregation
> layer.**

The security goal is not "never compose domains" — it is **never allow
uncontrolled cross-domain access or leakage** (cleanup §4). Legitimate
cross-domain questions exist ("what requires my attention today?", "what
changed while I was away?"); they are answered by asking each domain for the
**minimum necessary projection**, not by granting domains mutual access.

Conceptual gate (cleanup §4 — a concept, not a Phase-1 build item):

```ts
interface CrossDomainQueryPolicy {
  mayRead(
    principal: Principal,
    sourceDomain: Domain,
    requestedFields: FieldSet,
    purpose: QueryPurpose
  ): PolicyDecision;
}
```

Shape of a composed view (cleanup §4, plan §10):

```text
personal domain  → 2 commitments due
finance domain   → 1 attention item
research domain  → 0 urgent changes
```

A "Today" view may combine those counts/items without giving any domain
unrestricted access to another. For `remote`, `federated`, and `opaque`
domains, the `DomainBackend` controls what projection may leave the remote
boundary — the aggregation layer cannot override the backend (cleanup §4,
plan §10).

**Invariant (plan §10, cleanup §4):**

```text
cross-domain composition:
  explicit, policy-gated, least-data, provenance-preserving

raw arbitrary cross-domain joins:
  forbidden
```

**No federation/query engine is built in Phase 1** (cleanup §4, plan §16).
Phase 1 operates almost entirely in the `personal` domain (A16); the invariant
is recorded now so later composition lands inside it, not around it.

---

## 6. Phase-1 scope and proof obligations

Built in Phase 1 (plan §15, A16):

- The `DomainBackend` **interface** (one of the six minimal abstractions
  defined in Phase 1 — plan §15; "define the port now, implement the adapter
  only when needed," cleanup §1).
- A **fake adapter at M4** that proves the invariants per cleanup §3
  (plan §15 M4 acceptance):
  - a fake **federated** domain exports only its policy-defined sanitized
    metadata ("2 work decisions need review", no content);
  - a fake **opaque** domain exports **no semantic payload at all** — personal
    Postgres receives nothing but existence/health; personal DB clean.

Explicitly not in Phase 1 (plan §16):

- any concrete remote `DomainBackend` (interface + fake adapter only until a
  real employer boundary exists — A16);
- any sophisticated cross-domain federation/query engine (the
  policy-mediated aggregation invariant is recorded; the engine is not
  Phase 1 — cleanup §4).

---

## 7. Invariant checklist

1. A domain is not a row-level partition; it declares a `storage_mode`
   (plan §10, review §3).
2. `local` data lives in Jehad OS PG with `domain_id` enforced in the data
   layer on every read/write path (plan §10).
3. `remote` canonical state never migrates here; only policy-allowed
   responses arrive, via the adapter (plan §10).
4. `federated` exports a deliberately sanitized metadata subset only — counts
   and health, never content (cleanup §3).
5. `opaque` exports zero domain content by default — existence/health/
   capability only, policy-permitting; no counts, titles, summaries,
   deadlines, project names, or decision metadata; no semantic payload unless
   the domain's policy is explicitly changed (cleanup §3).
6. Work domain is detachable: excluded from personal semantic promotion,
   exportable and deletable as a unit, never in another domain's context
   package (plan §10, §6.2 gate 2, §4.3).
7. Raw cross-domain access is denied by default; composition is explicit,
   policy-gated, least-data, provenance-preserving (cleanup §4).
8. Context packages, memory promotion, and the future HarnessAdapter all
   consult the `DomainBackend` boundary (plan §10, review §3).
9. Deny by default everywhere; no weakened postures to make demos work
   (plan §3).

**Decision record:** ADR-0010 — DomainBackend storage modes.
