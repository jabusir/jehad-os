// SEND-ONLY structural pin (E4-S hard constraint #1 + #3). This test greps
// the app's OWN SOURCE and fails the build if anything that could read
// iMessage, touch the Messages database, or open a generic shell surface
// ever appears. It is the enforcement, not just the documentation:
//
//   - zero chat.db / sqlite / Messages-database read surface, ever
//   - the ONLY AppleScript in the codebase is the fixed send template
//   - osascript is spawned ONLY in imessage-transport.ts
//   - child processes are spawned ONLY in imessage-transport.ts (osascript)
//     and keychain.ts (`security find-generic-password` — read-only lookup)
//   - no eval / new Function — notification content is never executed

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

async function sourceFiles(): Promise<Map<string, string>> {
  const names = (await readdir(SRC_DIR)).filter((n) => n.endsWith(".ts"));
  const files = new Map<string, string>();
  for (const name of names) {
    files.set(name, await readFile(path.join(SRC_DIR, name), "utf8"));
  }
  return files;
}

describe("send-only structural pins (grep over apps/edge-agent/src)", () => {
  it("ZERO inbound/read surface: no chat.db, no sqlite, no reading Messages", async () => {
    const files = await sourceFiles();
    expect(files.size).toBeGreaterThan(0);
    const banned: readonly { pattern: RegExp; why: string }[] = [
      { pattern: /chat\.db/i, why: "Messages chat database" },
      { pattern: /sqlite/i, why: "sqlite client anywhere" },
      { pattern: /messages?\.kit/i, why: "macOS Messages framework" },
      { pattern: /every\s+(chat|message|participant|account)/i, why: "AppleScript read enumeration" },
      { pattern: /\b(read|get|count)\s+(every|the)\s+(chat|message)/i, why: "AppleScript read verb" },
      { pattern: /received\s+messages?/i, why: "inbound iMessage surface" },
      { pattern: /\beval\s*\(/, why: "eval" },
      { pattern: /new\s+Function\s*\(/, why: "dynamic code execution" },
    ];
    for (const [name, source] of files) {
      for (const { pattern, why } of banned) {
        expect(source.match(pattern), `${name}: ${why}`).toBeNull();
      }
    }
  });

  it("the ONLY AppleScript anywhere is the fixed send template (one occurrence)", async () => {
    const files = await sourceFiles();
    for (const [name, source] of files) {
      const tellCount = (source.match(/tell\s+application/g) ?? []).length;
      const sendCount = (source.match(/tell application "Messages" to send /g) ?? []).length;
      if (name === "imessage-transport.ts") {
        expect(sendCount, "exactly one send template").toBe(1);
        // Wave T allowlist: the send template + typing simulation
        // (Messages activate + System Events keystrokes — activation and
        // input injection only, ZERO reads; the banned-pattern pin above
        // still scans every file).
        expect(
          (source.match(/tell application "System Events"/g) ?? []).length,
          "exactly one System Events block",
        ).toBe(1);
        expect(
          (source.match(/tell application "Messages" to activate/g) ?? []).length,
          "exactly one activate",
        ).toBe(1);
        expect(tellCount, "no other tell blocks").toBe(3);
      } else {
        expect(tellCount, `${name} must contain no AppleScript`).toBe(0);
      }
    }
  });

  it("osascript is spawned ONLY in imessage-transport.ts", async () => {
    const files = await sourceFiles();
    for (const [name, source] of files) {
      if (name === "imessage-transport.ts") {
        expect(source).toContain('"osascript"');
      } else {
        expect(source.includes('"osascript"'), name).toBe(false);
      }
    }
  });

  it("child processes exist ONLY in the two pinned modules; keychain is find-generic-password ONLY", async () => {
    const files = await sourceFiles();
    for (const [name, source] of files) {
      if (name === "imessage-transport.ts" || name === "keychain.ts") {
        expect(source).toContain("child_process");
      } else {
        expect(source.includes("child_process"), `${name} must not spawn processes`).toBe(false);
      }
    }
    const keychain = files.get("keychain.ts")!;
    expect(keychain).toContain('"find-generic-password"');
    expect(keychain.includes("add-generic-password")).toBe(false); // no credential WRITES from the edge
    expect(keychain.includes("delete-generic-password")).toBe(false);
  });

  it("TEMPORARY banner: index.ts documents the tito move constraint", async () => {
    const files = await sourceFiles();
    const index = files.get("index.ts")!;
    expect(index).toMatch(/TEMPORARY/i);
    expect(index).toMatch(/tito/i);
    expect(index).toMatch(/UNCHANGED/i);
  });
});
