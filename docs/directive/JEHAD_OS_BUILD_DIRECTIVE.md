# Build Directive: Jehad OS — Personal AI Control Plane

## Mission

Build **Jehad OS**, a durable personal AI control plane that reduces the amount of human attention required to operate work, finances, research, personal administration, learning, and long-running projects.

The system is **not** a chatbot wrapper, a to-do app, a collection of named agents, or an AI dashboard full of summaries.

Its purpose is to maintain structured state about the user's world, detect what changed, decide what can proceed autonomously, execute bounded work safely, verify results independently, remember durable decisions, and surface only the smallest amount of human judgment required.

The core design principle is:

> **Jehad's attention is an expensive dependency.**

Every workflow should ask:

1. Can this proceed correctly without Jehad?
2. If not, what is the smallest piece of judgment or approval required?
3. Can that request be batched with other requests instead of interrupting him now?
4. Can the lesson from this intervention reduce future dependence on him?

Two additional principles are non-negotiable:

> **Data stays where it belongs. Intelligence comes to the data.**

> **The operating model must survive the loss of any particular integration, employer, model provider, or device.**

---

# 1. Product Model

Jehad OS should continuously run this loop:

```text
Observe
  ↓
Understand
  ↓
Route
  ↓
Act
  ↓
Verify
  ↓
Remember
  ↓
Escalate only when necessary
```

All work should dynamically use one of three interaction modes.

## Pair Mode

```text
Jehad ↔ AI ↔ Jehad ↔ AI
```

Use when the problem is still being discovered through interaction.

Good examples:

- architecture
- debugging
- strategy
- product thinking
- difficult writing
- design exploration
- negotiation preparation
- learning hard concepts
- ambiguous requirements

Pair mode is high-bandwidth and synchronous. Human reactions are part of the information.

## Delegate Mode

```text
Jehad → intent → workers → verification → result / exception
```

Use when the goal is clear enough that continued human supervision adds little value.

Examples:

- implement a bounded change
- investigate an issue
- compare alternatives
- produce assets
- research a market
- perform reconciliation
- prepare a document
- run tests
- organize information

The system should work asynchronously and return a **verified artifact**, not a stream of status updates.

## Watch Mode

```text
world event → system → analysis/action → exception if necessary
```

No user prompt is required.

Examples:

- a PR violates an architecture invariant
- a decision assumption becomes false
- a competitor changes pricing
- a recurring expense rises unexpectedly
- someone misses a commitment
- a synthetic customer journey fails
- an account shows anomalous activity
- a project silently stalls
- a dependency changes materially

### Work should migrate across modes

The natural lifecycle is:

```text
Pair → Delegate → Watch
```

Example:

1. Pair to reason through transfer reversal semantics.
2. Record the decision and invariants.
3. Delegate implementation and tests.
4. Watch future code for violations of those invariants.

Do not hard-code workflows permanently into one mode.

---

# 2. What This System Is Not

Do **not** build:

- a giant chat interface with memory
- a collection of 20 "agent personalities"
- a generic productivity dashboard
- a clone of Notion, Todoist, Linear, or Mint
- an LLM acting as the primary database
- an autonomous system with unrestricted production or financial permissions
- a system that assumes permanent access to proprietary employer data
- a system whose usefulness collapses if Gmail, GitHub, Claude, OpenAI, a Mac Mini, or any one provider becomes unavailable

The durable product is the **control plane and operating model**, not the integrations.

---

# 3. Architectural Principles

## 3.1 Structured state is authoritative

LLM context and model memory are never the source of truth.

Use structured persistent storage for durable state.

Recommended default:

- PostgreSQL as the authoritative relational store
- object/blob storage for artifacts
- semantic/vector index only as a retrieval aid
- append-only event log for important state changes
- durable job/workflow queue for asynchronous work

The system should be reconstructable from persisted state and events without relying on a model remembering prior conversations.

## 3.2 Models are replaceable workers

Models reason over state and perform bounded actions.

They should not own state.

Provider/model interfaces should be abstracted enough that individual workflows can use different models or providers.

## 3.3 Cloud is the authoritative brain

Do not make a personal laptop or Mac Mini authoritative.

Cloud infrastructure owns:

- canonical state
- orchestration
- workflow queues
- policy
- audit logs
- scheduling
- core APIs

Local machines may act as **trusted edge nodes** for:

- local files
- HomeKit / Sonos / home network
- private local inference
- device automation
- privacy-sensitive workloads
- employer-approved local tooling

If a local node is offline, the rest of Jehad OS continues operating.

## 3.4 One shared control plane, many bounded domains

Use a common orchestration layer and shared data model, but isolate sensitive domains.

At minimum support the concept of:

```text
Personal domain
Current startup/work domain
Future employer domain
Finance domain
Research domain
Learning domain
Creative/project domains
```

These do not all have equal permissions or data retention.

---

## 3.5 Memory Architecture

Do not treat "memory" as one subsystem.

Jehad OS should explicitly distinguish four memory classes:

### Working memory

Current task/session state.

Characteristics:

- ephemeral
- high relevance to the current interaction
- may live primarily inside the active cognitive harness
- should not automatically become durable memory

Examples:

- current debugging hypothesis
- temporary scratchpad
- current conversation context
- intermediate plan

### Episodic memory

> What happened?

Examples:

- conversations
- meetings
- agent runs
- incidents
- completed workflows
- past interactions
- historical project activity

Characteristics:

- append-heavy
- timestamped
- searchable
- provenance-preserving
- may use relational storage + object storage + semantic retrieval

### Semantic memory

> What is currently believed to be true?

Examples:

- people
- projects
- commitments
- decisions
- assumptions
- policies
- architectural invariants
- account metadata
- preferences
- verified facts

Characteristics:

- structured
- canonical where appropriate
- explicit provenance
- confidence where inference is involved
- conflict resolution
- update semantics

PostgreSQL / the Jehad OS world model owns this layer.

### Procedural memory

> How do we do things?

Examples:

- playbooks
- coding/review procedures
- migration process
- research workflow
- financial review workflow
- design-generation procedure
- context-packaging recipes
- user-specific working conventions

Characteristics:

- versionable
- inspectable
- reusable
- ideally stored as skills/playbooks rather than opaque model memory

A cognitive harness such as Hermes is a strong candidate for procedural memory and small always-hot user/context files, but it is not the canonical store for financial facts, commitments, decisions, evidence, or domain state.

### Memory promotion

A cognitive harness may propose that something should become durable memory.

It must not silently promote every conversation statement into canonical truth.

A proposed memory should be classified as one of:

