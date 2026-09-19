// josctl imessage unit tests — hermetic: fake db factory, no Postgres, no
// Keychain, no network. Arg parsing (--principal required, --add-handle
// purpose switch, identities rejects extras), the principal-create path
// (type user, credential NULL — no credential minting), the code printed
// exactly once with the single-use/5-minute warning, identity listing, and
// the error path (usage; DB failure still closes the pool).

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  IMESSAGE_USAGE,
  parseImessageArgs,
  resolvePairingPrincipal,
  runImessageCommand,
  type ImessageDbFactory,
} from "../src/commands/imessage";

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
}

function fakeFactory(opts: {
  principals?: { id: string; name: string }[];
  identities?: Record<string, unknown>[];
  fail?: Error;
}): { factory: ImessageDbFactory; recording: Recording } {
  const recording: Recording = { queries: [], endCalls: 0 };
  const answer = async (text: string, values?: readonly unknown[]) => {
    if (opts.fail) throw opts.fail;
    recording.queries.push({ text, values });
    if (text.includes("INSERT INTO principals")) {
      return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
    }
    if (text.includes("FROM principals")) {
      const name = String(values?.[0] ?? "");
      const hit = (opts.principals ?? []).find((p) => p.name === name);
      return { rows: hit ? [{ id: hit.id }] : [] };
    }
    if (text.includes("INSERT INTO imessage_pairing_sessions")) {
      return { rows: [{ id: "22222222-2222-4222-8222-222222222222", expires_at: new Date("2026-09-19T12:05:00Z") }] };
    }
    if (text.includes("FROM transport_identities")) {
      return { rows: opts.identities ?? [] };
    }
    return { rows: [] };
  };
  const factory: ImessageDbFactory = () => {
    const query = (text: string, values?: readonly unknown[]) => answer(text, values);
    const pool = {
      query,
      connect: async () => ({
        query,
        release: () => {},
      }),
      end: async () => {
        recording.endCalls += 1;
      },
    };
    return pool as unknown as ReturnType<ImessageDbFactory>;
  };
  return { factory, recording };
}

describe("parseImessageArgs", () => {
  it("pair requires --principal; --add-handle switches the purpose", () => {
    expect(parseImessageArgs(["node", "josctl", "imessage", "pair"])).toBeNull();
    expect(parseImessageArgs(["node", "josctl", "imessage"])).toBeNull();
    expect(parseImessageArgs(["node", "josctl", "imessage", "pair", "--principal", "yusra"])).toEqual({
      command: "pair",
      principal: "yusra",
      purpose: "pair",
    });
    expect(
      parseImessageArgs(["node", "josctl", "imessage", "pair", "--principal", "yusra", "--add-handle"]),
    ).toEqual({ command: "pair", principal: "yusra", purpose: "add-handle" });
    expect(parseImessageArgs(["node", "josctl", "imessage", "identities"])).toEqual({
      command: "identities",
    });
    expect(parseImessageArgs(["node", "josctl", "imessage", "identities", "--extra"])).toBeNull();
    expect(parseImessageArgs(["node", "josctl", "imessage", "bogus"])).toBeNull();
  });
});

