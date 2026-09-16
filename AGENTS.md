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
| `pnpm test` | Unit + integration tests |
| `pnpm migrate` | Apply SQL migrations |
| `pnpm dev` | Run API + worker locally |

## Commit style

Short imperative subject, body when non-obvious. Don't commit generated artifacts.
`.review/` is plan-review runtime state and never gets committed.
