import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findPrincipalByCredentialHash,
  isPrincipalType,
  sha256Hex,
  upsertPrincipalCredential,
  type SqlExecutor,
} from "../src/auth-store";

function recordingDb(rows: Record<string, unknown>[]) {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  const db: SqlExecutor & { calls: typeof calls } = {
    calls,
    async query(text: string, values?: readonly unknown[]) {
      calls.push({ text, values });
      return { rows };
    },
  };
  return db;
}

describe("findPrincipalByCredentialHash", () => {
  it("maps the first matching row to a principal record", async () => {
    const db = recordingDb([
      { id: "u1", type: "user", name: "josctl", credential_hash: "h1" },
    ]);
    const record = await findPrincipalByCredentialHash(db, "h1");
    expect(record).toEqual({
      id: "u1",
      type: "user",
      name: "josctl",
      credentialHash: "h1",
    });
    expect(db.calls[0]?.text).toContain("principals");
    expect(db.calls[0]?.text).toContain("$1");
    expect(db.calls[0]?.values).toEqual(["h1"]);
  });

  it("returns null for an unknown hash", async () => {
    const db = recordingDb([]);
    expect(await findPrincipalByCredentialHash(db, "missing")).toBeNull();
    expect(db.calls[0]?.values).toEqual(["missing"]);
  });

  it("returns a null credentialHash when the column is null", async () => {
    const db = recordingDb([
      { id: "u2", type: "service", name: "legacy", credential_hash: null },
    ]);
    const record = await findPrincipalByCredentialHash(db, "x");
    expect(record).toEqual({
      id: "u2",
      type: "service",
      name: "legacy",
      credentialHash: null,
    });
  });
});

describe("upsertPrincipalCredential", () => {
  it("inserts or rotates the credential hash keyed by principal name", async () => {
    const db = recordingDb([
      { id: "u3", type: "harness", name: "openclaw", credential_hash: "h3" },
    ]);
    const principal = await upsertPrincipalCredential(db, {
      type: "harness",
      name: "openclaw",
      credentialHash: "h3",
    });
    expect(principal).toEqual({
      id: "u3",
      type: "harness",
      name: "openclaw",
    });
    expect(db.calls[0]?.text).toContain("ON CONFLICT (name)");
    expect(db.calls[0]?.values).toEqual(["harness", "openclaw", "h3"]);
  });

  it("rejects invalid principal types", async () => {
    const db = recordingDb([]);
    await expect(
      upsertPrincipalCredential(db, {
        type: "root" as never,
        name: "bad",
        credentialHash: "h4",
      }),
    ).rejects.toThrow(TypeError);
    expect(db.calls).toHaveLength(0);
  });
});

describe("isPrincipalType", () => {
  it("accepts exactly the four ADR-0009 principal types", () => {
    for (const t of ["user", "harness", "service", "workflow"]) {
      expect(isPrincipalType(t)).toBe(true);
    }
    for (const t of ["root", "", undefined, null, 1]) {
      expect(isPrincipalType(t)).toBe(false);
    }
  });
});

describe("sha256Hex", () => {
  it("produces the sha256 hex digest", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("bootstrap migration", () => {
  it("creates the principals table and a tested down path", () => {
    const up = readFileSync(
      new URL("../migrations/000_bootstrap_auth.sql", import.meta.url),
      "utf8",
    );
    const down = readFileSync(
      new URL("../migrations/000_bootstrap_auth.down.sql", import.meta.url),
      "utf8",
    );
    expect(up).toContain("CREATE TABLE principals");
    expect(up).toContain("gen_random_uuid()");
    expect(up).toContain(
      "type text NOT NULL CHECK (type IN ('user', 'harness', 'service', 'workflow'))",
    );
    expect(up).toContain("name text NOT NULL UNIQUE");
    expect(up).toContain("credential_hash text");
    expect(up).toContain("created_at timestamptz NOT NULL DEFAULT now()");
    expect(down).toContain("DROP TABLE");
  });
});