```text
discard
working context
episodic event
semantic fact
preference
commitment
decision
assumption
procedural skill
policy
```

Jehad OS applies provenance, scope, sensitivity, and domain-retention rules before persistence.


# 4. Hard Data Boundaries

This is a first-class architectural requirement.

Jehad currently works at a very small startup and may have unusually broad code/tool access. A future employer may prohibit access from personal devices or external AI systems.

Design for both realities.

## 4.1 Personal state

This may persist long term and belongs to the user.

Examples:

- personal calendar
- personal email-derived commitments
- personal research
- financial state
- household
- purchases
- wardrobe
- travel
- learning
- religious study
- personal projects
- business ideas
- future agency infrastructure
- personal professional-development history

## 4.2 Professional operating model

The user should be able to retain reusable **methods** across employers:

- Pair / Delegate / Watch
- builder/verifier separation
- architecture invariants
- synthetic user methodology
- decision ledgers
- context packaging
- confidence-based escalation
- human-blocked-time metrics
- agent permission patterns
- verification/evaluation methods

These patterns are portable.

## 4.3 Employer-specific state

Employer-specific code, documents, architecture, Slack content, incidents, credentials, customer information, and proprietary decisions must remain isolated inside the authorized work domain.

Treat employer-specific state as a detachable module.

When access ends, the module can be revoked/deleted without breaking the personal system.

Do not silently copy proprietary work detail into personal long-term memory.

It is acceptable to persist abstract professional learning such as:

> "User has experience with webhook idempotency and reconciliation systems."

It is not acceptable to persist:

> "Employer X has vulnerability Y in table Z."

## 4.4 Intelligence comes to the data

If a future employer permits only internal AI tooling, Jehad OS should not attempt to exfiltrate context.

Instead, recreate the operating pattern inside the employer-approved environment.

The system must degrade gracefully when a work-domain adapter is unavailable.

---

# 5. Core Data Model / World Model

Do not begin with prose memory. Begin with entities and relationships.

The model should support at least:

```text
Person
Organization
Project
Domain
Goal
Task
WorkItem
Commitment
Decision
Assumption
Question
Risk
Event
Artifact
Document
Conversation
Account
Transaction
Holding
Liability
RecurringExpense
Metric
Source
Evidence
Policy
Permission
AgentRun
Verification
Escalation
SyntheticPersona
Experiment
Opportunity
```

Relationships should be first-class.

Examples:

```text
Person → owns → WorkItem
Person → promised → Commitment
Commitment → blocks → Project
Decision → depends_on → Assumption
Assumption → supported_by → Evidence
PR → violates → Invariant
Transaction → belongs_to → Account
RecurringExpense → charged_to → Account
Opportunity → tested_by → Experiment
```

Every important record should include provenance:

- source
- created_at
- updated_at
- confidence where relevant
- sensitivity classification
- domain
- retention policy
- last_verified_at where relevant

Do not force all data into one generic JSON "memory" table.

---

# 6. Event Layer

Jehad OS should be event-driven.

Normalize external changes into a common event model.

Examples:

```text
email.received
calendar.event_created
calendar.event_changed
github.pr_opened
github.pr_merged
github.issue_changed
linear.issue_changed
document.updated
commitment.due
commitment.overdue
decision.assumption_changed
finance.transaction_posted
finance.recurring_price_changed
portfolio.threshold_crossed
agent.task_completed
agent.task_failed
verification.failed
synthetic_journey.failed
research.claim_changed
```

Events should be:

- immutable once accepted
- attributable to a source
- idempotent
- replayable where feasible
- safe to process more than once

Use idempotency keys.

---

# 7. Commitment Graph

This is an early high-value feature.

Extract commitments from communication and user input:

- who owes what
- to whom
- by when
- confidence
- source
- dependencies
- status
- whether the system may follow up automatically

Examples:

> "I'll send the revised proof Friday."

> "Let's revisit this after launch."

> "Can you get me the migration plan tomorrow?"

The system should detect:

- waiting on Jehad
- waiting on someone else
- silently stalled
- overdue
- blocked by another item

It should support queries such as:

- What am I waiting for?
- What is waiting on me?
- What is silently stalled?
- What is the highest-leverage thing I can unblock?
- What commitment is likely to be forgotten?

Do not spam reminders. Batch unless urgency justifies interruption.

---

# 8. Decision Engine

This is core infrastructure.

A decision record should support:

```text
decision
date
domain
context
alternatives considered
chosen option
reasons
assumptions
evidence
risks
revisit conditions
owner
confidence
linked artifacts
```

Example:

```text
Decision:
Use architecture A.

Rejected:
B
C

Reasons:
...

Assumptions:
Provider supports X.
Volume remains below Y.

Revisit if:
Provider removes X.
Volume exceeds Y.
Latency exceeds Z.
```

## 8.1 Assumption monitoring

Watch mode should periodically or event-drivenly check whether decision assumptions still hold.

If an assumption changes, surface:

- which decision depends on it
- what changed
- evidence
- likely impact
- whether re-evaluation is warranted

Do not automatically reverse consequential decisions.

## 8.2 Pre-mortem

Before high-consequence decisions, run an adversarial pre-mortem:

> Assume this decision was made and became a serious mistake. What are the most plausible reasons?

Then research the strongest failure modes.

The system should challenge reasoning, not flatter the user.

---

# 9. Agency Router

Build a routing layer that determines how much autonomy a work item receives.

Inputs should include at least:

```text
uncertainty
risk
reversibility
consequence
cost
data sensitivity
confidence
deadline
required human context
```

A useful policy:

```text
low risk + reversible + high confidence
→ execute

low risk + reversible + uncertain
→ test / experiment

high risk + high confidence
→ prepare + require approval

high risk + uncertain
→ stop and escalate
```

Pair/Delegate/Watch is an output of this router, not merely a UI toggle.

---

# 10. Attention Manager

The system should optimize **human interruptions**, not merely task completion.

Create an explicit attention queue.

Each escalation should include:

- why the user is needed
- what will be unblocked
- urgency
- consequence of waiting
- estimated decision effort
- recommended review window
- whether a safe default allows work to continue

The system should prefer batching.

Example:

```text
NEXT REVIEW

2 approvals
1 architecture decision
1 external communication decision

Estimated attention: 9 minutes

Highest leverage:
Resolve KYC fallback semantics.
Unblocks 4 downstream work items.
```

Use user-defined review windows/checkpoints.

Prayer times may optionally serve as natural **boundaries around review periods**, but the product must not force religious practice into a productivity system. Salah is salah. Review checkpoints are optional and configurable.

---

# 11. Delegated Work System

Delegate mode must use durable workflows, not a single long model call.

