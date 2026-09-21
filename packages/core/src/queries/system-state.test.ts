import { describe, expect, it } from "vitest";
import { collectSystemState, renderSystemStateText, SYSTEM_STATE_LIMITATIONS, SYSTEM_STATE_LIMITATIONS_VERSION } from "./system-state.js";

function fakeDb(scripts: readonly { readonly sql: string; readonly rows: Record<string, unknown>[] }[]) {
  const issued: Array<{ sql: string; values?: readonly unknown[] }> = [];
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
      issued.push({ sql: text, values });
      return { rows: script.rows };
    },
  };
}

const NOW = new Date("2026-09-21T12:00:00.000Z");
const now = (): Date => NOW;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const PRINCIPAL = "11111111-1111-1111-1111-111111111111";

function worldScripts(
  overrides: Partial<Record<"calendar" | "gmail" | "imessage" | "grants" | "cost" | "gaps", { readonly sql: string; readonly rows: Record<string, unknown>[] }>> = {},
) {
  return [
    overrides.calendar ?? { sql: "calendar_sync_state", rows: [{ last_synced_at: new Date(NOW.getTime() - 7 * HOUR) }] },
    overrides.gmail ?? { sql: "gmail_sync_state", rows: [{ last_synced_at: new Date(NOW.getTime() - 30 * 60_000) }] },
    overrides.imessage ?? { sql: "imessage_sensor_state", rows: [{ last_synced_at: new Date(NOW.getTime() - 2 * HOUR) }] },
    overrides.grants ?? {
      sql: "capability_grants",
      rows: [
        { capability: "calendar:read", n: 2 },
        { capability: "imessage:ingest", n: 1 },
      ],
    },
    overrides.cost ?? {
      sql: "model_calls",
      rows: [
        { model: "openai/gpt-4.1-mini", calls: 3, usd: "0.0600" },
        { model: "openai/gpt-4o-mini", calls: 2, usd: "0.0400" },
      ],
    },
    overrides.gaps ?? {
      sql: "feedback",
      rows: [
        { source_attribution: "source_not_connected", n: 2 },
        { source_attribution: null, n: 1 },
      ],
    },
  ];
}

