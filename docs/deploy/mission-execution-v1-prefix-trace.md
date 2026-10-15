# Mission Execution v1 — pre-fix failure trace (base 3a306a4)

Recorded BEFORE any fix (wave: make Delegate actually delegate — RESEARCH).
Every claim below was confirmed by reading the code at base `3a306a4`.

## The failure path

```
POST /ui/delegate  (apps/api/src/routes/ui.ts:836)
  → createAndDispatchOutcome()        (packages/workflow/src/delegate-shared.ts:94)
      criteria = [{ criterion, verificationMethod: { kind: "owner_judgment" } }]   (:169)
      createOutcome(...)           (delegate-shared.ts:161) — NO plan passed
  → createOutcome()                 (packages/core/src/outcomes/service.ts:167)
      CreateOutcomeInput has NO plan field (:69-79)
      INSERT INTO outcomes (...) omits the plan column (:183-195)
      → outcomes.plan = DB default '[]'   (packages/db/migrations/024_outcomes.sql:38)
  → dispatch.start("outcome-executor", …)   (delegate-shared.ts:193)
  → runOutcomeExecutor()            (packages/workflow/src/outcome-workflows.ts:177)
      plan scan:  no {wait:…} entry  (:223 find → undefined)
                  no {assign:…} entry (:296 find → undefined)
      → step 3 "Nothing runnable + unresolved criteria → owner verification"
        transitionOutcome(…, "waiting_user", …)   (:710)
  → owner is asked to do/judge the thing himself (pauseForApproval, :711)
```

## Specific confirmations

| Claim | Verdict | Evidence (base 3a306a4) |
| --- | --- | --- |
| `DelegateFormInput` has no execution/mode field | CONFIRMED | delegate-shared.ts:46-59 — only goal/directive/criteria/constraints/deadlineAt/submissionId |
| `createAndDispatchOutcome` creates owner_judgment criteria | CONFIRMED | delegate-shared.ts:167-170 — every criterion hard-wired `verificationMethod: { kind: "owner_judgment" }` |
| `createOutcome` receives no runnable research plan from this path | CONFIRMED | delegate-shared.ts:161-177 — no plan argument; `CreateOutcomeInput` has no plan field (outcomes/service.ts:69-79) |
| `Outcome.plan` is empty | CONFIRMED | 024_outcomes.sql:38 `plan jsonb NOT NULL DEFAULT '[]'`; insert omits it |
| `runOutcomeExecutor` only does real worker work for a typed `{assign:…}` entry | CONFIRMED | outcome-workflows.ts:296-452 — the D1 assignment branch; empty plan falls to :703-717 → `waiting_user` |
| Current research worker is a single model pass over buildContextPackage | CONFIRMED | outcome-workflows.ts:315 (`buildContextPackage`) + :353-386 (one `harness.start`) + ModelHarnessAdapter (assignments-adapter.ts:49-80) = ONE callModel |
| `RESEARCH_SYSTEM_STANCE` explicitly limits the worker to the provided context package | CONFIRMED | outcome-workflows.ts:119-124 — "You synthesize ONLY from the context package you were given"; "general knowledge … may never supply a fact" |

## Consequence

A delegated mission (the only mission type the Delegate UI can create) has an
empty plan and owner_judgment-only criteria: the executor has nothing to run,
parks the outcome at `waiting_user`, and the Attention card (base commit
3a306a4) honestly says "Parked with you — mark it done when it happens, or say
it didn't." The system cannot do the work itself. The newest product copy
acknowledges exactly this (outcome-producer.ts:40-45).

## Web capability (also inspected before fixing)

- `ModelProvider.chat()` exists (adapters/src/ports/model-provider.ts:140) and
  the OpenRouter adapter implements it (model-providers/openrouter.ts:159), but
  `ChatRequest.tools` maps ONLY to `{type:"function"}` wire tools (:167-173).
  No server-tool surface (`openrouter:web_search` / `openrouter:web_fetch`).
- OpenRouter server tools (docs, fetched 2026-10-15): pass
  `tools: [{type:"openrouter:web_search", parameters:{…}}, …]` +
  top-level `max_tool_calls`; results return as `url_citation` annotations on
  the assistant message; usage reports `usage.server_tool_use`.
  → minimal clean integration: extend `ChatRequest`/`ChatResult` + the
  OpenRouter wire body; no provider rewrite required.