A delegated work item should contain:

```text
intent
definition of done
relevant context
constraints
permissions
risk level
budget
deadline
verification plan
artifacts expected
```

Workflow:

```text
intent
  ↓
planner
  ↓
context package
  ↓
one or more workers
  ↓
automated checks
  ↓
independent verifier
  ↓
adversarial review when appropriate
  ↓
policy gate
  ↓
artifact / action / escalation
```

The system must be resumable after worker/model/process failure.

---

## 11.5 Harness Architecture

Jehad OS should distinguish the **control plane** from the agent/runtime harnesses used to perform work.

A harness is a replaceable execution or interaction environment.

Examples may include:

- Hermes
- OpenClaw
- Claude Code
- Codex
- browser/computer-use runtimes
- local model runners
- future employer-internal agent systems

None of these should become the authoritative Jehad OS database, global policy engine, or irreplaceable orchestration layer.

### HarnessAdapter

Define a capability-oriented adapter similar to:

```ts
interface HarnessAdapter {
  id: string;

  capabilities(): Promise<CapabilityDescriptor[]>;

  start(task: AgentTask): Promise<RunHandle>;

  resume(
    runId: string,
    input: ResumeInput
  ): Promise<RunHandle>;

  status(runId: string): Promise<RunStatus>;

  cancel(runId: string): Promise<void>;

  artifacts(runId: string): Promise<Artifact[]>;

  logs(runId: string): AsyncIterable<RunEvent>;
}
```

Jehad OS routes work by capability, policy, risk, cost, data locality, and available context rather than hard-coding business logic around one harness.

Examples:

```text
coding implementation → Claude Code / Codex
personal cognitive interaction → Hermes
local device/browser/channel action → OpenClaw
research → best available research-capable harness
future employer work → employer-approved internal harness
```

### Reference harness topology

The current likely topology is:

```text
                         INTERACTION
                      ┌─────────────┐
                      │   Hermes    │
                      │ cognitive   │
                      │   shell     │
                      └──────┬──────┘
                             │
                         Jehad OS API
                             │
┌──────────────────────────────────────────────────────┐
│                    JEHAD OS                          │
│                                                      │
│ World Model      Policy       Attention              │
│ Decisions        Audit        Evidence               │
│ Permissions      Evals        Domain Boundaries      │
└──────────────────────┬───────────────────────────────┘
                       │
                durable workflow layer
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
    Claude Code       Codex        Hermes workers
        │
        └──────────────┬──────────────┘
                       │
                 bounded actions
                       │
                 ┌─────▼─────┐
                 │ OpenClaw  │
                 │ edge / IO │
                 └─────┬─────┘
                       │
             channels / browser /
             local nodes / devices
```

This is a **reference architecture, not a dependency mandate**.

If a better harness replaces Hermes, OpenClaw, Claude Code, Codex, or the durable workflow system, Jehad OS should require only a new adapter.

## 11.6 Hermes Responsibility Boundary

Hermes is a strong candidate for the **personal cognitive shell**.

Good responsibilities:

- Pair-mode interaction
- small always-hot context
- working memory
- procedural skills/playbooks
- session/history retrieval
- user working-style adaptation
- intent clarification
- context curation
- delegation initiation

Hermes may maintain convenience files such as user/context/memory/skill documents.

Hermes must **not** be authoritative for:

- financial balances
- transactions
- commitments
- decision records
- evidence provenance
- project dependency state
- policy
- permissions
- audit history

Where useful, implement a **Jehad OS memory provider / context provider** for Hermes.

Conceptually:

```ts
interface CognitiveContextProvider {
  prefetch(query: ContextQuery): Promise<ContextPacket>;
  proposeMemory(candidate: MemoryCandidate): Promise<MemoryProposalResult>;
  searchEpisodes(query: string): Promise<Episode[]>;
  getRelevantSkills(context: ContextQuery): Promise<SkillRef[]>;
}
```

Hermes should retrieve durable truth from Jehad OS and propose durable learning back to it.

It should not maintain a second conflicting world model.

Optional soft-user-model systems may be used for probabilistic preference/personality inference, but those inferences must remain clearly distinct from canonical facts.

## 11.7 OpenClaw Responsibility Boundary

OpenClaw is a strong candidate for **integration, channels, local nodes, browser/device actions, and edge execution**.

Good responsibilities:

- messaging/channel ingress and egress
- device nodes
- local-machine actions
- home/network integrations
- browser/tool execution where appropriate
- local/edge schedules that are truly local
- bounded external actions through Jehad OS-issued capability grants

OpenClaw must **not** become authoritative for:

- global workflow lifecycle
- canonical memory
- financial truth
- cross-domain policy
- global scheduling
- approval state
- audit truth

Any OpenClaw action that originates from untrusted input must pass through Jehad OS policy and capability checks before a privileged action occurs.

## 11.8 IntegrationAdapter

Use an abstraction for external systems/actions:

```ts
interface IntegrationAdapter {
  id: string;

  capabilities(): Promise<ExternalCapability[]>;

  read(request: ReadRequest): Promise<ReadResult>;

  watch?(subscription: WatchRequest): Promise<WatchHandle>;

  prepare?(
    action: ActionIntent
  ): Promise<PreparedAction>;

  execute(
    action: PreparedAction,
    grant: CapabilityGrant
  ): Promise<ActionResult>;
}
```

OpenClaw can implement or back some IntegrationAdapters, while other systems may use direct provider integrations.

Examples:

```text
OpenClawIntegrationAdapter
GoogleWorkspaceAdapter
GitHubAdapter
FinancialDataAdapter
EmployerInternalAdapter
HomeAdapter
```

## 11.9 Durable Workflow Ownership

Neither the cognitive harness nor the integration harness should own long-running global workflows.

Jehad OS requires a **durable workflow runtime** capable of:

- checkpointing
- retries
- idempotency
- long sleeps without holding a process
- waiting for external events
- waiting for human approval
- cancellation
- resumability
- scheduled execution
- child workflows
- event-driven triggers
- observability

Current strong candidates include event-driven TypeScript workflow systems such as **Inngest** or **Trigger.dev**.

Given Jehad OS's architecture:

```text
event
→ update world state
→ evaluate policy/watchers
→ dispatch work
→ wait
→ verify
→ potentially wait for Jehad
→ resume
```

an event-oriented durable workflow system is likely the best conceptual fit.

Treat the selected workflow product as replaceable infrastructure behind a `WorkflowRuntime` interface.

Example:

