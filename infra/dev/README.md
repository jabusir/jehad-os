# infra/dev

## setup-db.sh

Creates the local `jehad` PostgreSQL database (idempotent — safe to re-run).
Assumes Homebrew `postgresql@16`:

    brew install postgresql@16
    brew services start postgresql@16
    pnpm setup:db        # or: bash infra/dev/setup-db.sh

Override the database name with `JEHAD_DB_NAME` if ever needed. No Docker
(ADR-0001, AGENTS.md).

## backup.sh / restore.sh

M1 durability (plan §15 M1, T16). Artifacts live in Postgres (Option A), so a
database dump IS the artifact backup:

    pnpm backup                     # pg_dump -Fc → data/backups/<db>-<ts>.dump
    bash infra/dev/restore.sh <dump> <target-db>    # refuses `jehad` without --force

The practiced-restore regression (rows AND artifact content byte-for-byte) is
`packages/db/tests/backup-restore.test.ts` — runs whenever TEST_DATABASE_URL
is set. Retention pruning + nightly scheduling: pending; encryption-at-rest
for dumps: noted for E2.

## pnpm-lock.yaml is generated on first install

This scaffold was authored before pnpm existed on this machine, so
`pnpm-lock.yaml` is intentionally absent from the scaffold commit. The **first
`pnpm install` on the toolchain machine generates it — commit it immediately
after.** The lockfile is the one generated artifact that belongs in git; an
untracked lockfile means non-reproducible installs.

Toolchain bootstrap order (owner):

1. `brew install node@22 postgresql@16` (then link/start per brew hints)
2. `corepack enable` (or `npm install -g pnpm`)
3. `pnpm install` → commit the generated `pnpm-lock.yaml`
4. `pnpm build && pnpm test` → expect green
5. `pnpm setup:db` → local `jehad` db ready for M1 migrations

Note: workspace packages resolve each other through `dist/` (built output).
`pnpm build` runs first inside `pnpm dev`; run `pnpm build` once before any
direct `tsx`/`pnpm --filter @jehad/worker start` style invocation. `pnpm test`
(vitest on sources) needs no prior build.
