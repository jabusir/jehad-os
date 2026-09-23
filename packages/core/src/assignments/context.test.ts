// Context-package builder tests (D1): allowlist denial, truncation that
// preserves the caveat + labels, and the bounded-package guarantee.
// Needs PostgreSQL 16 (reads run real queries).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  CONTEXT_CAVEAT,
  buildContextPackage,
  CONTEXT_PACKAGE_MAX_CHARS,
} from "./context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("context package builder (D1)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "d1context");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("unknown reads deny the whole build (fail closed, before any query)", async () => {
    await expect(
      buildContextPackage(db.pool, { task: "t", reads: ["email.bodies" as never] }),
    ).rejects.toThrow(/not on the known-reads allowlist/);
  });

  it("builds a caveated package with labeled blocks; gmail stays metadata-only", async () => {
    const pkg = await buildContextPackage(db.pool, {
      task: "Summarize pending billing threads",
      reads: ["gmail.metadata.recent", "commitments.waiting"],
    });
    expect(pkg.startsWith(CONTEXT_CAVEAT)).toBe(true);
    expect(pkg).toContain("TASK: Summarize pending billing threads");
    expect(pkg).toContain("[Gmail (last 8 received");
    expect(pkg).toContain("[Commitments (open)]");
    // calendar planned-only framing rides its label
    expect(pkg).not.toContain("[Calendar");
    expect(pkg).toContain("COVERAGE NOTE");
  });

  it("budget overrun drops WHOLE blocks and says so — caveat and labels survive", async () => {
    const pkg = await buildContextPackage(db.pool, {
      task: "Tight budget task",
      reads: ["gmail.metadata.recent", "calendar.today", "commitments.waiting"],
      maxChars: 620,
    });
    expect(pkg.length).toBeLessThanOrEqual(620);
    expect(pkg.startsWith(CONTEXT_CAVEAT)).toBe(true);
    expect(pkg).toContain("Dropped for budget:");
    // surviving blocks keep their labels
    expect(pkg).toMatch(/\[[^\]]+\]/);
  });

  it("default budget constant stays under the assignment input ceiling", () => {
    expect(CONTEXT_PACKAGE_MAX_CHARS).toBeLessThan(16_000);
  });
});