```ts
interface WorkflowRuntime {
  start<T>(workflow: WorkflowDefinition<T>, input: T): Promise<WorkflowHandle>;
  signal(handle: WorkflowHandle, event: WorkflowSignal): Promise<void>;
  cancel(handle: WorkflowHandle): Promise<void>;
  status(handle: WorkflowHandle): Promise<WorkflowStatus>;
}
```

Do not scatter provider-specific workflow primitives throughout domain code.

## 11.10 Responsibility Matrix

Use this ownership model unless Phase 0 discovers a compelling reason to change it:

| Concern | Canonical owner |
|---|---|
| Structured truth / semantic memory | Jehad OS + PostgreSQL |
| Episodic history | Jehad OS event/artifact stores |
| Working context | active cognitive harness |
| Procedural skills | skill/playbook layer; Hermes is a candidate |
| Durable global workflows | Jehad OS workflow runtime |
| Policy / approval | Jehad OS |
| Audit | Jehad OS |
| Evidence / provenance | Jehad OS |
| Personal cognitive shell | Hermes candidate |
| Messaging / device / edge gateway | OpenClaw candidate |
| Coding workers | Claude Code / Codex / replaceable harness |
| High-risk authorization | Jehad OS |
| Local edge schedules | OpenClaw where appropriate |
| Business/domain schedules | durable workflow runtime |

Avoid duplicated ownership.

If two systems can both perform a capability, decide which one is authoritative and which one is merely an adapter.


# 12. Builder / Verifier Separation

Hard rule:

> The worker that creates an important artifact must not be the only worker that verifies it.

Support distinct roles:

- Builder
- Verifier
- Adversary
- Integrator

Examples:

Builder:
> Implement retry semantics.

Verifier:
> Prove ledger invariants remain true.

Adversary:
> Find event sequences that break it.

Integrator:
> Check architecture drift and migration compatibility.

This applies beyond code:

- generated design → visual verifier
- research memo → evidence verifier
- budget classification → reconciliation verifier
- contract extraction → second-pass verifier

---

# 13. Work / Engineering Domain Adapter

Build this as a module, not as the entire product.

Current startup environments may allow deep integration. Future employers may not.

Conceptual capabilities:

```text
search_code()
read_file()
read_architecture()
read_ticket()
read_pr()
create_branch()
run_tests()
spawn_worker()
open_pr()
run_synthetic_customer()
read_ci()
```

The adapter implementation can vary by environment.

## 13.1 Context packaging

Do not dump entire repositories into workers.

For each work item construct a context package containing:

```text
task
relevant architecture
affected invariants
linked decisions
recent related changes
known incidents
relevant files
tests
known traps
definition of done
permissions
```

## 13.2 Architecture invariants

Allow durable invariants such as:

```text
canonical balance source is X
all money movement must be idempotent
client must not calculate authoritative balance
provider webhook ordering is nondeterministic
```

Watch PRs and code changes for likely violations.

## 13.3 Architecture drift report

Periodically compare declared architecture to actual repository behavior.

Surface only meaningful deviations.

## 13.4 Documentation as a projection of reality

Automate:

```text
architecture discussion → decision
decision → ADR
PR → system change
system change → doc patch
incident → institutional memory
synthetic failure → regression test
```

Documentation should be updated by normal engineering activity rather than requiring separate cleanup projects.

---

# 14. Synthetic Customer System

Treat synthetic users as persistent personas, not disposable test cases.

A persona can include:

```text
language
dialect
device
OS version
network quality
technical literacy
account history
financial behavior
accessibility needs
risk/fraud characteristics
```

Persist longitudinal state.

Example:

```text
Persona 018

Jan 04: created account
Jan 04: passed KYC
Jan 11: received transfer
Feb 02: changed phone
Feb 17: card declined
Mar 08: reverified identity
```

Use synthetic customers for:

- functional correctness
- state evolution
- usability
- comprehension
- internationalization
- accessibility
- poor-network behavior
- low-end devices
- fraud/abuse
- support-ticket forecasting
- regression testing

After meaningful changes, determine which personas are likely affected and rerun those journeys.

Do not make synthetic customer execution dependent on a specific device-farm vendor.

---

# 15. Incident / Organizational Memory

Every significant failure should produce structured memory:

```text
incident
impact
root cause
missed assumption
why tests failed
affected invariant
fix
regression test
architecture implication
follow-up
```

Future delegated work should automatically retrieve relevant incidents.

The goal is for the system to retain lessons that a human team would otherwise forget.

---

# 16. Research Engine

Do not build "search and summarize."

Build **incremental research state**.

Each tracked subject should contain claims, evidence, dates, and confidence.

Example:

```text
Claim
Evidence
Source
Observed date
Confidence
Contradicting evidence
Last verified
```

Support:

- one-off investigations
- persistent research threads
- delta detection
- standing investigations
- competitor intelligence
- technology monitoring
- opportunity research

A new run should ask:

> What changed since the last known state?

not:

> Explain this subject from scratch.

## Evidence ledger

Every important synthesized belief should be traceable to sources.

The system must be able to answer:

> Why do we believe this?

and distinguish:

- primary source
- secondary source
- estimate
- opinion
- model inference
- stale evidence

---

# 17. Opportunity / Experiment Engine

Support business and product ideas as hypotheses, not scores.

Track:

```text
problem
target user
existing spend
distribution
competition
regulatory burden
build cost
time to revenue
AI leverage
core uncertainty
evidence for
evidence against
```

Do not reduce opportunities to fake precision like "83/100."

Instead surface:

- what evidence strengthened the opportunity
- what weakened it
- what uncertainty dominates
- what cheapest experiment can resolve that uncertainty

Prefer experiment design over software building.

Examples:

- landing page
- manual concierge workflow
- paid ads
- interviews
- fake-door feature
- preorders
- outbound campaign

---

# 18. Finance Arm — Personal CFO

Finance is a core domain, not a later cosmetic dashboard.

The financial arm should be **read-heavy, analysis-heavy, and execution-conservative**.

## 18.1 Canonical financial ledger

Model:

```text
Account
Transaction
Transfer
Income
Expense
RecurringExpense
Holding
TaxLot
Liability
Asset
CashFlow
FinancialGoal
FinancialPolicy
FinancialDecision
```

Sources may eventually include:

- bank accounts
- credit cards
- brokerages
- retirement accounts
- crypto exchanges/wallets
- payroll
- business accounts

Use authoritative structured data.

Never infer balances from chat history.

## 18.2 Budgeting as baseline + anomalies

Prioritize:

- baseline monthly burn
- discretionary trend
- irregular annualized expenses
- recurring expense changes
- duplicate subscriptions
- one-time vs structural spending
- lifestyle inflation

