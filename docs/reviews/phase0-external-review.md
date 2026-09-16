# Jehad OS — Phase 0 Plan Review / Required Revisions

Review target: phase0.md
Disposition: Approve with revisions before M1–M6 implementation.

The plan demonstrates strong understanding of the Jehad OS architecture and should remain the basis for implementation. Do not rewrite it from scratch.

The changes below are intended to correct several foundational issues before they become expensive:

- do not build a bespoke durable-workflow engine unless necessary;
- strengthen work/employer data isolation beyond domain_id;
- add local authentication before connecting any harness;
- model external side effects with proper attempt/outcome semantics;
- make model/data egress policy explicit;
- tighten memory-promotion truth semantics;
- add first-class relationships/dependencies required by the attention model;
- normalize decision assumptions instead of representing them twice;
- fix artifact durability/backups;
- improve evals around the failures that actually matter;
- clarify Phase 1 vs program-level v1;
- remove unnecessary personal PII from repo documentation.

Everything else in the plan should be preserved unless one of these revisions requires a local adjustment.

## 1. Overall Assessment

The following architectural choices are approved:

- single TypeScript monorepo;
- boring modular monolith before microservices;
- PostgreSQL as canonical structured state;
- explicit event log + outbox;
- harness/provider SDKs excluded from packages/core;
- semantic / episodic / procedural / working-memory distinction;
- Jehad OS as sole owner of policy, permissions, audit, and canonical truth;
- OpenClaw restricted to edge/integration responsibilities;
- coding harnesses treated as replaceable workers;
- capability-based grants;
- review/attention queue;
- no dangerous autonomy in early phases;
- CLI-first initial surface;
- first vertical slice based on commitments / decisions / delta brief;
- no UI/dashboard work merely for demo value;
- external integrations deferred until authorization is deliberate;
- provider abstraction around model calls.

Keep these.

The plan is correctly resisting the temptation to turn Jehad OS into an OpenClaw wrapper, Hermes wrapper, chatbot, or agent zoo.

## 2. REQUIRED CHANGE — Workflow Runtime

Current plan

Plan §12 / ADR-0008 proposes building a PostgreSQL-backed workflow runtime first and deferring Inngest.

The stated rationale includes the belief that Inngest or Trigger.dev self-hosting requires Docker/Kubernetes and introduces unnecessary infrastructure.

That premise is no longer accurate for Inngest.

Current Inngest supports:

- local development from a single CLI command;
- self-hosting from a single binary/service;
- SQLite by default for simple self-hosted persistence;
- optional PostgreSQL;
- durable step checkpointing;
- retries;
- event waits;
- human approval patterns;
- timers;
- concurrency / throttling / rate limiting;
- execution observability.

The plan's proposed M3 already includes:

- persisted workflow steps
- signals
- approval waits
- cron
- worker crash recovery
- resume

That is no longer a simple job queue. It is the beginning of a bespoke workflow engine.

The hidden future requirements will quickly become:

- retry policy
- backoff
- leases
- dead-letter behavior
- poison jobs
- workflow versioning
- timer correctness
- cancellation semantics
- concurrency
- fan-out/fan-in
- step idempotency
- side-effect replay semantics
- workflow migration
- run introspection
- execution history

Do not spend Jehad OS engineering effort rebuilding this unless an evaluated off-the-shelf runtime fails an actual requirement.

Revision

Replace ADR-0008 with approximately:

> ADR-0008: Use Inngest as the initial durable workflow runtime behind the WorkflowRuntime boundary.
>
> Use the local Inngest dev server during development.
>
> Jehad OS PostgreSQL remains authoritative for world state, domain state, evidence, audit, permissions, decisions, commitments, and events.
>
> Inngest owns workflow execution/checkpoint state only.
>
> Managed-vs-self-hosted deployment is deferred to E2.
>
> All workflow-provider usage remains behind a small adapter/boundary so the runtime is replaceable.
>
> Do not duplicate Jehad OS's canonical event ledger inside Inngest conceptually.

Use:

```
Jehad OS event
    ↓
workflow dispatch
    ↓
Inngest execution
    ↓
Jehad OS state mutation through domain services
```

