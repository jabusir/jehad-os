// Control-plane reliability wave, goal 1 — the ONE canonical repo-policy
// loader (reliability-wave directive 2026-09-25; replaces the divergent
// hand-rolled copies in imessage/conversation.ts and
// imessage/cognitive-turn.ts, whose off-by-one path resolution silently
// downgraded every cognitive turn to the principal fallback model for a
// full dogfood night — post-mortem §24 F1).
//
// Contract:
//   - ONE path resolution: POLICY_YAML_PATH (test/staging override seam)
//     ?? the repo-root policy.yaml resolved by URL depth from THIS module
//     (identical from src/ and dist/ — the module sits at
//     packages/core/{src,dist}/policy/repo-policy.{ts,js}, so
//     ../../../../policy.yaml is the repo root in both layouts).
//   - ONE 60s TTL cache with last-good retention: a transient read/parse
//     failure after a successful load keeps serving the last good policy
//     and retries next window — never sticky-broken, never deny-all.
//   - LOUD failure: a failed attempt with NO last-good policy logs a
//     distinctive stderr marker every attempt (launchd surfaces it) and
//     exposes `lastAttemptFailed` so callers can audit per-turn
//     degradation. A policy load failure can never again be silent.
//   - Fail-closed parse: parsePolicyV1 throws on any structural
//     deviation; this module catches, reports, and returns the honest
//     null state — callers decide deny-vs-degrade, but quietly running
//     an unrelated fallback configuration is NOT an option this module
//     supports (the cognitive turn refuses to run without it).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePolicyV1, type PolicyV1 } from "./ceiling.js";

export const REPO_POLICY_TTL_MS = 60_000;

/** Stderr marker greppable in launchd logs (`api.log`). */
export const REPO_POLICY_FAIL_MARKER = "[repo-policy] load failed";

/** The repo-root policy.yaml path — ONE resolution, src/ and dist/ safe. */
export function repoPolicyPath(): string {
  return (
    process.env.POLICY_YAML_PATH ??
    path.resolve(fileURLToPath(new URL("../../../../policy.yaml", import.meta.url)))
  );
}

export interface RepoPolicyState {
  /** The parsed policy, or the last good one; null when never loaded. */
  readonly policy: PolicyV1 | null;
  /** True when the MOST RECENT attempt failed (even with last-good held). */
  readonly lastAttemptFailed: boolean;
  /** The path the loader resolves (override-aware, for audits). */
  readonly path: string;
  /** The most recent failure reason, when one occurred. */
  readonly lastError: string | null;
}

interface RepoPolicyCache {
  readonly at: number;
  readonly policy: PolicyV1 | null;
  readonly lastError: string | null;
}

let cache: RepoPolicyCache | null = null;
let inflight: Promise<RepoPolicyState> | null = null;

/** Tests only: drop the cache + last-good so the next load is fresh. */
export function resetRepoPolicyCache(): void {
  cache = null;
  inflight = null;
}

async function attemptLoad(): Promise<RepoPolicyState> {
  const file = repoPolicyPath();
  try {
    const policy = parsePolicyV1(await readFile(file, "utf8"));
    cache = { at: Date.now(), policy, lastError: null };
    return { policy, lastAttemptFailed: false, path: file, lastError: null };
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // LOUD — every failed attempt (≤1 per TTL window per process): a
    // missing/unreadable/invalid expected policy must be visible in
    // service logs, never a silent null.
    console.error(
      `${REPO_POLICY_FAIL_MARKER} path=${file} reason=${reason} lastGood=${cache !== null ? "held" : "none"}`,
    );
    if (cache !== null) {
      cache = { ...cache, lastError: reason };
      return {
        policy: cache.policy,
        lastAttemptFailed: true,
        path: file,
        lastError: reason,
      };
    }
    return { policy: null, lastAttemptFailed: true, path: file, lastError: reason };
  }
}

/**
 * Load the repo policy (cached ≤60s, last-good on transient failure).
 * Never throws: failures are reported loudly and returned as state so
 * callers can deny-and-audit instead of silently downgrading.
 */
export async function loadRepoPolicy(): Promise<RepoPolicyState> {
  if (cache !== null && Date.now() - cache.at < REPO_POLICY_TTL_MS) {
    return {
      policy: cache.policy,
      lastAttemptFailed: cache.lastError !== null,
      path: repoPolicyPath(),
      lastError: cache.lastError,
    };
  }
  inflight ??= attemptLoad().finally(() => {
    inflight = null;
  });
  return inflight;
}
