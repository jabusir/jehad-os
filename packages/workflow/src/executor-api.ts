/**
 * Executor API — the read/control surface the adapter uses against the
 * Inngest dev server / self-hosted executor.
 *
 * Probed against inngest-cli 1.44.0 (dev server):
 * - `GET  /v1/events/{eventId}/runs` → executor run ids for a trigger
 *   event. Its `status` field LIES ("Completed" while parked at a wait —
 *   ADR-0008 friction note 4): only `run_id` is read here.
 * - `POST /v0/gql` `run(runID:) { status trace { childrenSpans … } }` →
 *   truthful terminal states (COMPLETED/FAILED/CANCELLED) plus the step
 *   span tree; a parked waitForEvent shows a span with status WAITING
 *   and our `wait:signal:*` / `wait:approval:*` step id.
 * - `POST /v0/gql` `cancelRun(runID:)` → cancels parked runs (verified:
 *   run status becomes CANCELLED with ended_at set).
 */

import { waitKindFromStepId, type DetailedWorkflowStatus } from "./names.js";

export interface ExecutorRunDetail {
  /** Raw executor status string (COMPLETED | FAILED | CANCELLED | RUNNING | QUEUED | SKIPPED). */
  readonly status: string;
  /** Step ids of spans currently parked at a wait, in span order. */
  readonly waitingStepIds: readonly string[];
}

export interface ExecutorApi {
  runIdForEvent(eventId: string): Promise<string | undefined>;
  runDetail(runId: string): Promise<ExecutorRunDetail>;
  cancel(runId: string): Promise<void>;
}

export interface FetchResponseLike {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponseLike>;

interface SpanShape {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly childrenSpans?: readonly unknown[];
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

async function gql(
  baseUrl: string,
  fetchImpl: FetchLike,
  query: string,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${baseUrl}/v0/gql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: unknown; errors?: unknown } | undefined;
  if (!res.ok || !body || body.data === undefined || body.data === null) {
    const detail = body?.errors !== undefined ? JSON.stringify(body.errors) : `HTTP ${res.status}`;
    throw new Error(`executor gql request failed: ${detail}`);
  }
  return body.data as Record<string, unknown>;
}

function collectWaitingSpans(span: SpanShape, out: string[]): void {
  if (span.status === "WAITING" && typeof span.name === "string") out.push(span.name);
  for (const child of span.childrenSpans ?? []) {
    if (child && typeof child === "object") collectWaitingSpans(child as SpanShape, out);
  }
}

export function createHttpExecutorApi(baseUrl: string, fetchImpl: FetchLike = defaultFetch): ExecutorApi {
  return {
    async runIdForEvent(eventId: string): Promise<string | undefined> {
      const res = await fetchImpl(`${baseUrl}/v1/events/${eventId}/runs`);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`executor events-runs lookup failed: HTTP ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ run_id?: unknown }> } | undefined;
      const first = body?.data?.[0];
      return typeof first?.run_id === "string" ? first.run_id : undefined;
    },

    async runDetail(runId: string): Promise<ExecutorRunDetail> {
      const data = await gql(
        baseUrl,
        fetchImpl,
        // childrenSpans recursion is fixed-depth in gql; four levels cover
        // root → workflow → step groups → steps on the dev server's trace.
        `query { run(runID: "${runId}") { status trace { childrenSpans { name status childrenSpans { name status childrenSpans { name status childrenSpans { name status } } } } } } }`,
      );
      const run = data.run as { status?: unknown; trace?: unknown } | undefined;
      if (!run || typeof run.status !== "string") {
        throw new Error(`executor returned no run detail for ${runId}`);
      }
      const waiting: string[] = [];
      if (run.trace && typeof run.trace === "object") {
        collectWaitingSpans(run.trace as SpanShape, waiting);
      }
      return { status: run.status, waitingStepIds: waiting };
    },

    async cancel(runId: string): Promise<void> {
      try {
        await gql(baseUrl, fetchImpl, `mutation { cancelRun(runID: "${runId}") { id } }`);
      } catch (err) {
        // Cancelling an already-ended run is an idempotent no-op.
        if (err instanceof Error && err.message.includes("cannot cancel an ended run")) return;
        throw err;
      }
    },
  };
}

/**
 * Map executor run state (truthful gql/trace view) to the six-state
 * workflow vocabulary. Never called with the events-API status field.
 */
export function mapExecutorDetail(detail: ExecutorRunDetail): DetailedWorkflowStatus {
  switch (detail.status) {
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
      // Never started (e.g. start-timeout) — surfaced as failed.
      return "failed";
    default: {
      const wait = detail.waitingStepIds
        .map((id) => waitKindFromStepId(id))
        .find((kind): kind is DetailedWorkflowStatus => kind !== null);
      return wait ?? "running";
    }
  }
}
