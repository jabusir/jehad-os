# Zero-cost architecture inspection — reference work agent vs Jin-native

- **Question:** why does the reference work agent reliably convert colloquial
  state-language ("we're good on the caterer now") into tool calls, while
  Jin-native narrates? Static diff only — no runs, no spend.
- **Sources inspected (read-only):**
  - Reference: the owner's live OpenClaw work agent — runtime prompt builder
    (`~/.openclaw/tools/.../dist/system-prompt-params-*.mjs`), tool-description
    presets (`tool-description-presets-*.mjs`), workspace files
    (`~/.openclaw/workspace/AGENTS.md`); plus the Tito home-agent deployment
    (`/Users/Shared/tito/workspace/{AGENTS,SOUL}.md`) as a second reference
    voice.
  - Jin-native: `packages/core/src/imessage/native/native-turn.ts`
    (ACTION RULES / system assembly), `native/tool-registry.ts`
    (tool descriptions), trajectory rendering (§8.2).
- Reference model: claude-opus-5 (config default). Jin: gpt-4.1. Model delta
  is acknowledged but NOT the finding — see §3.

## 1. The direct answer: the reference has a general execution bias, Jin has a verb classifier

**Reference system prompt (verbatim, OpenClaw `buildExecutionBiasSection`):**

> ## Execution Bias
> - Actionable request: act now.
> - Non-final turn: advance with tools, or ask one safety-blocking decision.
> - Continue to done/real blocker; no plan-only finish when tools can act.
> - Weak/empty result: vary query/path/command/source, then conclude.
> - Mutable facts: live-check files/git/time/versions/services/processes/packages.
> - Final claim needs evidence or named blocker.
> - Long work: brief update, keep going; background/subagents when useful.

> ## Tool Call Style
> - Routine low-risk: call silently.
> - Narrate only complex, sensitive/destructive, or requested steps.
> - First-class tool exists: use it; never ask user for equivalent CLI/slash.

**Jin-native (verbatim, `native-turn.ts` ACTION RULES):**

> - If the user's message asks to **set, remember, add, complete, mark, or
>   change** ANYTHING, call the write tool in THIS reply — never reply with
>   only words.

**This is the whole finding.** OpenClaw's rule is verb-independent and
completion-oriented ("act now", "no plan-only finish when tools can act",
"final claim needs evidence or named blocker"). Jin's rule is a verb-list —
"a tool-use classifier implemented in prompt prose," exactly the owner's
suspicion. "We're good on the caterer now" and "alterations never happened"
contain none of {set, remember, add, complete, mark, change}, so Jin's gate
never fires and the model narrates acknowledgment — which is what W2b
observed (zero tool calls, 0/6). The same phrasings under OpenClaw's bias
rule are simply "actionable requests" → act.

Secondary contrast: OpenClaw's default posture is act-then-narrate ("routine
low-risk: call silently"); Jin's prompt spends most of its authority text on
when NOT to act (truth rules, staging rules, jargon rules), with a single
trigger-list line for when to act. The inhibitor:incentive ratio is inverted.

## 2. How the reference teaches tools (answers, question by question)

1. **Tool descriptions:** one-line imperative summaries + when-to-use guidance
   in the description itself. Examples: sessions_list — "…Use before
   history/send target selection."; sessions_history — "Before reply/debug/
   resume…"; cron — "Schedule reminders, automations, wake events." The
   guidance is semantic ("use before X", "use for Y"), never phrase-conditional.
2. **Global when-to-use instructions:** the Execution Bias + Tool Call Style
   sections above — four bullets of general principle, no verbs, no phrases.
3. **Persistence-vs-prose principle:** yes, explicitly — "no plan-only finish
   when tools can act" and "final claim needs evidence or named blocker."
   Tito's SOUL.md demonstrates the same stance semantically: example turns are
   act-then-confirm ("Done — lights off, AC easing down to 72"), never
   acknowledge-then-ask. Note these examples are GENERAL demonstrations of
   posture, not phrase→action mappings.
4. **Prior structured tool trajectory:** the full native conversation —
   OpenClaw sessions persist every tool call/result as real API messages
   (sqlite-backed), so the model sees its own complete working trajectory
   every turn, plus `sessions_history`/`sessions_search` tools for explicit
   recovery. Jin ships a bounded digest block (trailing 3 turns, summaries).