describe("resolvePairingPrincipal", () => {
  it("reuses an existing principal; creates type user with NO credential otherwise", async () => {
    const existing = fakeFactory({ principals: [{ id: "11111111-1111-4111-8111-111111111111", name: "yusra" }] });
    const found = await resolvePairingPrincipal(fakeQuery(existing), "yusra");
    expect(found).toEqual({ id: "11111111-1111-4111-8111-111111111111", created: false });

    const fresh = fakeFactory({ principals: [] });
    const created = await resolvePairingPrincipal(fakeQuery(fresh), "yusra");
    expect(created).toEqual({ id: "11111111-1111-4111-8111-111111111111", created: true });
    const insert = fresh.recording.queries.find((q) => q.text.includes("INSERT INTO principals"))!;
    expect(insert.text).toContain("'user'");
    expect(insert.text).toContain("NULL"); // credential_hash NULL — nothing minted
  });

  function fakeQuery(h: { factory: ImessageDbFactory }) {
    const db = h.factory("postgres://test");
    return { query: (text: string, values?: readonly unknown[]) => (db as { query: (t: string, v?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }).query(text, values) };
  }
});

describe("runImessageCommand", () => {
  it("pair: creates the principal when missing and prints the code ONCE with warnings", async () => {
    const out = captureStream();
    const errOut = captureStream();
    const { factory, recording } = fakeFactory({ principals: [] });
    const code = await runImessageCommand(
      ["node", "josctl", "imessage", "pair", "--principal", "yusra"],
      { databaseUrl: "postgres://test", output: out.stream, errOutput: errOut.stream, connect: factory },
    );
    expect(code).toBe(0);
    const text = out.text();
    // Principal creation note + a 6-digit code + single-use/5-min warning.
    expect(text).toContain("created principal yusra");
    expect(text).toContain("type user, no credential");
    expect(text).toMatch(/pairing code: \d{6}/);
    expect(text).toContain("SINGLE-USE");
    expect(text).toContain("5 minutes");
    // Only ONE session insert — the code is minted exactly once.
    expect(recording.queries.filter((q) => q.text.includes("INSERT INTO imessage_pairing_sessions"))).toHaveLength(1);
    expect(errOut.text()).toBe("");
  });

  it("pair: existing principal prints only the code block", async () => {
    const out = captureStream();
    const { factory } = fakeFactory({ principals: [{ id: "11111111-1111-4111-8111-111111111111", name: "yusra" }] });
    const code = await runImessageCommand(
      ["node", "josctl", "imessage", "pair", "--principal", "yusra", "--add-handle"],
      { databaseUrl: "postgres://test", output: out.stream, connect: factory },
    );
    expect(code).toBe(0);
    expect(out.text()).not.toContain("created principal");
    expect(out.text()).toMatch(/pairing code: \d{6}/);
  });

  it("identities: lists verified handles or reports none", async () => {
    const out = captureStream();
    const withRows = fakeFactory({
      identities: [
        { principal_name: "yusra", principal_type: "user", handle: "+15550002222", verified_at: "2026-09-19T12:00:00.000Z" },
      ],
    });
    const code = await runImessageCommand(
      ["node", "josctl", "imessage", "identities"],
      { databaseUrl: "postgres://test", output: out.stream, connect: withRows.factory },
    );
    expect(code).toBe(0);
    expect(out.text()).toContain("yusra (user): +15550002222");

    const empty = captureStream();
    const none = fakeFactory({ identities: [] });
    const code2 = await runImessageCommand(
      ["node", "josctl", "imessage", "identities"],
      { databaseUrl: "postgres://test", output: empty.stream, connect: none.factory },
    );
    expect(code2).toBe(0);
    expect(empty.text()).toContain("no verified iMessage identities");
  });

  it("usage errors exit 2 without touching the DB; failures exit 1 but still close the pool", async () => {
    const errOut = captureStream();
    const { factory } = fakeFactory({});
    const usage = await runImessageCommand(
      ["node", "josctl", "imessage", "pair"],
      { databaseUrl: "postgres://test", errOutput: errOut.stream, connect: factory },
    );
    expect(usage).toBe(2);
    expect(errOut.text()).toBe(IMESSAGE_USAGE);

    const failing = fakeFactory({ fail: new Error("connection refused") });
    const failErr = captureStream();
    const fail = await runImessageCommand(
      ["node", "josctl", "imessage", "pair", "--principal", "yusra"],
      { databaseUrl: "postgres://test", errOutput: failErr.stream, connect: failing.factory },
    );
    expect(fail).toBe(1);
    expect(failErr.text()).toContain("connection refused");
    expect(failing.recording.endCalls).toBe(1);
  });
});
