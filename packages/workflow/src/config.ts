/**
 * Inngest client construction for the Jehad OS workflow runtime.
 *
 * Single place where the executor connection shape is decided (ADR-0008):
 * app-hosted serve endpoint synced by URL; local dev = Inngest dev server,
 * unsigned (INNGEST_DEV=1); self-hosted `inngest start` = signed via
 * INNGEST_SIGNING_KEY (see ADR-0008 spike result, "Exact reproduction").
 */

import { Inngest } from "inngest";

export interface WorkflowClientConfig {
  /** Executor app id; default "jehad" (env INNGEST_APP_ID). */
  appId?: string;
  /** Event API base URL; default http://127.0.0.1:8288 (env INNGEST_BASE_URL). */
  baseUrl?: string;
  /** Event key; default "jehad-dev" (env INNGEST_EVENT_KEY). */
  eventKey?: string;
  /** Signing key for signed runtimes; default env INNGEST_SIGNING_KEY ("" = dev mode). */
  signingKey?: string;
}

export type ResolvedWorkflowClientConfig = Required<WorkflowClientConfig>;

export function resolveWorkflowClientConfig(
  config?: WorkflowClientConfig,
): ResolvedWorkflowClientConfig {
  return {
    appId: config?.appId ?? process.env.INNGEST_APP_ID ?? "jehad",
    baseUrl: config?.baseUrl ?? process.env.INNGEST_BASE_URL ?? "http://127.0.0.1:8288",
    eventKey: config?.eventKey ?? process.env.INNGEST_EVENT_KEY ?? "jehad-dev",
    signingKey: config?.signingKey ?? process.env.INNGEST_SIGNING_KEY ?? "",
  };
}

export function createInngestClient(config?: WorkflowClientConfig): Inngest {
  const resolved = resolveWorkflowClientConfig(config);
  if (!resolved.signingKey) {
    // Unsigned local dev against the Inngest dev server (spike pattern).
    process.env.INNGEST_DEV ??= "1";
  }
  return new Inngest({
    id: resolved.appId,
    baseUrl: resolved.baseUrl,
    eventKey: resolved.eventKey,
    ...(resolved.signingKey ? { signingKey: resolved.signingKey } : {}),
  });
}