Avoid over-indexing on arbitrary envelope budgets unless the user configures them.

## 18.3 Cash-flow forecasting

Support:

```text
today's liquidity
expected income
known bills
planned purchases
tax obligations
annual renewals
expected investment contributions
30/60/90 day projected cash
```

## 18.4 Liquidity model

Classify assets by real accessibility.

Example:

```text
T0 immediate cash
T1 highly liquid public assets
T2 liquid with friction/restrictions
T3 illiquid/private/real estate
```

Support:

> If income stopped tomorrow, what is my actual runway?

## 18.5 Exposure / concentration

Analyze economic exposure across accounts, not just nominal categories.

Monitor user-defined policies such as:

- maximum single-stock concentration
- maximum employer-linked exposure
- crypto range
- minimum liquidity
- speculative allocation limit

Watch mode should notify only when policy thresholds materially change.

## 18.6 Taxes

Support continuous tax organization:

- realized gains/losses
- tax lots
- withholding
- equity compensation
- crypto activity
- potentially deductible expenses
- business expenses
- estimated obligations

The system may prepare analysis and CPA packets.

Do not present itself as a substitute for a qualified tax professional.

## 18.7 Major financial decisions

Use the Decision Engine for:

- home purchases
- career changes
- private investments
- large capital commitments
- portfolio reallocations
- startup equity
- business reinvestment

Include pre-mortem and scenario analysis.

## 18.8 Personal financial policy / investment constitution

Support user-authored rules such as:

```text
minimum runway
target allocation ranges
maximum concentration
cooldown period for large discretionary moves
speculative capital limits
conditions for private investments
```

The AI should expose policy violations, not make emotional trading calls.

## 18.9 Zakat

Eventually support an explicit, configurable rules engine based on the user's chosen scholarly methodology.

Do not have an LLM invent fiqh rules.

Store:

- selected methodology
- source references
- nisab rule
- relevant dates
- asset classifications
- liability treatment
- reproducible calculation

## 18.10 Finance permission boundary

Default permissions:

```text
READ: broad
ANALYZE: broad
PREPARE: bounded
EXECUTE: highly restricted
```

Never give a general-purpose agent unrestricted authority to:

- move money
- trade
- withdraw crypto
- change bank details
- borrow
- open financial accounts

High-risk financial actions require explicit human approval and ideally a separate hardened execution path.

---

# 19. Personal Operations Domain

Eventually support:

- household maintenance
- warranties
- returns
- subscriptions
- bills
- appointments
- registrations
- insurance administration
- travel documents
- renewals
- receipts
- reimbursements
- bureaucracy/forms

The pattern is:

```text
detect need
→ gather requirements
→ gather documents
→ prepare action
→ request approval if consequential
→ execute
→ track response
→ follow up
```

The user should not spend time locating documents the system already has access to.

---

# 20. Purchasing / Buyer Agent

Build a personal buyer as structured preference + inventory + research, not generic recommendation.

For each product category support:

```text
preferences
brands
dimensions
budget
deal-breakers
existing inventory
past purchases
satisfaction
```

Possible future sources:

- retailers
- marketplaces
- resale
- reviews
- historical pricing

Surface exceptions such as:

- unusually good listing
- duplicate of something already owned
- fake sale
- higher-value used premium option
- product incompatible with known dimensions

Require approval before purchases.

---

# 21. Wardrobe / Home Digital Twins

These are later verticals on top of the same kernel.

## Wardrobe

Store:

```text
item
brand
silhouette
material
color
fit
temperature range
formality
wear history
compatibility
```

Use weather/activity/laundry state for outfit selection.

Use inventory-aware reasoning before purchases.

## Home

Store:

```text
room dimensions
windows
doors
outlets
furniture geometry
materials
colors
photos
```

Use for:

- fit checks
- layout simulation
- purchase compatibility
- clearances
- moving
- inventory

Principle:

> Never solve the same context problem twice.

---

# 22. Creative Production Pipelines

Creative constraints should live in structured schemas, not only prompts.

Example brand/project schema:

```yaml
brand: Example
label:
  background: cream
  structure: fixed
  prohibited_copy:
    - dosage
render:
  geometry: vial-v3
  lighting: studio-v2
  background: transparent
product_types:
  spray:
    container: nasal-bottle-v1
```

Pipeline:

```text
product definition
→ generation
→ OCR/text verification
→ visual constraint verification
→ filename/export validation
→ reject/regenerate if needed
→ approved artifact
```

Humans should not be catching deterministic mistakes that a verifier can detect.

---

# 23. Learning / Knowledge Domain

Build a tutor that models the user's **error distribution**, not just curriculum.

Track:

```text
concept
confidence
mistakes
mistake frequency
last tested
related concepts
source material
```

The system should identify recurring misconceptions.

Learning should connect to real projects where possible.

Example:

```text
idempotency → payment retries
row locking → real database code
queues → webhook processing
```

The goal is career-long capability compounding without retaining proprietary employer data.

## Professional capability graph

Track abstract skills and concepts:

```text
distributed systems
transactions
locking
queues
consensus
agent orchestration
evals
tool security
```

This graph survives employer changes.

---

# 24. Voice / Capture Layer

Support low-friction capture from phone/voice later.

Raw thoughts should flow through:

```text
capture
→ classify
→ link to project/person/domain
→ extract task/question/decision
→ optionally research
→ resurface only when useful
```

Do not turn every captured thought into a to-do.

---

# 25. Communications Layer

The system should understand relationship and project context sufficiently to prepare communication.

Before important conversations, produce compact context:

```text
last interaction
they owe you
you owe them
open disagreement
relevant decisions
decisions needed today
```

After conversations:

- extract commitments
- decisions
- open questions
- follow-ups

Avoid creepy "personal CRM engagement" mechanics.

Help the user remember meaningful context, not optimize humans as leads.

---

# 26. Security Architecture

This is non-negotiable.

## 26.1 Trust zones

Agents that read untrusted content must not automatically inherit dangerous permissions.

At minimum separate:

```text
UNTRUSTED INPUT
web
email
Slack/chat
external documents
user-provided arbitrary files

        ↓ extraction / sanitization

TRUSTED REASONING

        ↓ proposal

ACTION LAYER

        ↓ policy / approval

HIGH-RISK ACTIONS
production
money
contracts
credentials
irreversible communications
```

Prompt injection from email or web content must not be able to trigger privileged actions.

## 26.2 Capability-based permissions

Do not attach broad permanent authority to agent identities.

Grant capabilities per task.

Example:

```yaml
read_repo: true
create_branch: true
push_branch: true
merge_main: false
deploy_prod: false
read_finances: false
move_money: false
send_external_email: false
```