describe("collectSystemState (unit)", () => {
  it("collects structured runtime truth with principal-scoped SQL params", async () => {
    const db = fakeDb(worldScripts());
    const data = await collectSystemState(db, { principalId: PRINCIPAL, now });
    expect(data.now).toBe(NOW.toISOString());
    expect(data.sources).toEqual([
      {
        source: "calendar",
        connected: true,
        lastSyncAt: new Date(NOW.getTime() - 7 * HOUR).toISOString(),
        stale: true,
        ageText: "7h",
      },
      {
        source: "gmail",
        connected: true,
        lastSyncAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
        stale: false,
        ageText: "0h",
      },
      {
        source: "imessage",
        connected: true,
        lastSyncAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
        stale: false,
        ageText: "2h",
      },
    ]);
    expect(data.capabilities.reads).toBeNull();
    expect(data.capabilities.actions).toBeNull();
    expect(data.capabilities.grants).toEqual({
      count: 3,
      capabilityNames: ["calendar:read", "imessage:ingest"],
    });
    expect(data.cost.monthToDateUsd).toBeCloseTo(0.1, 10);
    expect(data.cost.callsMonthToDate).toBe(5);
    expect(data.cost.byModelTop3).toEqual([
      { model: "openai/gpt-4.1-mini", calls: 3, usd: 0.06 },
      { model: "openai/gpt-4o-mini", calls: 2, usd: 0.04 },
    ]);
    expect(data.coverageGaps).toEqual([
      { source: "source_not_connected", missCount: 2 },
      { source: "other", missCount: 1 },
    ]);
    expect(data.knownLimitations).toEqual([...SYSTEM_STATE_LIMITATIONS]);
    expect(db.issued).toHaveLength(6);
    expect(db.issued[3]!.values).toEqual([PRINCIPAL, NOW.toISOString()]);
    expect(db.issued[4]!.values).toEqual([PRINCIPAL, "2026-09-01T00:00:00.000Z"]);
    expect(db.issued[5]!.values).toEqual([
      PRINCIPAL,
      new Date(NOW.getTime() - 30 * DAY).toISOString(),
      NOW.toISOString(),
    ]);
  });

  it("is read-only: every issued statement is a SELECT", async () => {
    const db = fakeDb(worldScripts());
    await collectSystemState(db, { principalId: PRINCIPAL, now });
    expect(db.issued).toHaveLength(6);
    for (const { sql } of db.issued) {
      expect(sql.trimStart().toUpperCase().startsWith("SELECT")).toBe(true);
    }
  });

  it("rejects a non-uuid principalId before touching the database", async () => {
    const db = fakeDb([]);
    await expect(collectSystemState(db, { principalId: "not-a-uuid", now })).rejects.toThrow(
      /principalId must be a uuid/,
    );
    expect(db.issued).toHaveLength(0);
  });

  it("never surfaces resource, token_hash, note, or credential material from rows", async () => {
    const db = fakeDb(
      worldScripts({
        gmail: {
          sql: "gmail_sync_state",
          rows: [
            {
              last_synced_at: new Date(NOW.getTime() - 30 * 60_000),
              health: JSON.stringify({ credential: "SECRETCRED" }),
            },
          ],
        },
        grants: {
          sql: "capability_grants",
          rows: [
            {
              capability: "imessage:ingest",
              n: 1,
              resource: "sk-live-TOKENRESOURCE",
              token_hash: "sha256:SECRETHASH123",
            },
          ],
        },
        gaps: {
          sql: "feedback",
          rows: [
            {
              source_attribution: "source_not_connected",
              n: 1,
              note: "Bearer SECRETTOKEN",
              item_id: "whole_day:2026-09-20",
            },
          ],
        },
      }),
    );
    const data = await collectSystemState(db, { principalId: PRINCIPAL, now });
    const serialized = JSON.stringify(data);
    const text = renderSystemStateText(data);
    for (const secret of [
      "sk-live-TOKENRESOURCE",
      "SECRETHASH123",
      "SECRETCRED",
      "SECRETTOKEN",
      "whole_day:2026-09-20",
    ]) {
      expect(serialized).not.toContain(secret);
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("imessage:ingest");
  });

  it("version metadata: env-provided sha + deploy date, invalid dates fall to null", async () => {
    const good = fakeDb(worldScripts());
    const data = await collectSystemState(good, {
      principalId: PRINCIPAL,
      now,
      env: { JEHAD_GIT_SHA: "  abc123def  ", JEHAD_DEPLOYED_AT: "2026-09-21T08:00:00Z" },
    });
    expect(data.version.gitSha).toBe("abc123def");
    expect(data.version.deployedAt).toBe("2026-09-21T08:00:00.000Z");
    expect(data.version.node).toMatch(/^v\d+\./);

    const bad = fakeDb(worldScripts());
    const badData = await collectSystemState(bad, {
      principalId: PRINCIPAL,
      now,
      env: { JEHAD_GIT_SHA: "", JEHAD_DEPLOYED_AT: "not-a-date" },
    });
    expect(badData.version.gitSha).toBeNull();
    expect(badData.version.deployedAt).toBeNull();
  });
});

describe("renderSystemStateText (unit)", () => {
  it("full golden: every section, deterministic labeled lines", async () => {
    const db = fakeDb(worldScripts());
    const data = await collectSystemState(db, {
      principalId: PRINCIPAL,
      now,
      policyReads: ["calendar", "commitments", "gmail"],
      actionsEnabled: true,
      env: { JEHAD_GIT_SHA: "abc123def", JEHAD_DEPLOYED_AT: "2026-09-21T08:00:00Z" },
    });
    expect(renderSystemStateText(data)).toBe(
      [
        "System state",
        "",
        "SOURCES",
        "- calendar: synced 7h ago (stale)",
        "- gmail: synced under 1h ago",
        "- imessage: synced 2h ago",
        "",
        "CAPABILITIES",
        "- reads: calendar, commitments, gmail",
        "- grants: 3 active — calendar:read, imessage:ingest",
        "- actions: enabled",
        "",
        "VERSION",
        "- git: abc123def",
        `- node: ${process.version}`,
        "- deployed: 2026-09-21T08:00:00.000Z",
        "",
        "COST THIS MONTH",
        "- total: $0.10 across 5 calls (scoped to this principal's runs)",
        "- openai/gpt-4.1-mini: 3 calls, $0.06",
        "- openai/gpt-4o-mini: 2 calls, $0.04",
        "",
        "COVERAGE GAPS",
        "- 3 calibration misses in the last 30 days:",
        "- source_not_connected ×2",
        "- other ×1",
        "",
        "LIMITS",
        ...SYSTEM_STATE_LIMITATIONS.map((l) => `- ${l}`),
        "",
      ].join("\n"),
    );
  });

  it("quiet world: COST THIS MONTH and COVERAGE GAPS are omitted; unknowns render honestly", async () => {
    const db = fakeDb(
      worldScripts({
        calendar: { sql: "calendar_sync_state", rows: [] },
        gmail: { sql: "gmail_sync_state", rows: [] },
        imessage: { sql: "imessage_sensor_state", rows: [] },
        grants: { sql: "capability_grants", rows: [] },
        cost: { sql: "model_calls", rows: [] },
        gaps: { sql: "feedback", rows: [] },
      }),
    );
    const data = await collectSystemState(db, { principalId: PRINCIPAL, now });
    const text = renderSystemStateText(data);
    expect(text).toBe(
      [
        "System state",
        "",
        "SOURCES",
        "- calendar: not connected",
        "- gmail: not connected",
        "- imessage: not connected",
        "",
        "CAPABILITIES",
        "- reads: unknown (policy not loaded in this view)",
        "- grants: 0 active",
        "- actions: unknown",
        "",
        "VERSION",
        "- git: unknown",
        `- node: ${process.version}`,
        "- deployed: unknown",
        "",
        "LIMITS",
        ...SYSTEM_STATE_LIMITATIONS.map((l) => `- ${l}`),
        "",
      ].join("\n"),
    );
  });

  it("actions disabled renders disabled; a single miss renders singular", async () => {
    const db = fakeDb(
      worldScripts({
        cost: { sql: "model_calls", rows: [{ model: "openai/gpt-4.1-mini", calls: 1, usd: "0.0100" }] },
        gaps: { sql: "feedback", rows: [{ source_attribution: "unknown", n: 1 }] },
      }),
    );
    const data = await collectSystemState(db, {
      principalId: PRINCIPAL,
      now,
      actionsEnabled: false,
    });
    const text = renderSystemStateText(data);
    expect(text).toContain("- actions: disabled");
    expect(text).toContain("- total: $0.01 across 1 call (scoped to this principal's runs)");
    expect(text).toContain("- openai/gpt-4.1-mini: 1 call, $0.01");
    expect(text).toContain("- 1 calibration miss in the last 30 days:");
    expect(text).toContain("- unknown ×1");
  });
});

describe("system-state constants", () => {
  it("limitations are versioned and pin the five honest topics", () => {
    expect(SYSTEM_STATE_LIMITATIONS_VERSION).toBe(1);
    expect(SYSTEM_STATE_LIMITATIONS).toHaveLength(5);
    const joined = SYSTEM_STATE_LIMITATIONS.join(" | ");
    expect(joined).toMatch(/attachment/);
    expect(joined).toMatch(/work/);
    expect(joined).toMatch(/plan/);
    expect(joined).toMatch(/iMessage/);
    expect(joined).toMatch(/voice/);
  });
});
