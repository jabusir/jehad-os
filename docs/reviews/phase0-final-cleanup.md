# Jehad OS — Phase 0 Revision 2 Final Cleanup

**Review target:** `phase0 2.md`  
**Disposition:** **Architecture approved; apply the cleanup items below before implementation begins.**

Revision 2 incorporated the external review extremely well. The remaining issues are mostly internal consistency problems, not architectural disagreements.

Do **not** reopen broad design decisions or add new vertical scope.

---

## 1. REQUIRED — Resolve HarnessAdapter / IntegrationAdapter Phase Contradiction

The plan currently says two different things.

Plan §15 says that alongside M1–M4 the following minimal abstractions are introduced:

```text
DomainBackend
HarnessAdapter
IntegrationAdapter
WorkflowRuntime
Principal
CapabilityGrant
```

But later in the same section it says:

```text
HarnessAdapter is deferred to Phase 3
IntegrationAdapter is defined at E3 / first authorized source
```

These are contradictory.

### Fix

Use this rule:

```text
Phase 1
-------
HarnessAdapter interface: DEFINE
IntegrationAdapter interface: DEFINE

Phase 2
-------
First real IntegrationAdapter implementation

Phase 3
-------
First real HarnessAdapter implementation
```

The distinction is:

> **Define the port now; implement the adapter only when needed.**

This matches the governing principle already stated in the plan:

> preserve interface + invariant now, defer concrete implementation when unnecessary.

Update plan §15 and any artifact that implies the interfaces themselves are deferred.

No concrete Claude Code, Codex, Hermes, OpenClaw action adapter, Gmail adapter, etc. should be built merely to exercise the interfaces.

---

## 2. REQUIRED — Fix M0 Authentication Dependency on the M1 Schema

M0 currently requires:

```text
principals table
+
local bearer credential
+
API rejects unauthenticated calls
```

But the general schema migration milestone is M1.

That makes M0 depend on a table that technically does not exist until M1.

### Fix

Create a **minimal bootstrap migration** as part of M0 containing only the authentication primitive required to secure the API.

For example:

```text
000_bootstrap_auth.sql

principals
-----------
id
type
name
credential_hash
created_at
```

Then M1 applies the full kernel schema migrations.

Alternative implementations are acceptable, but the invariant is:

> The API must never exist in an unauthenticated state merely because the full world-model schema has not yet landed.

Keep:

```text
127.0.0.1
+
authenticated principal
```

as defense-in-depth.

Document the bootstrap migration explicitly so M0/M1 ownership is unambiguous.

---

## 3. REQUIRED — Tighten `opaque` Domain Semantics

Revision 2 correctly adds:

```text
local
remote
federated
opaque
```

However, the memory section says remote/opaque domains can contribute sanitized state such as:

```text
"2 work decisions need review"
```

while the domain section defines `opaque` as a domain where the personal control plane stores no proprietary content.

Those semantics should be separated more clearly.

### Fix

Use:

### `local`

Canonical domain data may live in Jehad OS.

### `remote`

Canonical state remains in the remote environment.

Jehad OS may receive responses allowed by policy.

### `federated`

A deliberately defined, sanitized subset of metadata may cross the boundary.

Example:

```text
2 decisions need review
1 approval pending
adapter healthy
```

### `opaque`

**Zero domain-content export by default.**

The personal Jehad OS may know only:

```text
domain exists
adapter availability / health, if policy permits
capability availability, if policy permits
```

It must not assume that counts, titles, summaries, deadlines, project names, or decision metadata may cross the boundary.

Therefore move:

```text
"2 work decisions need review"
```

from the `opaque` example to the `federated` example.

The rule should be:

> `opaque` means no semantic payload crosses the boundary unless the domain policy is explicitly changed.

Update:

- plan §6.2;
- plan §10;
- domain-boundaries doc;
- fake DomainBackend tests.

---

## 4. REQUIRED — Cross-Domain Queries Cannot Be Audit-Only Forever

Plan §10 currently says:

> Cross-domain queries exist only in the audit surface.

That is too restrictive for the actual product.

Eventually Jehad OS must support safe questions such as:

```text
What requires my attention today?
```

which may legitimately combine:

```text
personal calendar
personal commitments
finance alerts
research watches
household state
```

Likewise:

```text
What changed while I was away?
```

is inherently a cross-domain query.

The security goal is not:

> never compose domains.

It is:

> never allow uncontrolled cross-domain access or leakage.

### Fix

Replace the audit-only rule with:

> **Raw cross-domain data access is denied by default. Cross-domain composition is allowed only through an explicit policy-mediated aggregation layer.**

Conceptually:

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

The aggregation layer should request the **minimum necessary projection** from each domain.

Example:

```text
personal domain
→ 2 commitments due

finance domain
→ 1 attention item

research domain
→ 0 urgent changes
```

The final "Today" view may combine those counts/items without giving one domain unrestricted access to another.

For:

```text
remote
federated
opaque
```

the `DomainBackend` controls what projection may leave the remote boundary.

### Important

Do not implement a sophisticated federation/query engine in Phase 1.

Only correct the architecture/invariant now.

Phase 1 may still operate almost entirely in the `personal` domain.

The long-term invariant is:

```text
cross-domain composition:
explicit
policy-gated
least-data
provenance-preserving

raw arbitrary cross-domain joins:
forbidden
```

---

## 5. RECOMMENDED — Clarify Action State Ownership

The prose state machine says:

```text
proposed
→ approved
→ prepared
→ executing
→ succeeded | failed | unknown
→ reconciled
```

But the schema divides state across:

```text
action_intents
action_attempts
```

and `action_intents.status` currently lists only:

```text
proposed
approved
prepared
```

That is fine architecturally, but make the ownership explicit so implementation does not create two competing state machines.

### Fix

Recommended semantics:

```text
ActionIntent.status
-------------------
proposed
approved
prepared
cancelled

ActionAttempt.outcome
---------------------
executing
succeeded
failed
unknown
reconciled
```

Or equivalent.

The combined lifecycle may still be presented as:

```text
intent proposed
→ approved
→ prepared
→ attempt executing
→ attempt outcome
```

But there must be only one canonical location for each state.

Also allow:

```text
one ActionIntent
→ multiple ActionAttempts
```

for legitimate retries/reconciliation.

Do not let retrying overwrite the history of an earlier ambiguous attempt.

---

## 6. RECOMMENDED — Treat Inngest as Workflow Execution, Not Necessarily a Long-Running "Worker Process"

The architecture currently describes:

```text
apps/worker/
  Inngest worker host
```

This may be correct depending on the final runtime/deployment mode, but avoid prematurely assuming a traditional always-running queue-worker topology.

The important boundary is:

```text
WorkflowRuntime
    ↓
Inngest implementation
```

not:

```text
Jehad OS must permanently own a traditional worker daemon
```

### Fix

Rename conceptually if useful:

```text
apps/workflows/
```

or keep `apps/worker/`, but document that its responsibility is:

> register/serve workflow functions and runtime integration required by the selected Inngest deployment model.

Do not bake process-topology assumptions into `packages/core`.

The M3 spike should determine the concrete development/runtime shape.

---

# 7. Explicitly Preserve the Interaction / Observability Future

No UI should be added to Phase 1.

CLI-first remains correct.

However, add a short roadmap/design note so the kernel does not accidentally assume the CLI is the permanent product surface.

Future Jehad OS should support multiple interaction surfaces over the same control plane:

```text
conversational shell
desktop/web control center
command palette
mobile messaging
CLI
voice
passive notifications / briefings
```

These surfaces ultimately support five core user verbs:

```text
ASK
TELL
DELEGATE
REVIEW
INSPECT
```

The control plane remains authoritative regardless of surface.

### Visibility requirements to preserve

Future interfaces must be able to expose:

```text
What is running?
What completed?
What failed?
What is waiting?
What needs me?
What does the system believe?
Why does it believe that?
What is stored?
Which source produced it?
Which model/harness acted?
What capability did it receive?
What external action occurred?
What did it cost?
Can it be undone?
```

This is **not a Phase-1 UI requirement**.

It is an observability/product invariant.

The existing schema already provides most of the required primitives:

```text
events
runs
artifacts
audit_log
model_calls
capability_grants
action_intents
action_attempts
escalations
memory / evidence
```

Add an `interaction-observability.md` or roadmap subsection later if useful, but do not delay kernel implementation for UI design.

---

# 8. Explicitly Preserve the Future Observation / Sensor Layer

Do not wire real sources yet.

The current CLI-first plan is correct.

However, document the future observation model so the SourceAdapter/event design remains sufficient for:

```text
Calendar
Email
Slack
Granola / meeting notes
iMessage / messaging
GitHub
Linear
financial accounts
voice/manual capture
public web/research
home/device events
```

The product model is:

```text
authorized source
→ SourceAdapter
→ normalized observation/event
→ extraction / policy
→ world-model update
→ watcher/workflow
→ action or attention item
```

Observation mechanisms may be:

```text
push / webhook
poll / cursor
explicit user capture
derived state change
```

Do not ingest everything merely because a connector exists.

The connector should exist only when the system knows what useful state it intends to derive.

Again:

> architecture now, wiring later.

No new Phase-1 integration work is requested.

---

# 9. Revised Final Disposition

After the four required cleanup edits:

```text
1. HarnessAdapter / IntegrationAdapter phase consistency
2. M0 auth bootstrap migration
3. strict opaque-domain semantics
4. policy-mediated cross-domain composition
```

the architecture is approved to proceed.

The two action/runtime clarifications and the interaction/observation roadmap notes are recommended but should remain lightweight.

Do **not** use this cleanup as justification to reopen:

```text
Inngest decision
Postgres canonical state
OpenClaw boundary
Hermes deferral
CLI-first execution
finance deferral
external integrations
web UI
voice
synthetic customers
research engine
cloud hosting
```

The kernel should now move from planning into implementation.

---

## Required Dev-Agent Response

Apply these changes to `phase0.md` and affected Phase-0 artifacts.

Return only:

```text
Changes applied
Any disagreement + reason
Files/ADRs affected
Whether Phase 0 is now implementation-ready
```

If there is no substantive disagreement after these edits, proceed with the existing Phase-0/M0 sequence rather than initiating another broad architecture review.