5. **Tool-use examples:** present as semantic posture demos (SOUL.md example
   turns, skills' SKILL.md walkthroughs), not phrase tables. The workspace
   AGENTS.md carries principles ("External vs Internal: safe to do freely /
   ask first" — a two-bucket authority model), not utterance triggers.
6. **Model delta (Terra/opus vs gpt-4.1)?** Real but secondary. OpenClaw's
   guidance is model-agnostic prose; nothing in it requires opus-class
   reasoning. The W2b evidence cuts against blaming the model first: gpt-4.1
   executed fine when rules/descriptions drove it (capture, offers, delegate,
   profile — all generalized) and under-acted exactly where Jin's own
   verb-gate failed to fire. Contract quality is the first-order variable;
   model class is second.
7. **Are Jin's ACTION RULES a disguised classifier?** **Yes.** Six verbs +
   "ANYTHING" + "in THIS reply" is a phrasing gate. It scored well on dev
   (whose phrasings contain those verbs) and failed on unseen colloquial
   completion language — the exact overfit signature W2b measured.
8. **Why would the reference treat "we're good on the caterer now" as
   state-changing?** Three stacked general mechanisms: (a) Execution Bias
   makes any actionable statement an instruction to act; (b) the tool layer
   exposes durable state as first-class (files/memory/sessions) so "updating
   reality" is the default way to fulfill a turn; (c) tool descriptions carry
   the when-to-use. No phrase matching anywhere in the chain.
9. **Vague decline/affirmation?** Same mechanism: the offer/pending object is
   in context, the bias rule says act, and the tool (apply/decline by id)
   carries the semantics. There is no phrase table to miss. (Jehad adds a
   kernel requirement the reference lacks: staged offers + consent classes —
   the offers.apply tool already encapsulates that; the gap is upstream
   recognition, not the gate.)
10. **Richer durable-object affordances?** Yes, materially: OpenClaw exposes
    memory files as active directives (USER.md/MEMORY.md loaded per session),
    memory search/get tools, sessions as first-class queryable objects, and a
    workspace the agent reads/writes freely within an "External vs Internal"
    authority split. Jin exposes pending offers + live check-ins + bounded
    trajectory digests. The model that can SEE durable state treats updating
    it as normal work.

## 3. Verdict on the comparison

Jin-native's gap is not architectural (the loop, gateway, authority model, and
truth machinery are sound and proved themselves in W2b) — it is that the
cognitive guidance layer was written as a **phrase-triggered classifier**,
inheriting the envelope's teaching instincts in prose form. The reference
shows the mature pattern: **a handful of verb-independent general principles +
when-to-use in tool descriptions + full-fidelity trajectory + visible durable
state.**

## 4. Options (owner decision; nothing implemented)

**A. Small generic improvement to native ergonomics/context (RECOMMENDED first
move).** Replace the ACTION RULES verb-gate with a general execution-bias
section in the reference's shape (act-now / no plan-only finish when tools can
act / evidence-or-blocker), move when-to-use into each tool description
semantically, widen the trajectory window for the cross-turn chain class, and
port the "External vs Internal" two-bucket authority framing on top of the
ratified §6 grounding (the kernel gates stay untouched; only the cognitive
guidance changes). Cost: prompt/description text only — zero kernel changes.
Risk: prompt-generalization is what just failed once; the mitigation is that
this change REMOVES phrasing dependencies rather than adding them.
Validation: one new owner-authored holdout (unseen), after the change.

**B. Different primary model for native cognition.** Defer. The contract fix
(A) is a prerequisite to fairly evaluating any model swap; W2b showed gpt-4.1
acts fine when the interface drives it.

**C. Narrow the interaction contract for free-form mutation.** Not yet — it
would discard native's generalized wins (capture/offers/delegate/profile all
generalized) to fix one class that option A targets directly.

**D. Anything larger (bake-offs, W3, history/memory).** Frozen, per owner
directive.

## 5. Recorded, not acted on

- ACTION RULES verb-gate removal is a cognition-guidance change — pre-W2b-freeze
  discipline technically ended with W2b, but the owner's directive for this
  phase is inspect-then-decide; nothing above has been applied.
- W2b runner artifact (confirm-lane ledger synthesis missing) still needs the
  one-line fix in `w2b-holdout.ts` before any future holdout run.
- Judge sensitivity (capability explanations flagged as action claims) — note
  for any future judging run.
