/**
 * §5 model bake-off — shared CLI/env/output plumbing for the three tools
 * (Track A runner, capability probe, pairwise harness).
 *
 * Conventions mirror evals/answer-quality/run.ts: env wins over the repo
 * .env file; OPENROUTER_API_KEY falls back to the macOS per-user launchd
 * context; live calls go through the same OpenRouter request shape as the
 * answer-quality runner (`liveCallWithRetry` is reused from there). LIVE
 * mode requires BOTH `--live` and a resolved key — default is a hermetic
 * fake-provider dry run that validates plumbing with zero network.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Plan §5 candidate list (order = the plan's numbering). */
export const TRACK_A_CANDIDATES = [
  "openai/gpt-4o-mini", // 1 — incumbent FAST
  "openai/gpt-4.1-mini", // 2 — incumbent route/interpret
  "anthropic/claude-sonnet-4.5", // 3 — incumbent STANDARD
  "openai/gpt-4.1", // 4
  "anthropic/claude-opus-4.6", // 5 — strongest practical candidate
  "google/gemini-3.8-flash", // 6 — fallback reference
] as const;

/** The existing bake-off's blind independent-family judge (unchanged, R5). */
export const DEFAULT_JUDGE = "google/gemini-2.5-flash";

export const BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_SLEEP_MS = 150;

// ------------------------------------------------------------------- CLI

export interface CliArgs {
  readonly flags: ReadonlySet<string>;
  readonly options: ReadonlyMap<string, string>;
  readonly positional: readonly string[];
}

/** Minimal `--flag` / `--opt value` / `--opt=value` parser (no deps). */
export function parseArgv(argv: readonly string[]): CliArgs {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      options.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(arg.slice(2), next);
      i += 1;
    } else {
      flags.add(arg.slice(2));
    }
  }
  return { flags, options, positional };
}

export function commaList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `--candidates a,b` or EVAL_MODELS, else the plan §5 default list. */
export function resolveCandidates(option: string | undefined, fallback: readonly string[]): string[] {
  const fromCli = commaList(option);
  if (fromCli.length > 0) return fromCli;
  const fromEnv = commaList(process.env.EVAL_MODELS);
  if (fromEnv.length > 0) return fromEnv;
  return [...fallback];
}

// -------------------------------------------------------------------- env

/** env wins over the repo .env file (same convention as model-routing.ts). */
export function loadDotEnv(): void {
  const envFile = path.resolve(HERE, "../../.env");
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match !== null) {
      const [, key, value] = match;
      if (key !== undefined && value !== undefined && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

/** OPENROUTER_API_KEY from env, then the macOS per-user launchd context. */
export function resolveApiKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY ?? "";
  if (fromEnv.trim().length > 0) return fromEnv;
  try {
    const fromLaunchctl = execSync("launchctl getenv OPENROUTER_API_KEY", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (fromLaunchctl.length > 0) return fromLaunchctl;
  } catch {
    // launchctl unavailable — callers treat "" as "no key"
  }
  return "";
}

export interface LiveGate {
  readonly live: boolean;
  readonly reason: string | null;
}

/** LIVE only when `--live` passed AND a key resolves (never either alone). */
export function liveGate(argv: CliArgs, apiKey: string): LiveGate {
  if (!argv.flags.has("live")) return { live: false, reason: "no --live flag (hermetic dry run)" };
  if (apiKey.trim().length === 0) {
    return { live: false, reason: "OPENROUTER_API_KEY is not set (env or launchctl)" };
  }
  return { live: true, reason: null };
}

export function sleepMs(defaultMs: number): number {
  const raw = process.env.EVAL_SLEEP_MS;
  return raw !== undefined && raw.length > 0 ? Number(raw) : defaultMs;
}

// ----------------------------------------------------------------- output

export function outDir(): string {
  const dir = path.join(HERE, "out");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeArtifact(name: string, content: string): string {
  const file = path.join(outDir(), name);
  writeFileSync(file, `${content}\n`);
  return file;
}

// ---------------------------------------------------------------- shuffle

/** Deterministic 32-bit seed from a string (FNV-1a-ish, no deps). */
export function seedOf(...parts: readonly string[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2f;
  }
  return h >>> 0;
}

/** mulberry32 PRNG — deterministic given the seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
