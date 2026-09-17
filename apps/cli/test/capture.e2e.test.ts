// josctl capture end-to-end against a booted app: real API server on an
// ephemeral port, real isolated Postgres database, fake Keychain reader (no
// secrets in CI). Proves plan §13's first hop with the real fetch client:
// `josctl capture "<text>"` → authenticated POST /events → events row.
// Skipped unless TEST_DATABASE_URL is set.

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import {
  migrateUp,
  seedDomains,
  sha256Hex,
  upsertPrincipalCredential,
} from "@jehad/db";
import { UUID_RE } from "@jehad/core";
import { buildApp } from "@jehad/api";
import { runCli } from "../src/commands";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../packages/db/tests/test-db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CREDENTIAL = randomBytes(32).toString("hex");

describe.skipIf(!TEST_DATABASE_URL)("josctl capture (end-to-end)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "jocapture");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    await upsertPrincipalCredential(db.pool, {
      type: "user",
      name: "josctl",
      credentialHash: sha256Hex(CREDENTIAL),
    });
    app = await buildApp({ db: db.pool });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function capture(text: string): Promise<{ code: number; id?: string }> {
    const chunks: string[] = [];
    const { Writable } = await import("node:stream");
    const output = new Writable({
      write(chunk, _enc, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const code = await runCli(["node", "josctl", "capture", text], {
      fetchImpl: fetch,
      readCredential: async () => CREDENTIAL,
      baseUrl,
      output,
    });
    const line = chunks.join("").trim();
    return { code, id: line.length > 0 ? (JSON.parse(line).id as string) : undefined };
  }

  it("ingests a capture through the real HTTP path and it is readable back", async () => {
    const before = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM events");
    const { code, id } = await capture("I'll send Jehad the migration plan Friday");
    expect(code).toBe(0);
    expect(id).toMatch(UUID_RE);

    const after = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM events");
    expect(after.rows[0]?.n).toBe((before.rows[0]?.n ?? 0) + 1);

    const res = await app.inject({
      method: "GET",
      url: `/events/${id}`,
      headers: { authorization: `Bearer ${CREDENTIAL}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toEqual({
      id,
      type: "capture.recorded",
      schemaVersion: 1,
      source: "cli.capture",
      occurredAt: expect.any(String),
      recordedAt: expect.any(String),
      domainId: "personal",
      idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      sensitivity: "normal",
      payload: { text: "I'll send Jehad the migration plan Friday" },
      runId: null,
    });
  });

  it("creates TWO distinct events when the same words are captured twice", async () => {
    const text = "literally the same sentence";
    const first = await capture(text);
    const second = await capture(text);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(first.id).not.toBe(second.id);

    const rows = await db.pool.query(
      "SELECT count(*)::int AS n FROM events WHERE payload->>'text' = $1",
      [text],
    );
    expect(rows.rows[0]?.n).toBe(2);
  });

  it("fails with exit 1 when the credential is rejected", async () => {
    const code = await runCli(["node", "josctl", "capture", "nope"], {
      fetchImpl: fetch,
      readCredential: async () => "wrong-credential",
      baseUrl,
    });
    expect(code).toBe(1);
  });
});
