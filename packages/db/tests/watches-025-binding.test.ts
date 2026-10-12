// W0 binding (ADR-0018 §2): the committed 025_watches.sql must be
// byte-identical to the empirically proven draft. A drift here means the
// migration must be re-proven before it ever touches a live database —
// fail loudly, never silently re-prove by editing.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const PROVEN_SHA256 = "de9c179cd742862d544e5026afdfee9728864368e734d94694c1af920ef5eafc";

describe("025_watches proven-bytes binding (ADR-0018 §2)", () => {
  it("committed migration hashes to the W0-proven sha256", () => {
    const sql = readFileSync(new URL("../migrations/025_watches.sql", import.meta.url), "utf8");
    expect(createHash("sha256").update(sql).digest("hex")).toBe(PROVEN_SHA256);
  });

  it("has a down migration (AGENTS.md hard rule)", () => {
    const down = readFileSync(
      new URL("../migrations/025_watches.down.sql", import.meta.url),
      "utf8",
    );
    expect(down).toMatch(/DROP TABLE IF EXISTS watches/);
  });
});
