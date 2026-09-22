// Wave T: typing-simulation transport — script shape, inert-content
// escaping, fallback to the fixed direct send on ANY UI-scripting failure,
// auto-disable after consecutive failures, and the kill switch.

import { describe, expect, it, vi } from "vitest";
import {
  buildSendCommand,
  buildTypingSendScript,
  escapeAppleScriptString,
  makeTypingAwareTransport,
} from "../src/imessage-transport.js";
import { loadConfig } from "../src/config.js";

const TARGET = "+15551234567";

describe("buildTypingSendScript (Wave T)", () => {
  it("activates Messages, commits the recipient, types, then sends LAST", () => {
    const script = buildTypingSendScript(TARGET, "Reminder: call Jamaal today.");
    expect(script).toContain('tell application "Messages" to activate');
    expect(script).toContain('keystroke "n" using command down');
    expect(script).toContain(`keystroke "${TARGET}"`);
    expect(script).toContain('keystroke "Reminder: call Jamaal today."');
    // the hard send-Return is the FINAL keystroke statement
    const keystrokes = script.split("\n").filter((l) => l.includes("keystroke"));
    expect(keystrokes[keystrokes.length - 1]).toBe("  keystroke return");
  });

  it("newlines become Option+Return soft breaks (never mid-text sends)", () => {
    const script = buildTypingSendScript(TARGET, "line one\nline two");
    expect(script).toContain("keystroke return using option down");
    const softBreaks = script.split("\n").filter((l) => l.includes("using option down")).length;
    expect(softBreaks).toBe(1);
  });

  it("content is inert — chunks go through the AppleScript escaper", () => {
    const raw = 'say "hi" \\ ok';
    const script = buildTypingSendScript(TARGET, raw);
    // the raw unescaped form must never appear inside a keystroke
    expect(script).not.toContain('keystroke "say "');
    expect(script).toContain(`keystroke "${escapeAppleScriptString(raw)}"`);
  });

  it("rejects invalid targets before any script is built", () => {
    expect(() => buildTypingSendScript("not-a-target", "x")).toThrow(/invalid target/);
  });
});

describe("makeTypingAwareTransport (fallback + auto-disable)", () => {
  it("happy path: typing script runs, no direct send", async () => {
    const runner = vi.fn(async (_file: string, args: readonly string[]) => ({
      stdout: "",
      stderr: "",
    }));
    const transport = makeTypingAwareTransport({ runner });
    await transport(TARGET, "hello");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![1][1]).toContain("keystroke");
  });

  it("ANY UI failure falls back to the fixed direct send", async () => {
    const runner = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[1].includes("keystroke")) throw new Error("osascript exited 1");
      return { stdout: "", stderr: "" };
    });
    const transport = makeTypingAwareTransport({ runner });
    await transport(TARGET, "hello");
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1]![1]).toEqual(["-e", buildSendCommand(TARGET, "hello")]);
  });

  it("auto-disables after 3 consecutive failures (4th send skips typing)", async () => {
    let calls = 0;
    const runner = vi.fn(async (_file: string, args: readonly string[]) => {
      calls += 1;
      if (args[1].includes("keystroke")) throw new Error("no accessibility");
      return { stdout: "", stderr: "" };
    });
    const transport = makeTypingAwareTransport({ runner });
    for (let i = 0; i < 4; i += 1) await transport(TARGET, `msg ${i}`);
    // 3 typing attempts + 3 fallbacks + 1 direct-only
    expect(calls).toBe(7);
  });

  it("success resets the consecutive-failure counter", async () => {
    let typingCalls = 0;
    let failNext = true;
    const runner = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[1].includes("keystroke")) {
        typingCalls += 1;
        if (failNext) throw new Error("flaky");
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const transport = makeTypingAwareTransport({ runner });
    await transport(TARGET, "a"); // fails → fallback
    failNext = false;
    await transport(TARGET, "b"); // typing succeeds → counter resets
    failNext = true;
    await transport(TARGET, "c"); // fails again → fallback (counter was reset)
    await transport(TARGET, "d"); // fails again (2nd consecutive) → still typing-capable
    expect(typingCalls).toBe(4);
  });

  it("invalid target throws without spawning anything", async () => {
    const runner = vi.fn();
    const transport = makeTypingAwareTransport({ runner });
    await expect(transport("garbage", "x")).rejects.toThrow(/invalid target/);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("config kill switch (EDGE_TYPING_SIMULATION)", () => {
  it("default OFF; only the exact value 1 enables", () => {
    expect(loadConfig({}, []).typingSimulation).toBe(false);
    expect(loadConfig({ EDGE_TYPING_SIMULATION: "0" }, []).typingSimulation).toBe(false);
    expect(loadConfig({ EDGE_TYPING_SIMULATION: "true" }, []).typingSimulation).toBe(false);
    expect(loadConfig({ EDGE_TYPING_SIMULATION: "1" }, []).typingSimulation).toBe(true);
  });
});
