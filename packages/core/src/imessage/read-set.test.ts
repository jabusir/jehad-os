import { describe, expect, it } from "vitest";
import {
  dayStateRoutingLine,
  executeReadTool,
  isRouteNoneJson,
  multiReadRoutingLine,
  parseRouteJson,
  parseRouteReadSet,
  READ_BLOCK_CHAR_BUDGET,
  READ_SET_TOOLS,
  readToolSource,
  runReadSet,
} from "./read-tools.js";

function fakeDb(scripts: readonly { readonly sql: string; readonly rows: Record<string, unknown>[] }[]) {
  const issued: Array<{ sql: string; values: readonly unknown[] }> = [];
  let call = 0;
  return {
    issued,
    query: async (text: string, values?: readonly unknown[]) => {
      const script = scripts[call];
      call += 1;
      if (script === undefined) throw new Error(`unexpected query #${call - 1}: ${text}`);
      if (!text.includes(script.sql)) {
        throw new Error(`query #${call - 1} does not match script '${script.sql}'`);
      }
      issued.push({ sql: text, values: values ?? [] });
      return { rows: script.rows };
    },
  };
}

describe("parseRouteReadSet (strict)", () => {
  it("normalizes the legacy single-tool shapes into one-element read sets", () => {
    expect(parseRouteReadSet('{"tool":"calendar.day","day":"today"}')).toEqual([
      { tool: "calendar.day", day: "today" },
    ]);
    expect(parseRouteReadSet('{"tool":"calendar.day","day":"tomorrow"}')).toEqual([
      { tool: "calendar.day", day: "tomorrow" },
    ]);
    expect(parseRouteReadSet('{"tool":"calendar.next"}')).toEqual([{ tool: "calendar.next" }]);
    expect(parseRouteReadSet('{"tool":"commitments.waiting"}')).toEqual([
      { tool: "commitments.waiting" },
    ]);
    expect(parseRouteReadSet('{"tool":"gmail.recent"}')).toEqual([{ tool: "gmail.recent" }]);
    expect(parseRouteReadSet('{"tool":"day.state"}')).toEqual([{ tool: "day.state" }]);
  });

  it("accepts bounded tools arrays (1–3 allowlisted names, order preserved)", () => {
    expect(parseRouteReadSet('{"tools":["day.state"]}')).toEqual([{ tool: "day.state" }]);
    expect(
      parseRouteReadSet('{"tools":["day.state","commitments.waiting"]}'),
    ).toEqual([{ tool: "day.state" }, { tool: "commitments.waiting" }]);
    expect(
      parseRouteReadSet('  {"tools":["gmail.recent","day.state","calendar.next"]}  '),
    ).toEqual([
      { tool: "gmail.recent" },
      { tool: "day.state" },
      { tool: "calendar.next" },
    ]);
  });

  it("rejects empty arrays, >3, duplicates, unknown names, and non-string entries", () => {
    const bad = [
      '{"tools":[]}',
      '{"tools":["calendar.next","commitments.waiting","gmail.recent","day.state","memory.recall"]}',
      '{"tools":["calendar.next","calendar.next"]}',
      '{"tools":["calendar.day"]}',
      '{"tools":["none"]}',
      '{"tools":["calendar.write"]}',
      '{"tools":["memory.recallx"]}',
      '{"tools":["system.statex"]}',
      '{"tools":["CALENDAR.NEXT"]}',
      '{"tools":"calendar.next"}',
      '{"tools":[1,2]}',
      '{"tools":[null]}',
      '{"tools":[["calendar.next"]]}',
    ];
    for (const text of bad) expect(parseRouteReadSet(text)).toBeNull();
  });

  it("rejects shape mixing — reads and action proposals stay mutually exclusive", () => {
    const bad = [
      '{"tools":["calendar.next"],"tool":"none"}',
      '{"tools":["calendar.next"],"reply_kind":"action"}',
      '{"tool":"calendar.next","reply_kind":"action"}',
      '{"tool":"none","tools":["calendar.next"]}',
      '{"reply_kind":"action","action":"calendar.create","title":"X","day":"today","time":"7pm","end_time":null,"duration_minutes":null,"location":null,"description":null,"attendees":null}',
      '{"reply_kind":"action","tools":["calendar.next"]}',
    ];
    for (const text of bad) expect(parseRouteReadSet(text)).toBeNull();
  });

  it("rejects prose, fences, arrays, and malformed JSON — fail safe to null", () => {
    const bad = [
      "sure, happy to help",
      '```json\n{"tools":["calendar.next"]}\n```',
      '[{"tools":["calendar.next"]}]',
      '{"tools":["calendar.next"}',
      '{"TOOLS":["calendar.next"]}',
      "",
      '{"tool":"none"}',
    ];
    for (const text of bad) expect(parseRouteReadSet(text)).toBeNull();
  });

  it("back-compat pins: single-shape parse semantics unchanged, none stays isRouteNoneJson's", () => {
    expect(parseRouteJson('{"tools":["calendar.next"]}')).toBeNull();
    expect(parseRouteJson('{"tool":"day.state"}')).toEqual({ tool: "day.state" });
    expect(isRouteNoneJson('{"tool":"none"}')).toBe(true);
    expect(isRouteNoneJson('{"tools":["calendar.next"]}')).toBe(false);
    expect(isRouteNoneJson('{"tools":["calendar.next"],"tool":"none"}')).toBe(false);
    expect(readToolSource("day.state")).toBe("state");
    expect([...READ_SET_TOOLS]).toEqual([
      "calendar.next",
      "commitments.waiting",
      "gmail.recent",
      "gmail.search",
      "gmail.read",
      "day.state",
      "memory.recall",
      "system.state",
    ]);
    expect(readToolSource("memory.recall")).toBe("memory");
    expect(readToolSource("system.state")).toBe("system");
  });

  it("exports the orchestrator-spliced routing lines", () => {
    expect(dayStateRoutingLine()).toBe(
      '{"tool":"day.state"} — asks what is going on / for an overview of today and where things stand overall',
    );
    expect(multiReadRoutingLine()).toBe(
      '{"tools":["calendar.next","commitments.waiting","gmail.recent","day.state","memory.recall","system.state"]} — a composite question that clearly needs 2 or 3 of the lookups at once; 1 to 3 names, no repeats, names only (calendar.day keeps its single-tool shape)',
    );
  });
});

