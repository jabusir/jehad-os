/**
 * josctl commands — `josctl capture "<text>"` and `josctl decide "<text>"`
 * (plan §13). Normalization goes through the cli capture SourceAdapter
 * (@jehad/adapters); transport goes through client.ts; the credential comes
 * from the Keychain reader (injectable for tests).
 *
 * The adapter mints a fresh uuid externalId per invocation (plan §8), so the
 * same words captured twice are two events — dedupe only happens on adapter
 * RETRY, which reuses the externalId.
 */

import type { Writable } from "node:stream";
import { normalizeCliCapture, type CliCaptureKind } from "@jehad/adapters";
import { postEvent, type FetchLike, type IngestResult } from "./client.js";

export interface CliDeps {
  fetchImpl: FetchLike;
  readCredential: () => Promise<string>;
  baseUrl: string;
  output?: Writable;
  errOutput?: Writable;
}

export const USAGE = `usage: josctl capture "<text>"
       josctl decide "<text>"\n`;

export function parseCliArgs(argv: readonly string[]): { kind: CliCaptureKind; text: string } | null {
  const [command, text] = argv.slice(2);
  if (command !== "capture" && command !== "decide") return null;
  if (typeof text !== "string" || text.trim().length === 0) return null;
  return { kind: command, text: text.trim() };
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed === null) {
    (deps.errOutput ?? process.stderr).write(USAGE);
    return 2;
  }
  return emitCapture(parsed.kind, parsed.text, deps);
}

async function emitCapture(
  kind: CliCaptureKind,
  text: string,
  deps: CliDeps,
): Promise<number> {
  const out = deps.output ?? process.stdout;
  const errOut = deps.errOutput ?? process.stderr;

  let credential: string;
  try {
    credential = await deps.readCredential();
  } catch (err) {
    errOut.write(
      `josctl: could not read credential from macOS Keychain (jehad-os/josctl): ${
        err instanceof Error ? err.message : String(err)
      }\nMint one with: pnpm --filter @jehad/api exec tsx src/mint-credential.ts josctl\n`,
    );
    return 1;
  }

  const normalized = normalizeCliCapture({ kind, text });
  let result: IngestResult;
  try {
    result = await postEvent(deps.baseUrl, credential, { ...normalized, schemaVersion: 1 }, deps.fetchImpl);
  } catch (err) {
    errOut.write(
      `josctl: could not reach the API at ${deps.baseUrl} (${
        err instanceof Error ? err.message : String(err)
      }); is it running? (pnpm dev)\n`,
    );
    return 1;
  }
  return reportResult(result, out, errOut);
}

function reportResult(
  result: IngestResult,
  out: Writable,
  errOut: Writable,
): number {
  if (result.ok) {
    out.write(`${JSON.stringify({ id: result.id, type: result.type, duplicate: result.duplicate })}\n`);
    return 0;
  }
  if (result.status === 401) {
    errOut.write("josctl: unauthorized — credential rejected; re-run mint-credential to rotate\n");
    return 1;
  }
  errOut.write(
    `josctl: ingest failed (HTTP ${result.status}${result.code ? ` ${result.code}` : ""}${
      result.message ? `: ${result.message}` : ""
    })\n`,
  );
  return 1;
}
