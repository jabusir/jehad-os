// mission-execution v1 — `josctl delegate --research` mode wiring (integration,
// isolated db, skipped unless TEST_DATABASE_URL is set). Same lightweight
// pattern as brief.test.ts: run the real command against an isolated seeded
// database via DATABASE_URL, then assert the canonical Outcome rows. The
// plan is minted at the shared seam BEFORE dispatch, so the assertion below
// holds even in environments where the Inngest dev server is not reachable.

import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../packages/db/tests/test-db";
import { runDelegateCommand } from "../src/commands/ops.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("josctl delegate --research (integration)", () => {
  let db: IsolatedDb;
  let previousDatabaseUrl: string | undefined;
  const isolatedUrl = (): string => {
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${db.dbName}`;
    return url.toString();
  };

  /** Run the real command; returns exit code, tolerating an unreachable dispatch transport. */
  async function delegate(argv: readonly string[]): Promise<{ code: number | null; output: string }> {
    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk, _enc, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    let code: number | null = null;
    try {
      code = await runDelegateCommand(["node", "josctl", ...argv], { stdout });
    } catch {
      // Dispatch transport (Inngest dev server) unavailable in this
      // environment; the canonical rows below were committed before dispatch.
    }
    return { code, output: chunks.join("") };
  }

  const planFor = async (directive: string): Promise<unknown> => {
    const rows = await db.pool.query(
      "SELECT plan FROM outcomes WHERE directive = $1",
      [directive],
    );
    expect(rows.rows).toHaveLength(1);
    return (rows.rows[0] as { plan: unknown }).plan;
  };

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "delegres2");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    await upsertPrincipalCredential(db.pool, {
      type: "user", name: "josctl", credentialHash: sha256Hex(randomBytes(32).toString("hex")),
    });
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = isolatedUrl();
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("--research mints the research plan on the canonical outcome", async () => {
    const { code, output } = await delegate(["delegate", "--research", "Find X"]);
    if (code !== null) expect(code).toBe(0);
    expect(output).toContain("research is running");
    expect(await planFor("Find X")).toEqual([{ assign: { role: "research", task: "Find X" } }]);
  });

  it("without the flag the legacy mission has an empty plan (parks with the owner)", async () => {
    const { code, output } = await delegate(["delegate", "Find Y"]);
    if (code !== null) expect(code).toBe(0);
    expect(output).toContain("no autonomous type selected");
    expect(await planFor("Find Y")).toEqual([]);
  });
});
