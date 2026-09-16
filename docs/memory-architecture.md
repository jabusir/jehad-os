# Memory Architecture — Jehad OS Kernel

- **Status:** Phase 0 artifact, derived from the Phase 0 plan (final, revision 3)
- **Source of truth:** `docs/plans/phase0.md` §6 (four classes, promotion pipeline,
  truth semantics per review §8; domain-contribution rules per cleanup §3). This
  document derives; it does not design. Discrepancies are recorded in
  "Architectural concerns" below, never silently resolved here.
- **Citation convention** (same as the plan): bare `§N` = section N of the **directive**
  (`docs/directive/JEHAD_OS_BUILD_DIRECTIVE.md`); `plan §N` = the Phase 0 plan;
  `review §N` = the owner's external review (`docs/reviews/phase0-external-review.md`);
  `cleanup §N` = the owner's final-cleanup review
  (`docs/reviews/phase0-final-cleanup.md`).
- **Consumers:** M5 (memory-promotion pipeline with assertion-kind truth semantics +
  evidence links) is built from this document (plan §15 M5).

---

## 1. Four memory classes (§3.5; plan §6.1)

Memory is not one subsystem. Four classes, each with a distinct canonical owner
(plan §5):

| Class | Lives in | Lifetime | Examples |
| --- | --- | --- | --- |
| Working | harness session / workflow step state | task-scoped | current hypothesis, scratchpad |
| Episodic | `events` + `artifacts` (append-only, provenance) | years | conversations, runs, incidents |
| Semantic | world-model tables (commitments, decisions, people…) | until superseded | "Jehad owes X a migration plan by Fri" |
| Procedural | `procedures/` in git (markdown/YAML/JSON; loader in core) | versioned | "how we triage a failed workflow" |

Ownership rules that follow from the table (plan §5; §11.10):

- **Structured truth (semantic)** is owned by Jehad OS + PostgreSQL — never any
  harness or model.
