// Wave T: imsg-plus IPC client — file protocol per IMsgInjected.m /
// MessagesLauncher.swift. Pure fs against a temp "container" dir.

import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  imsgPlusHelperAlive,
  imsgPlusSetTyping,
  ImsgPlusTimeoutError,
  ImsgPlusUnavailableError,
} from "../src/imsg-plus-client.js";

let home: string;

function freshHome(): string {
  home = mkdtempSync(path.join(tmpdir(), "imsg-plus-test-"));
  mkdirSync(path.join(home, "Library", "Containers", "com.apple.MobileSMS", "Data"), {
    recursive: true,
  });
  return home;
}

function helperAliveMarker(): void {
  writeFileSync(path.join(home, "Library", "Containers", "com.apple.MobileSMS", "Data", ".imsg-plus-ready"), "");
}

/** Fake helper: watches for the command file and answers like the dylib. */
function fakeHelper(opts: { success: boolean; delayMs?: number }): () => void {
  const dir = path.join(home, "Library", "Containers", "com.apple.MobileSMS", "Data");
  const timer = setInterval(() => {
    const commandFile = path.join(dir, ".imsg-plus-command.json");
    if (!existsSync(commandFile)) return;
    const raw = readFileSync(commandFile, "utf8");
    if (raw.length <= 2) return;
    const command = JSON.parse(raw) as { id: number };
    const respond = (): void => {
      writeFileSync(
        path.join(dir, ".imsg-plus-response.json"),
        JSON.stringify({ id: command.id, success: opts.success, handle: "x", typing: true }),
      );
      writeFileSync(commandFile, "");
    };
    if (opts.delayMs === undefined) respond();
    else setTimeout(respond, opts.delayMs);
    clearInterval(timer);
  }, 5);
  return () => clearInterval(timer);
}

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
});

describe("imsgPlusSetTyping (Wave T file IPC)", () => {
  it("fails fast when the helper is not running (no ready marker)", async () => {
    freshHome();
    await expect(imsgPlusSetTyping("+15551234567", true, { homeDir: home })).rejects.toBeInstanceOf(
      ImsgPlusUnavailableError,
    );
  });

  it("writes the command, waits for the matching response, clears both", async () => {
    freshHome();
    helperAliveMarker();
    const stop = fakeHelper({ success: true });
    try {
      await imsgPlusSetTyping("+15551234567", true, {
        homeDir: home,
        pollIntervalMs: 5,
        timeoutMs: 2000,
      });
      const dir = path.join(home, "Library", "Containers", "com.apple.MobileSMS", "Data");
      expect(readFileSync(path.join(dir, ".imsg-plus-command.json"), "utf8").length).toBeLessThanOrEqual(2);
      expect(readFileSync(path.join(dir, ".imsg-plus-response.json"), "utf8").length).toBeLessThanOrEqual(2);
    } finally {
      stop();
    }
  });

  it("helper rejection (success:false) surfaces as unavailable", async () => {
    freshHome();
    helperAliveMarker();
    const stop = fakeHelper({ success: false });
    try {
      await expect(
        imsgPlusSetTyping("+15551234567", false, { homeDir: home, pollIntervalMs: 5, timeoutMs: 2000 }),
      ).rejects.toBeInstanceOf(ImsgPlusUnavailableError);
    } finally {
      stop();
    }
  });

  it("no response → timeout", async () => {
    freshHome();
    helperAliveMarker();
    await expect(
      imsgPlusSetTyping("+15551234567", true, { homeDir: home, pollIntervalMs: 5, timeoutMs: 120 }),
    ).rejects.toBeInstanceOf(ImsgPlusTimeoutError);
  });

  it("liveness probe matches the ready marker", () => {
    freshHome();
    expect(imsgPlusHelperAlive(home)).toBe(false);
    helperAliveMarker();
    expect(imsgPlusHelperAlive(home)).toBe(true);
  });
});