Inngest is an executor, not the source of truth.

Keep the interface

Retain WorkflowRuntime.

Do not scatter Inngest primitives throughout packages/core.

A possible boundary:

```ts
interface WorkflowRuntime {
  start<TInput>(
    workflow: WorkflowName,
    input: TInput
  ): Promise<WorkflowHandle>;

  signal(
    handle: WorkflowHandle,
    signal: WorkflowSignal
  ): Promise<void>;

  cancel(handle: WorkflowHandle): Promise<void>;

  status(
    handle: WorkflowHandle
  ): Promise<WorkflowStatus>;
}
```

Provider-specific implementation may live under:

```
packages/workflow/inngest
```

Phase-0 experiment

Before finalizing ADR-0008, implement only a minimal spike proving:

start workflow
→ persist step
→ terminate app/worker
→ restart
→ resume
→ wait for external signal
→ signal
→ complete

If this works cleanly, use Inngest.

Do not write our own runtime merely because Postgres is already installed.

## 3. REQUIRED CHANGE — Domain Isolation Must Support Physical Separation

Problem

Plan §10 currently treats:

- personal
- work
- finance
- research
- learning
- creative

as rows sharing one physical PostgreSQL database, differentiated using domain_id.

That is good logical isolation.

It is insufficient for the future-employer constraint.

A future employer may require:

- source code to remain on a managed machine;
- company Slack/Drive data not to leave company infrastructure;
- only employer-approved models;
- no personal database containing company data;
- no personal device access at all.

In that environment, employer data must be capable of never entering personal Jehad OS storage.

Revision

Introduce the concept of a DomainBackend / DomainBoundary.

A domain should have a storage/execution mode:

```ts
type DomainStorageMode =
  | "local"
  | "remote"
  | "federated"
  | "opaque";
```

Suggested semantics:

### local

Data is stored in Jehad OS PostgreSQL.

Examples:

- personal
- learning
- research
- creative
- finance
- current-startup-work-if-authorized

### remote

Canonical state lives in another authorized environment.

Jehad OS interacts through an adapter.

### federated

Some high-level state can cross the boundary, while sensitive details remain remote.

### opaque

Personal Jehad OS knows only that a capability/domain exists.

It stores no proprietary content.

Interface direction

Something like:

```ts
interface DomainBackend {
  id: string;
  mode: DomainStorageMode;

  query(
    request: DomainQuery,
    context: DomainAccessContext
  ): Promise<DomainQueryResult>;

  context(
    request: ContextRequest,
    context: DomainAccessContext
  ): Promise<ContextPacket>;

  capabilities(): Promise<DomainCapability[]>;

  health(): Promise<DomainHealth>;
}
```

Do not over-engineer implementation now.

The important architectural rule is:

> A domain is not synonymous with a row-level partition in the personal PostgreSQL database.

domain_id remains useful inside local domains.

But the system must allow:

```
Personal Jehad OS
        │
        ▼
EmployerDomainAdapter
        │
──────────────── employer boundary ────────────────
        ▼
Employer-approved AI / code / storage / workflows
```

The personal system may know:

"2 work decisions need review"

without having access to the actual proprietary decision content.

That's a much more faithful implementation of:

> Data stays where it belongs. Intelligence comes to the data.

Update:

- plan §10;
- docs/domain-boundaries.md;
- threat model;
- context-package design;
- memory promotion rules;
- future HarnessAdapter behavior.

## 4. REQUIRED CHANGE — Add Authentication in Phase 1

Current plan

A15 defers transport authentication because the API binds to:

127.0.0.1

until a non-loopback caller exists.

Change this.

Loopback binding is a network boundary, not an identity boundary.

The same machine already hosts agents/processes that may eventually process untrusted content.

A compromised:

- browser;
- local process;
- agent;
- package;
- script

must not automatically receive Jehad OS authority simply because it runs on the same Mac.

Revision

Add minimal authentication immediately.

Do not build OAuth.

Use one of:

- random local bearer credential stored in macOS Keychain

or

- Unix-domain socket + filesystem permissions

A bearer token is probably simpler for later OpenClaw integration.