- **Episodic history** is owned by the Jehad OS event log + artifact store — never
  harness chat logs. Harness memory (e.g. OpenClaw's) is cache-only; canonical
  queries go through the API (T6, plan §11).
- **Working memory** is owned by the active cognitive harness; Jehad OS does not
  persist sessions (plan §5).
- **Procedural memory** is owned by `procedures/` (versioned content in git; typed
  loader/schema in `packages/core`); harnesses may cache read-only copies (plan §5;
  see §6 below).
- LLM context and model memory are never the source of truth (§3.1).

## 2. Promotion pipeline (nothing auto-canonical; plan §6.2)

A harness/model **proposes**; it never silently promotes conversation into canonical
truth (§3.5). The pipeline:

```text
harness/model proposes MemoryCandidate (→ memory_candidates row)
  → classifier assigns: discard | working | episodic | semantic | preference
                         commitment | decision | assumption | procedural | policy
    + assertion_kind: observed | user_declared | externally_sourced |
                      model_inferred | computed
  → gate applies, in order (five gates — see §3):
      1. provenance attached
      2. domain check
      3. sensitivity/retention classification + model-egress check
      4. confidence + conflict check
      5. write to the matching store (truth semantics govern step 5)
```

The classifier's ten labels (above) are the classification vocabulary of plan §6.2.
The five gates apply **in the order listed** (plan §6.2).

## 3. The five gates, in order

### Gate 1 — Provenance attached

Source event/run, model, and prompt version are attached to the candidate
(`memory_candidates.provenance jsonb`). All writes carry provenance (plan §15 M5
acceptance; §5 provenance rule).

### Gate 2 — Domain check

Work-domain content is blocked from the personal semantic store. Abstract
method-level learning is allowed; employer specifics are not (§4.3: "user has
experience with webhook idempotency" — acceptable; "Employer X has vulnerability Y in
table Z" — not). This is the T3 mitigation (plan §11).

Contribution rules by domain `storage_mode` (cleanup §3; plan §10):

- **Federated domains contribute policy-sanitized metadata only — counts, never
  content**: "2 work decisions need review" may cross; the decision content may not.
  ("2 work decisions need review" is a **federated** example, not an opaque one —
  cleanup §3 moved it.)
- **Opaque domains contribute no semantic payload at all by default.** Personal
  Jehad OS may know only that the domain/capability exists, plus adapter
  availability/health and capability availability if policy permits — not counts,
  titles, summaries, deadlines, project names, or decision metadata. Nothing crosses
  unless the domain's policy is explicitly changed.

Both rules are proven in Phase 1 with fake DomainBackend adapters at M4: a fake
federated domain exports only its policy-defined sanitized metadata; a fake opaque
domain exports no semantic payload — personal Postgres receives nothing but
existence/health (plan §10; plan §15 M4; A16).

### Gate 3 — Sensitivity/retention classification + model-egress check

The data's domain/sensitivity must permit the provider being asked (plan §9;
ADR-0012): context building calls `ModelEgressPolicy` **before** provider dispatch;
denial raises and is audited before any model call (a `model_calls` row implies the
check passed). `secret` is never in model context. Never rely on prompts saying
"don't expose this."

### Gate 4 — Confidence + conflict check

An existing contradicting fact does not overwrite: **both are kept, the conflict is
recorded**, and the review queue receives it if material (plan §6.2; §38 conflict
resolution). The system must never silently convert an inference into a fact (§38).

### Gate 5 — Write to the matching store, under truth semantics

**Semantic writes are proposals that land in the review queue unless:**

- **(a)** `assertion_kind = user_declared` **AND** the class is something a person can
  canonically establish by stating it — preference, intent, commitment, personal
  decision, or self-declared plan; **or**
- **(b)** the class is episodic.

**A user-declared claim about the external world ("Company X has 3M customers") is
stored as a user-supplied claim (evidence-linkable), NEVER auto-promoted to verified
semantic fact** — "Jehad said X" is not "X is true" until independently supported by
the evidence primitive (plan §7 `evidence`; review §8; review §20). This is the T14
mitigation (plan §11) and an M5 acceptance test: the claim persists as
claim/episode, never silently promoted to verified fact (plan §13; review §25).

Concretely (review §8):

```text
user_declared + preference            → canonical preference
user_declared + personal commitment   → canonical commitment
user_declared + external-world claim  → claim requiring evidence, not canonical fact
```

## 4. assertion_kind — truth semantics

Every candidate carries one of (plan §6.2; review §8):

```text
observed | user_declared | externally_sourced | model_inferred | computed
```

The kind travels with the promoted record's provenance so any later reader can
distinguish what was observed, what a person asserted, what an external source
claimed, what a model inferred, and what was computed. The system distinguishes
"Jehad said X" from "X is true" (review §8) — this matters enormously once the
research and finance domains exist, and it mirrors §38's requirement to distinguish
observed facts, user-entered facts, external claims, model inferences, and
predictions.

## 5. Promotion rules are configuration, not model judgment (ADR-0004, extended)

Promotion rules are **data (config)**, not model judgment (plan §6.2). A model
classifies and proposes; deterministic, versioned rules decide. This covers the
gates, the truth-semantics exceptions in gate 5, and the review-queue routing.

The first **correction-scope taxonomy** (§29) ships as an enum on the candidate
(plan §6.2), so a correction is classified to the scope at which it should persist —
local correction / workflow rule / project preference / architectural invariant /
domain policy / global preference — and never blindly globalized (§29).

Related records: `memory_candidates` (proposed_class, gated_class, assertion_kind,
payload, provenance, gate_result, status) and `evidence` — both defined in
`docs/data-model.md` (plan §7). Promotion events `memory.proposed` and
`memory.promoted` are catalog v1 event types (plan §8; see `docs/event-model.md`).

## 6. Procedural memory is data (A17; review §16)

- Procedure bodies live in top-level `procedures/` as markdown/YAML/JSON — typed
  schema/loader in `packages/core` — **not** coupled to compiled application code
  (A17; plan §4.2).
- The `procedures` table is an index (name, version, body_ref); bodies are files
  (plan §7; `docs/data-model.md` §5.10).
- Why: inspectable by humans, usable by any harness, diffable, versioned
  independently of binaries, portable into employer environments, easier for agents
  to propose edits (review §16).
- `packages/core` owns the procedure schema/loader, not the documents themselves
  (review §16). Jehad OS `procedures/` in git is canonical; harnesses may cache
  read-only copies (plan §5).
- A cognitive harness (a future shell; Hermes is an unevaluated option — A7/D2) may
  maintain convenience skill/context files, but is never authoritative for financial
  facts, commitments, decisions, evidence provenance, dependency state, policy,
  permissions, or audit history (§11.6).

## 7. What this architecture forbids

- No silent promotion of conversation into canonical truth (§3.5; plan §6.2).
- No auto-canonization of user statements about the external world, or of model
  inferences, as objective facts (review §8; T14).
- No employer/proprietary content in the personal semantic store (§4.3; gate 2; T3).
- No second conflicting world model inside any harness (§11.6; T6) — harness memory
  is cache-only.
- No vector/semantic retrieval layer in Phase 1 (not-now list, plan §16) — the four
  classes above need only structured tables, the event log, artifacts, and files.

## 8. Architectural concerns (flagged, not resolved)

1. **Classifier vocabulary vs M5 eval classes.** Plan §6.2's classifier assigns ten
   labels (discard | working | episodic | semantic | preference | commitment |
   decision | assumption | procedural | policy), while the M5 promotion eval targets
   seven classes (preference · objective claim · decision · commitment · inference ·
   episodic-only · discard — plan §13), which include "objective claim" and
   "inference" (not §6.2 labels) and omit "policy"/"procedural"/"assumption". The
   plan appears to use an eval-facing simplification of the classifier vocabulary;
   M5 must decide whether the eval's seven classes are a relabeled subset or a
   separate grading scheme. Both reproduced faithfully from their respective plan
   sections; no reconciliation invented here.
2. **`assertion_kind` values map to §38's five kinds** (observed fact, user-entered
   fact, external claim, model inference, prediction) with one deviation:
   `computed` stands where §38 says "prediction", and is broader — a deterministic
   calculation is `computed` but not a prediction. If §38's prediction/computed
   distinction ever matters (e.g. finance forecasting), it is an additive enum
   change — noted so it is not lost.
3. **Where corrections (§29 enum) live on `memory_candidates`** is implied ("an enum
   on the candidate") but plan §7's column list for `memory_candidates` does not
   name it — presumably inside `payload`/`gate_result` jsonb or as a v1.1 column.
   M1/M5 must place it explicitly. Flagged, not designed here.
