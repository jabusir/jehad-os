# ADR-0008 M3 spike — throwaway scaffolding

Crash-resume-signal protocol driver proving plan §12 / ADR-0008 decision 4.
NOTHING here is production code or wired into `apps/worker`; it exists to gate
ADR-0008 and is deleted or ignored after the adapter lands.

- `spike.ts` — the spike workflow (persist step → `waitForEvent` signal wait →
  finalize). Marker/invocation files under `spike/.run/` are the only state
  written (executor state ≠ canonical state, ADR-0008).
- `worker.ts` — serves the function over `node:http` via `inngest/node`
  (zero extra deps). This is the "app/worker" process. `SPIKE_RUNTIME=start`
  + `INNGEST_SIGNING_KEY` switch it to the signed `inngest start` runtime.
- `driver.ts` — runs three scenarios, writes `spike/.run/report.json`,
  exit 0 iff the gate scenarios pass:
  - **A — official ADR-0008 gate** (`inngest dev`): start → persist step →
    `kill -9` worker → restart worker → resume (memoized) → signal → complete.
  - **B — full crash, durable shape** (`inngest start` single binary + external
    Redis; no Docker): same sequence but `kill -9` BOTH executor and worker;
    run state survives in Redis; resume → signal → complete.
  - **C — negative control** (`inngest dev`, kill both): documents that the
    dev server's in-flight run state is in-memory and dies with the process
    (expected: run stranded; recorded CONFIRMED, not a gate failure).

## Prerequisites

- Node 22, pnpm (workspace installed)
- `npx -y inngest-cli@1.44.0` (auto-downloaded on first run, ~30s)
- `brew install redis` (scenario B only — durable run state; no Docker)

## Reproduce

```bash
eval "$(/opt/homebrew/bin/brew shellenv)"
cd packages/workflow
pnpm install
pnpm exec tsx spike/driver.ts   # ~2 min; ports 8288 / 4040 / 6399 must be free
```

Exact executor commands the driver issues (see `driver.ts` for full context):

```bash
# A / C: dev server (history persisted to sqlite via --persist; run state NOT durable)
npx -y inngest-cli@1.44.0 dev -p 8288 -u http://127.0.0.1:4040/api/inngest \
  --no-discovery --persist --poll-interval 2

# B: self-hosted single binary, durable run state in external redis
redis-server --port 6399 --save "1 1" --dir <scratch>
npx -y inngest-cli@1.44.0 start -p 8288 -u http://127.0.0.1:4040/api/inngest \
  --no-ui --event-key spike-dev --signing-key deadbeefdeadbeefdeadbeefdeadbeef \
  --sqlite-dir <scratch> --redis-uri redis://127.0.0.1:6399
```

Results recorded in `docs/adr/ADR-0008.md` (Spike result section, 2026-09-17).
