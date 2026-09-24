# AGENTS.md — repo conventions for `jehad-os`

## What this repo is

Jehad OS core: the authoritative control plane (world model, policy, events, memory
promotion, audit, workflow runtime, review queue). Harnesses (OpenClaw, coding
agents, future cognitive shells) are replaceable peripherals behind adapter
interfaces — never the system of record.

The edge node lives in a separate repo (`/Users/Shared/tito`).

## Stack (Phase 0 decisions)

- TypeScript (strict), Node 22 LTS, pnpm workspaces
- PostgreSQL 16 (canonical state), SQL migrations under source control
- No Docker required for local dev (brew postgres); no cloud dependency until the
  hosting decision (escalation E2 in the Phase 0 plan) lands

## Hard rules

- Secrets never enter git, logs, prompts, or event payloads. `.env*` is gitignored.
- Every state change of consequence flows through the event log with provenance.
- Domain code never imports workflow-vendor, model-provider, or harness SDKs
  directly — only the interfaces in `packages/adapters`.
- Builders don't self-verify: verification is a separate workflow step.
- Migrations are forward-only in intent; every migration must have a tested down
  path during development.
- ADRs in `docs/adr/` for every meaningful decision; assumptions get labels in the
  plan, not silent choices in code.

## Commands

(Defined at M0 bootstrap; keep this table current.)

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build all packages |
| `pnpm test` | Unit + integration tests (vitest, all workspaces) |
| `pnpm lint` | ESLint (flat config) |
| `pnpm dev` | Run API + worker locally (builds first) |
| `pnpm setup:db` | Create local `jehad` Postgres database (brew postgresql@16) |
| `pnpm migrate` | Apply SQL migrations (lands M1 with packages/db) |
| `pnpm eval:models` | Gateway route+answer model comparison on real prompts/parsers (lane R2; fixtures `evals/model-routing.fixtures.json`, results `docs/evals/model-routing-2026-09.*`; live via OPENROUTER_API_KEY, `EVAL_RESCORE=1` re-scores offline) |
| `pnpm eval:bakeoff:a` | §5 Track A multi-candidate answer bake-off (real answer prompt, blind judge; hermetic dry run by default, `--live` + OPENROUTER_API_KEY for the spend-capped live run; results `evals/model-bakeoff/out/track-a-*.md`) |
| `pnpm eval:bakeoff:probe` | §5 D-2 capability probe — route+interpret strict-parser validity/agreement per candidate (hermetic default, `--live` gated; results `evals/model-bakeoff/out/probe-*.md`) |
| `pnpm eval:bakeoff:pairwise` | §5/§16 owner-scored blind pairwise preference sheet (two candidates; no LLM judge) |
| `pnpm eval:answers` | W3 answer-tier bake-off on the real answer prompt (fixtures `evals/answer-quality/fixtures.json`, results `docs/evals/answer-quality-2026-09.*`; hermetic smoke always, live bake-off with blind independent-family judge via OPENROUTER_API_KEY, spend-capped $3) |

## Commit style

Short imperative subject, body when non-obvious. Don't commit generated artifacts.
`.review/` is plan-review runtime state and never gets committed.
