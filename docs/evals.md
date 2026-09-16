# Jehad OS — Evals

- **Status:** derived Phase-0 artifact (§41 set), produced from
  `docs/plans/phase0.md` revision 3 (final, 2026-09-16).
- **Sources:** plan §13 (first vertical slice — evals block), plan §15
  (milestone acceptance criteria M4/M5/M6), plan §17 (A13 model caps, A14 no
  CI provider), §27 and §39 of the directive.
- **Citation convention:** bare `§N` = the build directive
  (`docs/directive/JEHAD_OS_BUILD_DIRECTIVE.md`); `plan §N` = the Phase 0 plan
  (`docs/plans/phase0.md`); `review §N` = the owner's external review
  (`docs/reviews/phase0-external-review.md`); `cleanup §N` = the owner's
  final-cleanup review (`docs/reviews/phase0-final-cleanup.md`).

Evals are built **with** the first vertical slice (plan §13), not after it.
The directive's rules: do not ship "agent demos" — build measurable workflows
(§27); do not increase autonomy without evidence that the workflow is
reliable (§27, §39). The autonomy maturity model (§39) starts at Level 0
(observe only); promotion to higher levels happens only when evals justify it.

There is **no CI provider until E2** (A14): `pnpm test` runs locally until the
hosting escalation lands.

## 1. Three tiers (plan §13)

| Tier | Where it runs | When it runs | Model access |
| --- | --- | --- | --- |
| Live-model evals | separate `pnpm eval` target, pinned model config | milestone acceptance only | live (OpenRouter) |
| Labeled bootstrap evals | part of the eval suite above (labeled golden sets) | with the slice; M5/M6 acceptance evidence | live (OpenRouter) |
| Hermetic checks | `pnpm test` | every test run | none |

Live-model evals run at milestone acceptance, hermetic checks on every test
run. The two never mix: hermetic checks must not depend on network, keys, or
model behavior.

## 2. Live-model evals (plan §13)

- Run via a **separate `pnpm eval` target** against a **pinned model
  config**.
- Require `OPENROUTER_API_KEY` in local `.env` (gitignored, per the AGENTS.md
  secrets rule).
- Spend is recorded in `model_calls` against the A13 caps ($20/$50 monthly
  model caps, inherited from tito Q7, applied kernel-wide).
- Emit an `eval_report` artifact — this is M5/M6 **acceptance evidence**
  (stored as an artifact; Phase 1 keeps small textual artifacts in Postgres
  so backup/restore covers them, plan §7 / review §11).
- Run at **milestone acceptance**, not on every test run.
- `pnpm eval` is added to the AGENTS.md command table when the target lands
  (M5).

## 3. Labeled bootstrap evals (plan §13; review §13)

**Label, per review §13: these are bootstrap evals — sufficient to leave
autonomy level 0, NOT sufficient evidence for broad autonomy.** Small
labeled sets gate the kernel's first workflows only; autonomy expansion
beyond that requires further evidence (§39).

### 3.1 Commitment extraction

Evaluated on a **25-item golden set extended with a hard-case subset**:

- quoted speech
- hypotheticals
- jokes
- forwarded emails
- negation
- changed / renegotiated commitments
- "maybe" / "should" / "we could"
- third-party promises — "John said yesterday he'd send it Friday" must NOT
  become *Jehad owes John*
- historical commitments
- email signatures
- prompt-injection text

**Gates and metrics:**

| Metric | Requirement |
| --- | --- |
| Overall F1 | bootstrap gate **≥ 0.8** |
| Precision (per-field) | reported |
| Recall (per-field) | reported |
| False-positive rate | reported |
| Due-date accuracy | reported |
| Direction accuracy (owes_me / i_owe) | reported |
| Counterparty accuracy | reported |
| Confidence calibration | reported |
| Precision for action-driving use | **≥ 0.9** on the bootstrap set **before any propose→act automation** |

The ≥0.9 precision threshold is a plan-chosen default; flag to Jehad if it
blocks a milestone (plan §13). Rationale (review §13): the system's mistakes
are asymmetric — missing "I'll send it Friday" is annoying; inventing "Jehad
promised $50,000 by Friday" is much worse.

### 3.2 Promotion classification

- **≥ 0.9 bootstrap accuracy** across **seven classes**:

```text
preference · objective claim · decision · commitment · inference · episodic-only · discard
```

- Includes the **claim-vs-fact distinction** (threat T14): a user-declared
  claim about the external world ("Company X has 3M customers") is stored as
  a claim, never silently promoted to verified semantic fact (plan §6.2).

### 3.3 Milestone acceptance mapping (plan §15)

- **M5:** bootstrap extraction eval ≥0.8 F1 with per-field metrics reported
  (incl. FPR, due-date/direction/counterparty accuracy, calibration);
  promotion 7-class ≥0.9; claim-not-fact test passes; all writes carry
  provenance.
- **M6:** the plan §13 acceptance checklist passes end-to-end (the extraction
  and promotion suites are its evidence), demo recorded in build log.

## 4. Hermetic checks in `pnpm test` (plan §13)

No network, no API key, no live model:

1. **Injection-resistance fixtures** — 5/5 blocked from side effects; the
   policy/capability gate denies **before any model call** (T1; §40 item 15).
2. **Egress-denial test** — e.g. finance/work-sensitive context +
   unauthorized provider → denied before the model call (T12, plan §9).
3. **Action-timeout → unknown test** — after a dispatch timeout the honest
   outcome is `unknown`; audit never claims success (T13, plan §9 / cleanup
   §5).
4. **Brief determinism smoke test** — the scheduled brief render is
   deterministic (plan §13).

## 5. What these evals are not

- They are not the directive §27 runtime metrics (human_blocked_minutes,
  autonomous_completion_rate, false_escalation_rate, ...) — those are derived
  from operations (`human_waits`, `model_calls`) and surfaced by `josctl
  metrics` in the weekly rollup (plan §14), not from the bootstrap eval sets.
- They are not a CI pipeline — none exists until E2 (A14).
- They are not broad-autonomy evidence — see the bootstrap label above
  (review §13).
