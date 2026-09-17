// josctl feedback unit tests — hermetic: fake db factory, no Postgres, no
// Keychain, no network. Arg parsing (target vocabulary, verdict vocabulary,
// --note), record output (JSON line, deduped re-tap), --recent listing, and
// error paths (usage without touching the DB; failure still closes the pool).

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  FEEDBACK_USAGE,
  parseFeedbackArgs,
  runFeedbackCommand,
  type FeedbackDbFactory,
} from "../src/commands/feedback";

function captureStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

interface Recording {
  queries: { text: string; values?: readonly unknown[] }[];
  endCalls: number;
  url: string;
}

function fakeFactory(opts: {
  existing?: Record<string, unknown>[];
  listRows?: Record<string, unknown>[];
  fail?: Error;
}): { factory: FeedbackDbFactory; recording: Recording } {
  const recording: Recording = { queries: [], endCalls: 0, url: "" };
  const factory: FeedbackDbFactory = (url) => {
    recording.url = url;
    return {
      query: async (text: string, values?: readonly unknown[]) => {
        if (opts.fail) throw opts.fail;
        recording.queries.push({ text, values });
        if (/^INSERT INTO feedback/.test(text)) {
          return {
            rows: [
              {
                id: "f-1",
                item_type: "notification",
                item_id: "n1",
                verdict: "useful",
                note: null,
                created_by: "josctl-manual",
                created_at: "2026-09-17T12:00:00.000Z",
              },
            ],
          };
        }
        if (text.includes("FROM feedback") && text.includes("item_type = $1")) {
          return { rows: opts.existing ?? [] };
        }
        if (text.includes("FROM feedback")) {
          return {
            rows: opts.listRows ?? [
              {
                id: "f-2",
                item_type: "notification",
                item_id: "n1",
                verdict: "noise",
                note: "too chatty",
                created_by: "josctl-manual",
                created_at: "2026-09-17T11:00:00.000Z",
              },
              {
                id: "f-1",
                item_type: "event",
                item_id: "e1",
                verdict: "interruptive",
                note: null,
                created_by: "josctl-manual",
                created_at: "2026-09-17T10:00:00.000Z",
              },
            ],
          };
        }
        return { rows: [] };
      },
      end: async () => {
        recording.endCalls += 1;
      },
    };
  };
  return { factory, recording };
}

describe("parseFeedbackArgs", () => {
  it("parses a record tap with the full vocabulary and --note", () => {
    expect(parseFeedbackArgs(["node", "josctl", "feedback", "notification/n1", "useful"])).toEqual({
      recent: false,
      itemType: "notification",
      itemId: "n1",
      verdict: "useful",
    });
    expect(
      parseFeedbackArgs(["node", "josctl", "feedback", "event/e1", "interruptive", "--note", "why now"]),
    ).toEqual({ recent: false, itemType: "event", itemId: "e1", verdict: "interruptive", note: "why now" });
    for (const itemType of ["attention_item", "review_item", "brief_section"]) {
      expect(parseFeedbackArgs(["node", "josctl", "feedback", `${itemType}/x`, "missed"])).toMatchObject({
        itemType,
      });
    }
    for (const verdict of ["noise", "missed", "incorrect"]) {
      expect(parseFeedbackArgs(["node", "josctl", "feedback", `event/x`, verdict])).toMatchObject({ verdict });
    }
  });

  it("parses --recent", () => {
    expect(parseFeedbackArgs(["node", "josctl", "feedback", "--recent"])).toEqual({ recent: true });
  });

  it("rejects wrong command, malformed targets, bad vocabulary, broken --note", () => {
    expect(parseFeedbackArgs(["node", "josctl", "capture", "x"])).toBeNull();
    expect(parseFeedbackArgs(["node", "josctl", "feedback", "n1", "useful"])).toBeNull(); // no slash
    expect(parseFeedbackArgs(["node", "josctl", "feedback", "notification/", "useful"])).toBeNull();
    expect(parseFeedbackArgs(["node", "josctl", "feedback", "/n1", "useful"])).toBeNull();
    expect(parseFeedbackArgs(["node", "josctl", "feedback", "calendar/n1", "useful"])).toBeNull(); // lane vocab
    expect(parseFeedbackArgs(["node", "josctl", "feedback", "notification/n1", "meh"])).toBeNull();
    expect(parseFeedbackArgs(["node", "josctl", "feedback", "notification/n1", "useful", "--note"])).toBeNull();
    expect(parseFeedbackArgs(["node", "josctl", "feedback", "notification/n1", "useful", "--why", "x"])).toBeNull();
    expect(parseFeedbackArgs(["node", "josctl", "feedback", "--recent", "extra"])).toBeNull();
  });
});