Agents are disposable.

Capabilities are controlled.

Use least privilege.

## 26.3 Human approval gates

Require explicit approval for categories including:

- money movement
- trading
- production deployment where material
- destructive database operations
- contracts/legal commitments
- credential changes
- irreversible external communications
- high-impact architectural migrations

The policy system should make this configurable.

## 26.4 Audit trail

For every meaningful agent action retain:

```text
what happened
why
which model/provider
which workflow
inputs / source references
tools used
permissions granted
outputs
state changed
verification result
whether reversible
human approval if any
```

The user must be able to ask:

> Why did the system do this?

and reconstruct the causal chain.

## 26.5 Secrets

Use a real secrets manager.

Never place secrets in model prompts, event logs, telemetry, or long-term memory unless strictly necessary and specifically protected.

---

# 27. Verification and Evals

Do not ship "agent demos."

Build measurable workflows.

Metrics should include:

```text
human_blocked_minutes
autonomous_completion_rate
clarification_rate
approval_rate
correction_rate
false_escalation_rate
undetected_error_rate
time_intent_to_verified_result
cost_per_completed_outcome
downstream_rework
interruptions_per_day
```

For each major workflow, maintain an eval set.

Examples:

- commitment extraction precision/recall
- decision retrieval correctness
- architecture-invariant detection
- research citation support
- finance categorization accuracy
- prompt-injection resistance
- escalation-policy correctness
- synthetic journey reproducibility

Do not increase autonomy without evidence that the workflow is reliable.

---

# 28. Human-Blocked Time as a North-Star Metric

A key system-level metric is:

> **How long was useful work waiting because Jehad was required?**

Track causes:

```text
ambiguous requirements
approval required
missing credentials
architecture decision
missing external information
system failure
```

The goal is not zero human involvement.

The goal is to reduce unnecessary dependency while preserving judgment where it matters.

---

# 29. Learning From Corrections

A correction should not merely fix one answer.

Classify the correction as:

```text
local correction
workflow rule
project preference
architectural invariant
domain policy
global preference
```

Persist it at the appropriate scope.

Example:

> "Never structure migrations this way."

The system should determine whether this is:

- specific to one task
- specific to one repo
- a general engineering preference

Do not blindly globalize feedback.

---

# 30. User Interface Philosophy

The UI should be quiet.

Do not make the user browse through dozens of agent cards.

Primary surfaces should be:

## A. Ask / Pair

A high-bandwidth interaction surface.

## B. Delegate

Create and inspect asynchronous work.

## C. Review Queue

Only things requiring judgment/approval.

## D. State / Search

Query the world model:

- What am I waiting for?
- What changed?
- What am I forgetting?
- What decisions are questionable now?
- What is blocked?
- What is consuming my attention?
- What silently stalled?
- Where am I the bottleneck?

## E. Activity / Audit

Explain what agents did and why.

Dashboards are secondary.

---

# 31. Daily Operating Experience

A useful morning result might be:

```text
WHILE YOU WERE AWAY

Completed
- 4 engineering work items
- 1 research investigation
- 2 administrative follow-ups

Verified
- 5

Rejected by internal review
- 1

Waiting externally
- 3

Needs you
- 2

Highest leverage decision
- Define X semantics
- Unblocks 4 downstream work items
```

A useful review queue item:

```text
DECISION REQUIRED

Question:
What should happen when KYC is revoked during an in-flight transfer?

Why now:
Blocks 3 work items and 1 synthetic journey.

Options:
A ...
B ...

Relevant prior decision:
...

Risk:
Medium

Estimated attention:
4 minutes
```

A useful evening summary:

```text
TODAY

Decisions made: 4
New commitments: 3
Completed: 11
Waiting: 5
New risks: 1

Tomorrow's highest leverage unlock:
X
```

Do not produce a summary if nothing meaningful changed.

---

# 32. Build Strategy

Do **not** attempt to implement the whole vision at once.

The first objective is to build a durable kernel and prove a narrow vertical slice.

## Phase 0 — Discovery and Architecture

Before writing significant implementation code:

1. Inspect the current repository and environment.
2. Identify existing auth, DB, queues, observability, deployment, secrets, and integrations.
3. Produce a concise architecture proposal.
4. Produce the initial data model.
5. Produce a threat model.
6. Define domain/data boundaries.
7. Define event schema.
8. Define capability/permission model.
9. Define the first vertical slice.
10. Define evals and success metrics.
11. Define the harness topology and ownership boundaries.
12. Define the four-class memory architecture and memory-promotion rules.
13. Select or abstract the durable workflow runtime.
14. Record meaningful choices as ADRs.
15. Identify assumptions and unknowns.

Do not ask the user questions for reversible implementation details.

Choose sensible defaults, document them, and continue.

Ask only when a choice is:

- difficult to reverse
- security-sensitive
- costly
- externally consequential
- fundamentally ambiguous

## Phase 1 — Kernel

Build:

- authentication
- domain model
- PostgreSQL schema
- event log
- job/workflow system
- source adapter interface
- action/integration adapter interface
- agent/model provider interface
- harness adapter interface
- workflow-runtime interface
- memory classification/promotion primitives
- capability-based policy system
- audit trail
- review/escalation queue
- basic Pair / Delegate / Watch routing primitives
- observability

No high-risk autonomous actions yet.

## Phase 2 — First Vertical Slice

Implement the most useful low-risk slice:

### Personal Operations / Chief of Staff

Start with user-authorized sources such as calendar/email/task/doc integrations where available.

Deliver:

- event ingestion
- commitment extraction
- commitment graph
- waiting-on detection
- decision ledger
- morning delta
- review queue
- end-of-day state update
- conversational queries over structured state

Important:

The brief must be **delta-oriented**, not "summarize my inbox."

It should prioritize:

- changes
- overdue commitments
- blocked work
- decisions needed
- high-leverage unlocks
- things silently stalling

## Phase 3 — Durable Delegation

Add:

- background tasks
- planner
- context packaging
- worker execution
- retries
- artifact storage
- verifier
- adversarial reviewer
- escalation
- task budgets
- model/provider selection
- human-blocked-time tracking

Prove that work can continue while the user is absent.

## Phase 4 — Work / Engineering Adapter

When authorized in the current environment:

- code/repo integration
- tickets
- PRs
- CI
- architecture decisions
- invariants
- context packaging
- builder/verifier split
- synthetic customers
- drift detection
- incident memory
- documentation updates

Keep all work-domain data isolated and revocable.

## Phase 5 — Research / Opportunity

Add:

- persistent subjects
- evidence ledger
- delta research
- standing investigations
- opportunity hypotheses
- experiment planning

## Phase 6 — Finance

Start read-only.

Add:

- account/transaction ingestion
- reconciliation
- categorization
- recurring expense detection
- baseline spending
- cash-flow forecasting
- liquidity model
- portfolio exposure
- policy thresholds
- anomaly detection
- tax organization
- financial decision integration

No autonomous money movement.

## Phase 7 — Additional Personal Verticals

Only after the kernel is stable:

- purchasing
- household/bureaucracy
- travel
- wardrobe
- home digital twin
- learning
- creative production
- voice capture

Each vertical should reuse the same world model, routing, policy, audit, and verification infrastructure.

---

# 33. Recommended Technical Defaults

These are defaults, not requirements. Respect an existing codebase if one exists.

## Current Reference Components

As of the initial design, the strongest-fit reference topology is:

```text
Hermes      → personal cognitive shell / Pair mode / procedural skills
OpenClaw    → integration, messaging, browser/device/local-edge fabric
Inngest     → likely durable event/workflow runtime
PostgreSQL  → canonical structured world model
Claude Code / Codex → replaceable specialized coding/review workers
```

These are **replaceable components**, not product identity.

Do not let implementation convenience collapse the architectural boundaries described above.

If greenfield:

## Application

- TypeScript
- Next.js for web/control UI
- Node.js backend/runtime where appropriate
- strongly typed APIs

## Data

- PostgreSQL
- migrations under source control
- vector search via pgvector or replaceable semantic index
- object storage for artifacts

## Workflows

Use a durable workflow/job mechanism.

Requirements:

- retries
- idempotency
- timeout
- cancellation
- resumability
- scheduled jobs
- long-running workflows
- human approval waits
- external-event waits
- child workflows
- checkpointing
- strong observability

**Current reference candidates:** Inngest or Trigger.dev.

The likely default for a greenfield TypeScript implementation is **Inngest** because Jehad OS is fundamentally event-driven, but this is not a hard dependency. Validate this choice during Phase 0 against self-hosting, durability, security, operational complexity, pricing, and deployment requirements.

Hide provider-specific workflow primitives behind a `WorkflowRuntime` abstraction.

## Models

Create provider abstraction.

Store:

- provider
- model
- prompt/template version
- cost
- latency
- tool calls
- result
- verification outcome

Avoid model-specific logic in domain code.

## Observability

Support:

- structured logs
- traces for workflows
- cost tracking
- failure reasons
- evaluation results
- audit events

---

# 34. API / Internal Abstraction Sketch

Prefer capability-oriented interfaces.

Examples:

```ts
interface SourceAdapter {
  sync(cursor?: string): Promise<NormalizedEvent[]>;
}

interface ActionAdapter<TInput, TResult> {
  describeRisk(input: TInput): Promise<ActionRisk>;
  execute(input: TInput, grant: CapabilityGrant): Promise<TResult>;
}

interface AgentTask {
  intent: string;
  domainId: string;
  contextRefs: string[];
  constraints: string[];
  definitionOfDone: string[];
  risk: RiskLevel;
  allowedCapabilities: Capability[];
  verificationPlan: VerificationPlan;
}

interface HarnessAdapter {
  capabilities(): Promise<CapabilityDescriptor[]>;
  start(task: AgentTask): Promise<RunHandle>;
  resume(runId: string, input: ResumeInput): Promise<RunHandle>;
  status(runId: string): Promise<RunStatus>;
  cancel(runId: string): Promise<void>;
  artifacts(runId: string): Promise<Artifact[]>;
}

interface WorkflowRuntime {
  start<T>(
    workflow: WorkflowDefinition<T>,
    input: T
  ): Promise<WorkflowHandle>;

  signal(
    handle: WorkflowHandle,
    signal: WorkflowSignal
  ): Promise<void>;

  cancel(handle: WorkflowHandle): Promise<void>;
  status(handle: WorkflowHandle): Promise<WorkflowStatus>;
}

interface Decision {
  id: string;
  context: string;
  alternatives: Alternative[];
  selectedOption: string;
  reasons: string[];
  assumptions: Assumption[];
  revisitConditions: RevisitCondition[];
}

interface Escalation {
  reason: string;
  urgency: number;
  consequenceOfWaiting: string;
  blockedWorkIds: string[];
  estimatedHumanMinutes: number;
  requestedJudgment: string;
}
```

Do not copy these blindly if better abstractions emerge.

---

# 35. Policy Examples

Example configurable policy:

```yaml
actions:
  create_git_branch:
    max_autonomy: autonomous

  open_pull_request:
    max_autonomy: autonomous

  merge_pull_request:
    max_autonomy: approval_required

  send_external_email:
    max_autonomy: approval_required

  modify_calendar:
    max_autonomy: bounded_autonomy

  deploy_production:
    max_autonomy: approval_required

  move_money:
    max_autonomy: prohibited_for_general_agents

  execute_trade:
    max_autonomy: prohibited_for_general_agents
```

Policy should consider not just action type but:

- domain
- amount / impact
- reversibility
- confidence
- data sensitivity
- user-defined rules

---

# 36. Threat Model Requirements

Before enabling tool use, explicitly model:

- prompt injection
- malicious email/web content
- poisoned documents
- compromised external integrations
- secret leakage
- cross-domain data leakage
- privilege escalation
- unsafe tool chaining
- mistaken identity/entity resolution
- hallucinated actions
- stale financial data
- duplicate events
- replay attacks
- unintended irreversible communication
- excessive model permissions
- malicious synthetic test behavior reaching production
- compromised local edge node
- conflicting state between multiple harness memories
- duplicate execution caused by multiple schedulers
- harness compromise
- workflow-runtime compromise
- capability leakage across harness adapters
- stale context packages
- accidental persistence of employer data into personal cognitive memory

Design mitigations before granting autonomy.

---

# 37. Graceful Degradation

Jehad OS must remain useful if:

- Gmail is disconnected
- calendar is disconnected
- GitHub is unavailable
- work repo access disappears
- the user changes employers
- one model provider fails
- the local Mac is offline
- finance integration is disconnected
- Hermes is unavailable or replaced
- OpenClaw is unavailable or replaced
- the selected workflow provider is unavailable or migrated
- Claude Code / Codex is unavailable

No single connector should be foundational to the entire product.

Show incomplete-state confidence rather than pretending the world model is complete.

---

# 38. Data Quality

Every derived fact should distinguish:

```text
observed fact
user-entered fact
external claim
model inference
prediction
```

The system must never silently convert an inference into a fact.

For material state, retain evidence/provenance.