Minimum:

```
josctl
   │
   │ authenticated local request
   ▼
Jehad OS API
```

Future harness identities can then receive separate credentials.

Recommended future principal concept:

```ts
interface Principal {
  id: string;
  type: "user" | "harness" | "service" | "workflow";
}
```

A capability grant is issued to a principal/run, not merely assumed from network location.

Update M0/M2/M4

Authentication can be lightweight, but the primitive should exist before external harnesses attach.

## 5. REQUIRED CHANGE — Capability Grants Need Verifiable Possession

Plan §9 has the correct policy concept but is vague on how a harness proves it owns a grant.

Do not eventually send:

```json
{ "grantId": "123" }
```

and trust the caller.

Introduce a capability-token concept.

Possible design:

```
grant record stored canonically in Jehad OS

        +

opaque random capability token
or signed short-lived capability token
```

Example claims:

- principal
- run_id
- capability
- resource
- domain
- expires_at
- nonce

The token must be:

- short lived;
- scope limited;
- revocable;
- auditable;
- non-escalatable;
- unusable outside the granted resource/domain.

Exact implementation can remain Phase 2+.

But update the policy model now so capability grants are not merely database metadata.

## 6. REQUIRED CHANGE — External Actions Need Attempt / Outcome Semantics

Current plan

Plan §9 says audit is written before effect.

That is insufficient for external side effects.

Suppose:

```
audit says "send email"
        ↓
request sent
        ↓
network response lost
```

Did the email send?

The audit log cannot honestly say either:

- sent

or:

- not sent

without provider confirmation / reconciliation.

This problem appears everywhere:

- emails;
- calendar changes;
- purchases;
- external APIs;
- transfers;
- production operations.

Revision

Model external actions explicitly.

Suggested entities:

- action_intents
- action_attempts
- action_results

or equivalent.

State machine:

```
proposed
→ approved
→ prepared
→ executing
→ succeeded
→ failed
→ unknown
→ reconciled
```

At minimum distinguish:

- intent
- attempt
- observed outcome

Use provider idempotency keys when available.

Audit references these records rather than pretending the pre-effect audit entry proves completion.

Example:

```
ActionIntent #123
  send_email(to=X)

ActionAttempt #456
  provider=Gmail
  idempotency_key=...
  started_at=...

ActionResult
  state=unknown
  reason=response_timeout
```

A reconciliation workflow may later establish:

```
state=succeeded
provider_message_id=...
```

This is especially important because Finance eventually enters the same control plane.

Design correctly now.

## 7. REQUIRED CHANGE — Add Explicit Model / Data Egress Policy

Current capability model includes:

- call_model

That is too coarse.

The question is not merely:

Can this run call an LLM?

It is:

Is this specific data allowed to leave this domain and go to this provider/model?

This becomes critical for:

- employer data;
- financial data;
- sensitive personal content;
- future medical/private records;
- credentials;
- client data.

Revision

Add policy concepts such as:

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

Possible examples:

```
personal.normal
→ OpenRouter allowed

finance.sensitive
→ selected providers only

work.remote-employer
→ personal model providers forbidden

secret
→ never included in model context
```

Context building must call policy before provider dispatch.

Do not rely on prompts saying "don't expose this."

Update:

- policy model;
- threat model;
- ModelProvider interface;
- context-package path.

## 8. REQUIRED CHANGE — Tighten Memory Promotion Semantics

Plan §6.2 says semantic writes go to review unless:

(a) source is the user directly
or
(b) class is episodic

The episodic exception is fine.

The user-source exception needs refinement.

A direct statement by Jehad can canonically establish:

- preference
- intent
- commitment
- personal decision
- self-declared plan

Example:

"I prefer notifications after Dhuhr."

That can become a direct preference.

But a user statement should not automatically establish an external objective fact:

"Company X has 3 million customers."

That remains a user-supplied claim unless independently verified.

Revision

Represent provenance/truth type explicitly.

Possible:

```ts
type AssertionKind =
  | "observed"
  | "user_declared"
  | "externally_sourced"
  | "model_inferred"
  | "computed";
```

And:

```
user_declared + preference
→ canonical preference

user_declared + personal commitment
→ canonical commitment

user_declared + external-world claim
→ claim requiring evidence, not canonical fact
```

The system must distinguish:

Jehad said X

from:

X is true.

This will matter enormously once the research and finance domains exist.

## 9. REQUIRED CHANGE — Add First-Class Relationships / Dependencies

Schema v1 has:

- entities
- commitments
- decisions
- assumptions

but lacks a clean first-class relationship/dependency representation.

Yet one of the central Jehad OS questions is:

What should I decide next to unlock the most downstream work?

You cannot answer that robustly from:

blocked_by[]

arrays embedded inside commitments.

Revision

Add a minimal relationship/edge table.

Do not build a graph database.

Postgres is enough.

Suggested:

```
relationships
-------------
id
domain_id
from_type
from_id
relation
to_type
to_id
source_event_id
confidence
valid_from
valid_until
metadata
```

Examples:

```
work_item → blocked_by → decision
commitment → concerns → project
decision → affects → project
person → owns → work_item
assumption → supported_by → evidence
artifact → produced_by → run
```

If polymorphic foreign keys feel too loose, use a smaller explicit dependency table first.

At minimum:

```
dependencies
------------
upstream_type
upstream_id
downstream_type
downstream_id
relation
```

The goal is to support:

- downstream unlock count
- critical path
- blocker propagation
- attention leverage

without encoding graph relationships inside JSON arrays.

## 10. REQUIRED CHANGE — Normalize Decision Assumptions

Current schema stores assumptions in two places:

- decisions.assumptions jsonb

and

- assumptions

That creates two possible sources of truth.

Revision

Choose one canonical representation.

Recommended:

```
decisions
---------
question
chosen
reasons
...

assumptions
-----------
decision_id
statement
status
last_checked_at
...

revisit_conditions
------------------
decision_id
condition
status
...
```

decisions.assumptions may exist as a read-model/projection if necessary, but not as independently editable canonical state.

Same principle for alternatives if they eventually need first-class evidence.

## 11. REQUIRED CHANGE — Artifact Durability / Backup

Plan M1 proposes:

- nightly pg_dump

while artifacts may live under:

- data/artifacts/

pg_dump does not back up those files.

That means a system restore can recover rows while silently losing:

- briefs;
- eval reports;
- future documents;
- run artifacts;
- potentially evidence.

Revision

For Phase 1 choose one explicit strategy:

Option A — PostgreSQL for small artifacts

Store small textual artifacts directly in Postgres.

Simplest for Phase 1.

Option B — filesystem + separate backup manifest

If filesystem artifacts remain:

```
artifact row
  path
  sha256
  size
  storage_backend
```

and backup/restore must include the artifact directory.

M1's practiced restore must verify both:

- database state
- +
- artifact content

Object storage remains later.

Also consider encryption-at-rest for sensitive local artifact files.

## 12. REQUIRED CHANGE — Remove Personal PII From Architecture Docs

Plan §2.2 currently includes a personal phone number.

That information is unnecessary to the architecture plan.

Remove it.

Architecture docs should use identifiers such as:

- Jehad
- Yusra
- household_owner
- primary_user

Do not put:

- phone numbers;
- credentials;
- personal addresses;
- account IDs;
- API keys

into design documentation unless indispensable.

If contact routing later requires a phone identifier, store it in protected runtime state/config and reference it by logical ID.

## 13. REQUIRED CHANGE — Improve Evals

Current commitment extraction eval:

- 25-item golden set
- target ≥ 0.8 F1

This is adequate as a bootstrap smoke test but not adequate to justify meaningful autonomy.

The system's biggest mistakes are asymmetric.

Missing:

"I'll send it Friday"

is annoying.

Inventing:

"Jehad promised $50,000 by Friday"

is much worse.

Revision

Track more than one aggregate score.

For commitment extraction include:

- precision
- recall
- false-positive rate
- due-date accuracy
- direction accuracy
- counterparty accuracy
- confidence calibration

For actions driven by extracted commitments, prioritize high precision.

Add hard cases:

- quoted speech
- hypotheticals
- jokes
- forwarded emails
- negation
- changed commitments
- renegotiated dates
- "maybe"
- "should"
- "we could"
- third-party promises
- historical commitments
- email signatures
- prompt-injection text

Example:

"John said yesterday that he would send it Friday."

must not become:

Jehad owes John something Friday.

Similarly memory promotion eval should distinguish:

- preference
- objective claim
- decision
- commitment
- inference
- episodic-only
- discard

Keep the current tiny sets for M5 if needed, but label them bootstrap evals, not sufficient evidence for broad autonomy.

## 14. REQUIRED CHANGE — Clarify Human-Blocked-Time Semantics

runs.human_blocked_ms is currently proposed as a field.

A single aggregate field risks becoming inaccurate once one run has multiple waits.

Model the raw intervals.

Suggested:

```
human_waits
-----------
id
run_id
escalation_id
started_at
resolved_at
reason
```

Then derive:

- human_blocked_ms

as a projection/metric.

This enables:

- multiple waits;
- cause analysis;
- percentile metrics;
- identifying repeated decision bottlenecks.

Do not make the metric itself the only historical data.

## 15. REQUIRED CHANGE — Clarify Phase 1 vs Program-Level v1

The plan correctly notes that the directive's twenty v1 success criteria are broader than a single milestone.

Keep that pushback.

But make terminology unambiguous.

Use:

- Kernel Phase 1 acceptance

for M2–M6.

Reserve:

- Jehad OS v1

for the broader directive-level product maturity milestone.

Otherwise six months later the repo will contain contradictory statements like:

"v1 complete"

while:

- HarnessAdapter isn't exercised;
- OpenClaw isn't policy-gated;
- delegation isn't implemented;
- worker verification isn't implemented.

Suggested hierarchy:

```
Phase 0 — Kernel architecture

Phase 1 — Kernel + personal-ops seed slice

Phase 2 — Authorized personal integrations

Phase 3 — Delegation / harness execution

...

Product v1 — Directive §40 program-level acceptance
```

## 16. RECOMMENDED CHANGE — Procedural Memory Ownership

Plan §5 currently makes:

- packages/core/procedures

the canonical procedural-memory store.

Directionally correct: procedural memory should be version-controlled.

But avoid coupling procedural knowledge to compiled application code.

Prefer something like:

```
procedures/
  engineering/
  research/
  personal-ops/
  finance/
```

with:

- Markdown
- YAML
- JSON

and a typed loader/index.

Why:

- inspectable by humans;
- usable by Hermes;
- usable by Claude Code;
- diffable;
- versioned independently of binaries;
- portable into employer environments;
- easier for agents to propose edits.

packages/core can own the procedure schema/loader, not necessarily the procedure documents themselves.

## 17. RECOMMENDED CHANGE — Treat "Silently Stalled" as Derived State

Do not create a permanent status:

- silently_stalled

unless necessary.

It is better modeled as a derived condition:

```
open
AND
no meaningful progress event for N days
AND
not explicitly waiting
AND
not deferred
```

The threshold can differ by project/type.

This makes Watch behavior configurable rather than baking an arbitrary status into workflow semantics.

## 18. RECOMMENDED CHANGE — Event Type Compatibility

The noun-first naming decision:

- commitment.detected
- decision.recorded

is fine.

Approve D4.

But establish now:

- event names are immutable contracts once released;
- payloads have explicit schema versions;
- consumers tolerate additive fields;
- breaking payload changes create a new version.

Example:

```json
{
  "type": "commitment.detected",
  "schemaVersion": 1,
  "payload": {}
}
```

This becomes useful once OpenClaw, remote work domains, or multiple workers consume the event stream.

## 19. RECOMMENDED CHANGE — Separate Observed Time From Effective Time

The event envelope already has:

- occurredAt
- recordedAt

Good.

Use the same thinking for semantic facts.

A fact can be:

- learned today
- effective since last week
- superseded tomorrow

For facts where it matters, support:

- valid_from
- valid_until
- observed_at

Do not add these columns to every table prematurely.

But include temporal validity in the world-model design now.

This is especially important later for:

- employment;
- recurring expenses;
- financial holdings;
- project ownership;
- policies;
- relationship state;
- decisions/assumptions.

