import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { setupAuth } from "../src/auth";
import { sha256Hex, type SqlExecutor } from "@jehad-os/db";

const VALID_CREDENTIAL = randomBytes(32).toString("hex");
const VALID_HASH = sha256Hex(VALID_CREDENTIAL);

function fakeDb(
  principals: Array<{
    id: string;
    type: string;
    name: string;
    credential_hash: string | null;
  }>,
): SqlExecutor {
  return {
    async query(_text: string, values?: readonly unknown[]) {
      const hash = values?.[0];
      const row =
        typeof hash === "string"
          ? principals.find((p) => p.credential_hash === hash)
          : undefined;
      return { rows: row === undefined ? [] : [row] };
    },
  };
}

function buildApp(db: SqlExecutor) {
  const app = Fastify();
  setupAuth(app, { db });
  app.get("/probe", async (request) => ({
    ok: true,
    principal: request.principal ?? null,
  }));
  return app;
}

describe("bearer authentication", () => {
  it("rejects a request without credentials with 401", async () => {
    const app = buildApp(
      fakeDb([
        {
          id: "p1",
          type: "user",
          name: "josctl",
          credential_hash: VALID_HASH,
        },
      ]),
    );
    const res = await app.inject({ method: "GET", url: "/probe" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthenticated" });
    await app.close();
  });

  it("rejects malformed Authorization headers with 401", async () => {
    const app = buildApp(fakeDb([]));
    for (const authorization of [
      "Basic abc",
      "Bearer",
      "Bearer   ",
      "Bearer abc def",
      "",
    ]) {
      const res = await app.inject({
        method: "GET",
        url: "/probe",
        headers: { authorization },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthenticated" });
    }
    await app.close();
  });

  it("rejects an unknown credential with 401", async () => {
    const app = buildApp(fakeDb([]));
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: {
        authorization: `Bearer ${randomBytes(32).toString("hex")}`,
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthenticated" });
    await app.close();
  });

  it("accepts a valid credential and decorates the principal", async () => {
    const app = buildApp(
      fakeDb([
        {
          id: "p1",
          type: "user",
          name: "josctl",
          credential_hash: VALID_HASH,
        },
      ]),
    );
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { authorization: `Bearer ${VALID_CREDENTIAL}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      principal: { id: "p1", type: "user", name: "josctl" },
    });
    await app.close();
  });

  it("accepts a case-insensitive Bearer scheme", async () => {
    const app = buildApp(
      fakeDb([
        {
          id: "p1",
          type: "user",
          name: "josctl",
          credential_hash: VALID_HASH,
        },
      ]),
    );
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { authorization: `bearer ${VALID_CREDENTIAL}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a principal whose credential_hash is null (revoked)", async () => {
    const app = buildApp(
      fakeDb([{ id: "p2", type: "service", name: "revoked", credential_hash: null }]),
    );
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { authorization: `Bearer ${VALID_CREDENTIAL}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthenticated" });
    await app.close();
  });
});