Support conflict resolution when two sources disagree.

---

# 39. Autonomy Maturity Model

Do not jump from assistant to autonomous operator.

For each workflow progress through:

```text
Level 0: observe only
Level 1: recommend
Level 2: prepare action
Level 3: execute reversible/low-risk actions
Level 4: bounded autonomy with policy
Level 5: continuous autonomous operation with exception handling
```

Promote a workflow only when evals justify it.

---

# 40. Definition of Success for v1

v1 is successful if the system can reliably do the following:

1. Ingest authorized events from at least one meaningful personal source.
2. Normalize them into durable structured state.
3. Extract commitments with usable accuracy.
4. Maintain a decision ledger.
5. Answer:
   - What am I waiting for?
   - What is waiting on me?
   - What changed?
   - What is blocked?
6. Produce a delta-oriented brief.
7. Create a review queue ordered by leverage/urgency.
8. Run at least one delegated asynchronous task to completion.
9. Independently verify that delegated task.
10. Persist a full audit trail.
11. Enforce at least one capability restriction.
12. Track human-blocked time.
13. Continue operating if a worker/model process crashes.
14. Keep personal and work-domain data logically isolated.
15. Demonstrate one injection-resistance test where untrusted content cannot trigger a privileged action.
16. Execute one delegated task through a `HarnessAdapter` rather than direct provider coupling.
17. Demonstrate that canonical state survives replacement/restart of the active cognitive harness.
18. Demonstrate that a long-running workflow can pause for human input and resume without an agent process remaining alive.
19. Demonstrate that an edge/integration harness cannot bypass Jehad OS policy for a privileged action.
20. Classify at least one learned item through the memory-promotion pipeline instead of blindly storing conversation history as canonical memory.

Do not call v1 complete because the UI looks polished.

---

# 41. First Deliverables From the Dev Agent

Before broad implementation, produce these artifacts in the repository:

```text
/docs/vision.md
/docs/architecture.md
/docs/domain-boundaries.md
/docs/threat-model.md
/docs/data-model.md
/docs/event-model.md
/docs/policy-model.md
/docs/memory-architecture.md
/docs/harness-architecture.md
/docs/workflow-runtime.md
/docs/evals.md
/docs/roadmap.md
/docs/adr/
```

Also provide:

1. Repository assessment.
2. Proposed system architecture.
3. Concrete Phase 1 implementation plan.
4. Database schema proposal.
5. Event schema.
6. First vertical-slice sequence diagram.
7. Permission/capability model.
8. Threat model.
9. Eval plan.
10. Harness responsibility matrix and adapter plan.
11. Memory taxonomy + promotion rules.
12. Durable workflow runtime recommendation with tradeoffs.
13. Milestones with acceptance criteria.
14. Explicit "not now" list to prevent scope creep.
15. A list of assumptions you chose rather than asking about.

Then begin Phase 1 unless a genuinely irreversible/security-critical decision blocks implementation.

---

# 42. Dev-Agent Working Rules

## Do

- inspect before rewriting
- build primitives that later verticals reuse
- prefer boring infrastructure
- make workflows idempotent
- make state explicit
- preserve provenance
- version prompts/policies
- separate planning, execution, and verification
- test failure/retry paths
- document material decisions
- add evals alongside agent workflows
- design for provider replacement
- design for connector loss
- keep autonomy bounded
- batch human escalations
- optimize for longitudinal usefulness

## Do not

- hide critical state inside prompts
- make the LLM the database
- make Hermes, OpenClaw, Claude Code, Codex, or any other harness the canonical control plane
- allow two schedulers/memory systems/policy engines to have ambiguous ownership of the same responsibility
- give untrusted readers privileged tools
- let builders self-certify high-risk work
- send unnecessary notifications
- create agent personalities for every feature
- overfit the system to the current startup
- assume permanent source-code access
- retain proprietary employer data in personal memory
- autonomously move money
- autonomously sign contracts
- create fake confidence scores without evidence
- build ten verticals before the kernel works
- optimize for demos instead of reliability

---

# 43. North-Star Queries

The architecture is working when the user can ask questions like:

> What am I forgetting?

> What changed while I was gone?

> What is blocked right now?

> What am I waiting on?

> What is waiting on me?

> What should I decide next to unlock the most downstream work?

> Which decisions are based on assumptions that no longer hold?

> Where am I repeatedly becoming the bottleneck?

> Which projects have stopped producing evidence of progress?

> What changed financially this month?

> What recurring costs increased?

> What is my true liquid runway?

> What risks am I unintentionally concentrated in?

> What did we learn from the last incident that applies here?

> Why does the system believe this claim?

> Why did this agent take this action?

> Which harness executed this, what capabilities did it receive, and what remained authoritative in Jehad OS?

> What can safely keep running without me tonight?

The system should answer from structured evidence, not vibes.

---

# 44. Final Product Philosophy

Jehad OS should not try to maximize "AI activity."

It should maximize **leverage with trust**.

The ideal experience is not:

> "Look how many agents are running."

It is:

> "Only two things need me."

The user remains responsible for judgment, relationships, values, consequential decisions, and creative direction.

The system increasingly absorbs:

- remembering
- routing
- monitoring
- checking
- retrieving
- organizing
- testing
- reconciling
- documenting
- following up
- coordinating
- executing reversible routine work

The target operating state is:

```text
Human:
architect
decision-maker
creator
negotiator
learner
relationship holder

System:
memory
router
researcher
coordinator
watcher
worker
verifier
historian
analyst
```

Build toward that state incrementally, with explicit security boundaries, measurable reliability, and the ability to operate across many years, employers, projects, devices, and model providers.

---

# 45. Immediate Instruction

Start now.

1. Inspect the repository and current environment.
2. Do not immediately implement the entire vision.
3. Write the Phase 0 artifacts, including memory and harness architecture.
4. Identify the smallest architecture that can grow into this system.
5. Explicitly decide ownership boundaries between Jehad OS, the cognitive harness, the integration/edge harness, coding workers, and the durable workflow runtime.
6. Select the first vertical slice according to the roadmap above.
7. Define acceptance tests and evals before adding autonomy.
8. Implement the kernel.
9. Keep a running decision log/ADR as you work.
10. Prefer reversible choices when uncertain.
11. Escalate only genuinely irreversible, security-sensitive, costly, or externally consequential choices.

At each milestone, report:

```text
What was built
What was verified
What failed or changed
What assumptions were made
What remains blocked
What decision, if any, needs Jehad
What is next
```

The goal is not to produce a prototype that looks intelligent.

The goal is to create a **durable personal AI operating system whose usefulness compounds over years**.