describe("runReadSet (no-DB fake executor)", () => {
  const NOW = new Date("2026-09-19T20:00:00Z");

  it("rejects invalid tool sets before any query runs", async () => {
    const db = fakeDb([]);
    await expect(runReadSet(db, "p1", [])).rejects.toThrow(/1 to 3 tools/);
    await expect(
      runReadSet(db, "p1", ["calendar.next", "commitments.waiting", "gmail.recent", "day.state"]),
    ).rejects.toThrow(/1 to 3 tools/);
    await expect(runReadSet(db, "p1", ["calendar.next", "calendar.next"])).rejects.toThrow(
      /more than once/,
    );
    await expect(runReadSet(db, "p1", ["calendar.day"])).rejects.toThrow(/not allowlisted/);
    await expect(runReadSet(db, "p1", ["none"])).rejects.toThrow(/not allowlisted/);
    await expect(runReadSet(db, "p1", ["calendar.write"])).rejects.toThrow(/not allowlisted/);
    expect(db.issued).toHaveLength(0);
  });

  it("rejects non-positive block budgets", async () => {
    const db = fakeDb([]);
    await expect(runReadSet(db, "p1", ["calendar.next"], { blockCharBudget: 0 })).rejects.toThrow(
      /blockCharBudget/,
    );
    await expect(
      runReadSet(db, "p1", ["calendar.next"], { blockCharBudget: Number.NaN }),
    ).rejects.toThrow(/blockCharBudget/);
  });

  it("executes an allowlisted read and returns a provenance-labeled, untruncated block", async () => {
    const db = fakeDb([
      {
        sql: "FROM calendar_events",
        rows: [
          {
            google_event_id: "evt-1",
            summary: "Tomorrow thing",
            start_time: new Date("2026-09-18T09:00:00Z"),
            end_time: new Date("2026-09-18T10:00:00Z"),
            timezone: "UTC",
            location: null,
          },
        ],
      },
    ]);
    const blocks = await runReadSet(db, "p1", ["calendar.next"], { now: () => NOW });
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.tool).toBe("calendar.next");
    expect(block.source).toBe("calendar");
    expect(block.coverage).toContain("calendar events only");
    expect(block.truncated).toBe(false);
    expect(block.charBudget).toBe(READ_BLOCK_CHAR_BUDGET);
    expect(block.data).toMatchObject({ timezone: "America/Los_Angeles" });
  });

  it("enforces the per-block char budget with an honest truncated flag", async () => {
    const db = fakeDb([
      {
        sql: "FROM calendar_events",
        rows: [
          {
            google_event_id: "evt-1",
            summary: "A very long event title that keeps going and going",
            start_time: new Date("2026-09-18T09:00:00Z"),
            end_time: new Date("2026-09-18T10:00:00Z"),
            timezone: "UTC",
            location: "Somewhere with a long location string attached",
          },
        ],
      },
    ]);
    const blocks = await runReadSet(db, "p1", ["calendar.next"], {
      now: () => NOW,
      blockCharBudget: 50,
    });
    const block = blocks[0]!;
    expect(block.truncated).toBe(true);
    expect(block.charBudget).toBe(50);
    expect(typeof block.data).toBe("string");
    expect((block.data as string).length).toBe(50);
    expect((block.data as string).endsWith("…")).toBe(true);
  });
});

describe("day.state execution guard", () => {
  it("fails loud when principalId is missing (escalations are principal-scoped)", async () => {
    const db = {
      query: async (): Promise<never> => {
        throw new Error("day.state must reject before issuing queries");
      },
    };
    await expect(
      executeReadTool(db, { tool: "day.state" }, { now: () => new Date() }),
    ).rejects.toThrow(/principalId/);
  });
});