## 20. RECOMMENDED CHANGE — Research / Evidence Primitive Earlier Than Full Research Vertical

Do not build the research engine yet.

However, add a minimal evidence concept early enough that decisions and claims can point to provenance.

Suggested future-compatible entity:

```
evidence
--------
id
domain_id
source_type
source_ref
claim
observed_at
confidence
metadata
```

Then:

```
decision → supported_by → evidence
assumption → supported_by → evidence
memory_candidate → derived_from → evidence
```

The initial vertical may barely use this.

But avoiding an evidence primitive entirely makes later migration harder because decision provenance becomes embedded only in JSON.

## 21. Recommended E1–E5 Answers

Pass these back as the reviewer's recommended disposition.

E1 — Repo split

Approve default: YES.

Keep:

- ~/Projects/jehad-os

as core/control plane.

Keep:

- /Users/Shared/tito

as OpenClaw/Home Assistant edge project.

Do not merge the repos.

The separation reinforces the architecture.

E2 — Cloud hosting

Approve default: DEFER.

Local kernel development is correct.

However:

- build cloud-compatible assumptions;
- do not use Mac-specific behavior inside core;
- define backup/restore now;
- keep deployment concerns behind configuration.

E2 should occur before personal cloud integrations become operationally important.

E3 — First personal sources

Approve default: NONE UNTIL EXPLICIT AUTHORIZATION.

Recommended eventual order remains:

- Google Calendar
- → Gmail

because Calendar is lower-volume and structurally easier for the first live ingestion path.

Do not let source authorization block kernel development.

E4 — OpenClaw grant scope

Approve default: READ / DELIVERY ONLY FIRST.

Initial OpenClaw capabilities should be approximately:

- receive channel messages
- deliver approved notifications
- query explicitly exposed Jehad OS read endpoints

No generic shell privilege via Jehad OS.

No unrestricted external actions.

Expand capabilities only after policy/audit tests exist.

E5 — D1/D2/D3

D1 Workflow runtime

Do NOT bless current D1.

Revise to evaluate/use Inngest first as described in this review.

Do not write our own workflow engine without a demonstrated blocker.

D2 Hermes

Bless.

Hermes remains an unevaluated, replaceable cognitive-shell candidate.

Do not install or architect around Hermes during the kernel stage merely because the directive named it.

Preserve the slot/interface.

D3 CLI first

Bless.

No web UI needed for Phase 1.

The CLI is sufficient for proving the kernel.

D4 Event naming

Bless.

Noun-first is fine.

Add schema-version compatibility rules.

D5 Broad v1 criteria

Bless conceptually.

Rename milestones so:

Phase 1 completion

does not imply:

Jehad OS product v1 complete.

## 22. Revised Build Order

After these changes, recommended sequence:

```
Phase 0 docs
    ↓
M0 toolchain / repo / auth primitive
    ↓
M1 schema + backup/restore
    ↓
M2 event ingest + outbox + CLI
    ↓
M3 Inngest WorkflowRuntime adapter
    ↓
M4 policy + principals + capabilities + audit/action semantics
    ↓
M5 model provider + extraction + memory promotion
    ↓
M6 personal-ops seed slice
```

Alongside M1–M4 introduce only the minimal abstractions for:

- DomainBackend
- HarnessAdapter
- IntegrationAdapter
- WorkflowRuntime
- Principal
- CapabilityGrant

Do not implement unused concrete adapters merely to satisfy diagrams.

## 23. Revised Schema Additions / Changes

Do not blindly add dozens of tables.

For schema v1, revise the current proposal roughly as follows.

### Keep

- domains
- events
- outbox
- entities
- commitments
- decisions
- memory_candidates
- procedures/index
- runs
- artifacts
- capability_grants
- audit_log
- escalations
- model_calls

### Normalize

Remove canonical:

- decisions.assumptions jsonb

in favor of:

- assumptions

Potentially normalize revisit conditions as well.

### Add early

Strongly consider:

- principals
- relationships OR dependencies
- human_waits
- action_intents
- action_attempts

Potentially:

- evidence

if this can remain minimal.

