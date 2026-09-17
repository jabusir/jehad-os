// josctl commands — hermetic suite: fake fetch + fake credential reader; no
// Keychain, no network, no database.

import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UUID_RE } from "@jehad/core";
import { runCli, USAGE } from "../src/commands";

interface CapturedRequest {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

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

function fakeFetch(status: number, responseBody: unknown, capture: CapturedRequest[]) {
  return async (url: string, init: CapturedRequest["init"]): Promise<{
    status: number;
    json: () => Promise<unknown>;
  }> => {
    capture.push({ url, init });
    return { status, json: async () => responseBody };
  };
}

function deps(overrides: Partial<Parameters<typeof runCli>[1]> = {}) {
  const requests: CapturedRequest[] = [];
  const out = captureStream();
  const errOut = captureStream();
  const fetchImpl = fakeFetch(
    201,
    { duplicate: false, event: { id: randomUUID(), type: "capture.recorded" } },
    requests,
  );
  return {
    requests,
    out,
    errOut,
    cliDeps: {
      fetchImpl,
      readCredential: async () => "test-credential",
      baseUrl: "http://127.0.0.1:3000",
      output: out.stream,
      errOutput: errOut.stream,
      ...overrides,
    },
  };
}

const argv = (kind: string, text: string): string[] => [
  "node",
  "josctl",
  kind,
  text,
];

describe("josctl capture/decide", () => {
  it("POSTs a normalized capture.recorded occurrence with schemaVersion 1 and bearer auth", async () => {
    const d = deps();
    const code = await runCli(argv("capture", "I'll send Jehad the plan Friday"), d.cliDeps);
    expect(code).toBe(0);

    expect(d.requests).toHaveLength(1);
    const request = d.requests[0]!;
    expect(request.url).toBe("http://127.0.0.1:3000/events");
    expect(request.init.method).toBe("POST");
    expect(request.init.headers.authorization).toBe("Bearer test-credential");
    expect(request.init.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(request.init.body);
    expect(body).toEqual({
      type: "capture.recorded",
      source: "cli.capture",
      externalId: expect.stringMatching(UUID_RE),
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      domainId: "personal",
      sensitivity: "normal",
      payload: { text: "I'll send Jehad the plan Friday" },
      schemaVersion: 1,
    });

    const emitted = JSON.parse(d.out.text());
    expect(emitted).toEqual({
      id: expect.stringMatching(UUID_RE),
      type: "capture.recorded",
      duplicate: false,
    });
  });

  it("decide posts a decision.recorded occurrence", async () => {
    const d = deps();
    const code = await runCli(argv("decide", "Postgres over SQLite"), d.cliDeps);
    expect(code).toBe(0);
    expect(JSON.parse(d.requests[0]!.init.body).type).toBe("decision.recorded");
  });

  it("mints a fresh externalId per invocation — same words are two occurrences", async () => {
    const d = deps();
    await runCli(argv("capture", "same words"), d.cliDeps);
    await runCli(argv("capture", "same words"), d.cliDeps);
    const first = JSON.parse(d.requests[0]!.init.body);
    const second = JSON.parse(d.requests[1]!.init.body);
    expect(first.externalId).not.toBe(second.externalId);
  });

  it("reports a duplicate delivery (200) as success with duplicate: true", async () => {
    const d = deps();
    d.cliDeps.fetchImpl = fakeFetch(
      200,
      { duplicate: true, event: { id: randomUUID(), type: "capture.recorded" } },
      d.requests,
    );
    const code = await runCli(argv("capture", "retried adapter delivery"), {
      ...d.cliDeps,
    });
    expect(code).toBe(0);
    expect(JSON.parse(d.out.text()).duplicate).toBe(true);
  });

  it("exits 1 on 401 without leaking the credential", async () => {
    const d = deps();
    d.cliDeps.fetchImpl = fakeFetch(401, { error: "unauthenticated" }, d.requests);
    const code = await runCli(argv("capture", "x"), { ...d.cliDeps });
    expect(code).toBe(1);
    expect(d.errOut.text()).toContain("unauthorized");
  });

  it("exits 1 with the validation code on a 400", async () => {
    const d = deps();
    d.cliDeps.fetchImpl = fakeFetch(
      400,
      { error: "invalid_event", code: "DOMAIN_NOT_FOUND", message: "domain \"x\" does not exist" },
      d.requests,
    );
    const code = await runCli(argv("capture", "x"), { ...d.cliDeps });
    expect(code).toBe(1);
    expect(d.errOut.text()).toContain("DOMAIN_NOT_FOUND");
  });

  it("exits 1 when the API is unreachable (no fetch success)", async () => {
    const d = deps();
    d.cliDeps.fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as Parameters<typeof runCli>[1]["fetchImpl"];
    const code = await runCli(argv("capture", "x"), { ...d.cliDeps });
    expect(code).toBe(1);
    expect(d.errOut.text()).toContain("could not reach the API");
  });

  it("exits 1 when the Keychain credential cannot be read, without calling the API", async () => {
    const d = deps();
    d.cliDeps.readCredential = async () => {
      throw new Error("could not be found");
    };
    const code = await runCli(argv("capture", "x"), { ...d.cliDeps });
    expect(code).toBe(1);
    expect(d.errOut.text()).toContain("Keychain");
    expect(d.requests).toHaveLength(0);
  });

  it("exits 2 with usage for unknown commands and empty text", async () => {
    const d = deps();
    expect(await runCli(["node", "josctl", "metrics"], d.cliDeps)).toBe(2);
    expect(await runCli(["node", "josctl"], d.cliDeps)).toBe(2);
    expect(await runCli(argv("capture", "   "), d.cliDeps)).toBe(2);
    expect(d.errOut.text()).toBe(USAGE.repeat(3));
    expect(d.requests).toHaveLength(0);
  });
});