describe("runFeedbackCommand", () => {
  it("records via the service (INSERT only) and prints a JSON line (exit 0)", async () => {
    const { factory, recording } = fakeFactory({});
    const out = captureStream();
    const errOut = captureStream();
    const code = await runFeedbackCommand(
      ["node", "josctl", "feedback", "notification/n1", "useful", "--note", "good catch"],
      {
        databaseUrl: "postgres://localhost:5432/jehad_test",
        output: out.stream,
        errOutput: errOut.stream,
        connect: factory,
        now: () => new Date("2026-09-17T12:00:00.000Z"),
      },
    );
    expect(code).toBe(0);
    expect(recording.url).toBe("postgres://localhost:5432/jehad_test");
    expect(recording.endCalls).toBe(1);
    expect(errOut.text()).toBe("");
    // append-only: every write is an INSERT; the only other read is the dedupe SELECT
    expect(recording.queries.filter((q) => !/^SELECT/.test(q.text))).toHaveLength(1);
    expect(recording.queries.find((q) => !/^SELECT/.test(q.text))!.text).toMatch(/^INSERT INTO feedback/);
    expect(out.text()).toBe(
      `{"id":"f-1","itemType":"notification","itemId":"n1","verdict":"useful","deduped":false}\n`,
    );
  });

  it("a deduped re-tap reports deduped:true and issues no insert", async () => {
    const { factory, recording } = fakeFactory({
      existing: [
        {
          id: "f-0",
          item_type: "notification",
          item_id: "n1",
          verdict: "useful",
          note: null,
          created_by: "josctl-manual",
          created_at: "2026-09-17T11:30:00.000Z",
        },
      ],
    });
    const out = captureStream();
    const code = await runFeedbackCommand(["node", "josctl", "feedback", "notification/n1", "useful"], {
      databaseUrl: "postgres://localhost:5432/jehad",
      output: out.stream,
      errOutput: captureStream().stream,
      connect: factory,
      now: () => new Date("2026-09-17T12:00:00.000Z"),
    });
    expect(code).toBe(0);
    expect(recording.queries.every((q) => /^SELECT/.test(q.text))).toBe(true); // no insert
    expect(out.text()).toContain('"deduped":true');
    expect(out.text()).toContain('"id":"f-0"'); // the original row
  });

  it("--recent lists the last 20 verdicts newest first", async () => {
    const { factory } = fakeFactory({});
    const out = captureStream();
    const code = await runFeedbackCommand(["node", "josctl", "feedback", "--recent"], {
      databaseUrl: "postgres://localhost:5432/jehad",
      output: out.stream,
      errOutput: captureStream().stream,
      connect: factory,
    });
    expect(code).toBe(0);
    expect(out.text()).toBe(
      "2026-09-17T11:00:00.000Z  notification/n1  noise  # too chatty\n" +
        "2026-09-17T10:00:00.000Z  event/e1  interruptive\n",
    );
  });

  it("--recent on an empty log prints a placeholder", async () => {
    const { factory } = fakeFactory({ listRows: [] });
    const out = captureStream();
    const code = await runFeedbackCommand(["node", "josctl", "feedback", "--recent"], {
      databaseUrl: "postgres://localhost:5432/jehad",
      output: out.stream,
      errOutput: captureStream().stream,
      connect: factory,
    });
    expect(code).toBe(0);
    expect(out.text()).toBe("no feedback recorded yet\n");
  });

  it("exits 2 with usage on bad args, without touching the DB", async () => {
    const { factory, recording } = fakeFactory({});
    const out = captureStream();
    const errOut = captureStream();
    const code = await runFeedbackCommand(["node", "josctl", "feedback", "notification/n1", "meh"], {
      databaseUrl: "postgres://localhost:5432/jehad",
      output: out.stream,
      errOutput: errOut.stream,
      connect: factory,
    });
    expect(code).toBe(2);
    expect(errOut.text()).toBe(FEEDBACK_USAGE);
    expect(out.text()).toBe("");
    expect(recording.queries).toHaveLength(0);
  });

  it("exits 1 and still closes the pool when the DB is unreachable", async () => {
    const { factory, recording } = fakeFactory({ fail: new Error("ECONNREFUSED") });
    const errOut = captureStream();
    const code = await runFeedbackCommand(["node", "josctl", "feedback", "notification/n1", "useful"], {
      databaseUrl: "postgres://localhost:5432/jehad",
      output: captureStream().stream,
      errOutput: errOut.stream,
      connect: factory,
    });
    expect(code).toBe(1);
    expect(errOut.text()).toContain("feedback failed");
    expect(errOut.text()).toContain("ECONNREFUSED");
    expect(recording.endCalls).toBe(1);
  });
});