### Add metadata / concepts

- events.schema_version
- domains.storage_mode
- artifacts.storage_backend
- facts/assertions provenance kind

Do not overbuild the schema purely because these concepts exist.

The goal is to prevent later architectural dead ends.

## 24. Updated Threat Model Items

Add these to plan §11.

T11 — Local unauthenticated API access

- Vector: malicious local process/browser/harness.
- Mitigation: local identity credential; deny unauthenticated calls.

T12 — Model egress violation

- Vector: sensitive domain content sent to unauthorized provider/model.
- Mitigation: provider/domain/sensitivity egress policy before context leaves control plane.

T13 — External action ambiguity

- Vector: network timeout after non-idempotent side effect.
- Mitigation: intent/attempt/result state, provider idempotency keys, reconciliation.

T14 — False semantic canonization

- Vector: user statement or model inference promoted as objective fact.
- Mitigation: assertion/provenance kind; external claims remain claims until supported.

T15 — Employer perimeter violation

- Vector: proprietary future-employer state stored in personal Postgres or sent to personal model provider.
- Mitigation: remote/opaque DomainBackend; provider egress policy; domain-local intelligence.

T16 — Artifact backup gap

- Vector: Postgres restored but filesystem artifacts lost.
- Mitigation: unified backup/restore verification or store small artifacts in Postgres initially.

## 25. Additional Acceptance Tests

Add these to the relevant milestones.

Authentication

- unauthenticated localhost request
  → rejected

Domain isolation

- remote/opaque domain
  → personal DB receives no prohibited semantic payload

The Phase-1 implementation can use a fake adapter to prove the architecture.

Model egress

- finance/work-sensitive context
  +
  unauthorized model provider
  → denied before model call

External action semantics

- action attempt times out after dispatch
  → state becomes UNKNOWN
  → audit does not falsely claim success

Memory truth semantics

- user says:
  "Company X has 3 million customers"
  → persisted as user-supplied claim / episode
  → not silently promoted to verified semantic fact

Dependency leverage

Create:

- Decision A blocks Task B, C, D
- Decision E blocks Task F

Query:

- highest-leverage unresolved decision

Expected:

- Decision A

based on explicit dependency graph, not LLM guessing.

Backup

- create state + artifact
  → backup
  → destroy local state
  → restore
  → database + artifact both verifiably restored

## 26. What NOT to Change

Do not use this review as justification to increase scope.

Still do not build yet:

- finance vertical;
- research engine;
- home digital twin;
- wardrobe;
- synthetic customers;
- web UI;
- mobile app;
- full Hermes integration;
- coding-worker orchestration;
- vector search;
- multi-user support;
- complex cloud deployment;
- OAuth integrations;
- generalized ontology;
- graph database;
- Kafka;
- Kubernetes;
- microservices.

The changes above are about correct boundaries, not adding verticals.

## 27. Required Dev-Agent Response

Revise phase0.md and the Phase-0 docs to incorporate the approved changes.

Do not start broad implementation until the plan has been reconciled.

Return a concise change report containing:

- Accepted changes
- Rejected changes + reasoning
- Updated ADR decisions
- Updated schema differences
- Updated threat model
- Updated milestones
- Remaining decisions requiring Jehad

If a recommendation creates substantial complexity in Phase 1, preserve the interface and invariant now and defer the concrete implementation.

The design goal remains:

build the smallest kernel that preserves the correct long-term boundaries.

Do not optimize for architectural purity at the expense of shipping the first useful vertical.

But do not knowingly build foundational semantics that we already expect to replace.

## 28. Final Disposition

Phase 0 direction: APPROVED.

M1–M6 implementation: APPROVED AFTER PLAN REVISION.

Most of the plan is strong.

The highest-priority corrections are:

1. Inngest instead of bespoke durable-workflow engine
2. DomainBackend / physical employer-data boundary
3. local authentication now
4. action intent/attempt/outcome semantics
5. model-egress policy
6. semantic-memory truth semantics
7. explicit relationships/dependencies
8. normalized assumptions
9. artifact-aware backups

Resolve those at the architecture level, keep implementation minimal, and then proceed.
