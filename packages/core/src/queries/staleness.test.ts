import { describe, expect, it } from "vitest";
import { freshnessLines, sourceFreshness, STALE_AFTER_HOURS } from "./staleness.js";

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

const NOW = new Date("2026-09-21T12:00:00Z");
const now = (): Date => NOW;
const HOUR = 3_600_000;
const PRINCIPAL = "11111111-1111-1111-1111-111111111111";

describe("sourceFreshness (boundaries)", () => {
  it("5h59m is fresh; exactly 6h is fresh (strict >); 6h01m is stale", async () => {
    const at = (hours: number): Date => new Date(NOW.getTime() - hours * HOUR);
    for (const [hours, stale] of [
      [5, false],
      [5.5, false],
      [5 + 59 / 60, false],
      [6, false],
      [6 + 1 / 60, true],
      [7, true],
    ] as const) {
      const db = fakeDb([
        { sql: "calendar_sync_state", rows: [{ last_synced_at: at(hours) }] },
        { sql: "gmail_sync_state", rows: [] },
      ]);
      const [calendar, gmail] = await sourceFreshness(db, PRINCIPAL, { now });
      expect(calendar.stale, `${String(hours)}h calendar`).toBe(stale);
      expect(calendar.lastSyncedAt).toBe(at(hours).toISOString());
      expect(gmail.stale).toBe(true);
      expect(gmail.lastSyncedAt).toBeNull();
    }
  });

  it("reads calendar_sync_state.last_synced_at and gmail_sync_state.last_tick_at, read-only", async () => {
    const db = fakeDb([
      { sql: "SELECT last_synced_at FROM calendar_sync_state WHERE id = 1", rows: [] },
      { sql: "SELECT last_tick_at AS last_synced_at FROM gmail_sync_state WHERE id = 'singleton'", rows: [] },
    ]);
    const freshness = await sourceFreshness(db, PRINCIPAL, { now });
    expect(freshness).toEqual([
      { source: "calendar", lastSyncedAt: null, stale: true, ageText: null },
      { source: "gmail", lastSyncedAt: null, stale: true, ageText: null },
    ]);
    expect(db.issued).toHaveLength(2);
    for (const { sql } of db.issued) {
      expect(sql.trimStart().toUpperCase().startsWith("SELECT")).toBe(true);
    }
  });

  it("staleAfterHours is configurable; invalid values throw", async () => {
    const db = fakeDb([
      { sql: "calendar_sync_state", rows: [{ last_synced_at: new Date(NOW.getTime() - 2 * HOUR) }] },
      { sql: "gmail_sync_state", rows: [] },
    ]);
    const [calendar] = await sourceFreshness(db, PRINCIPAL, { now, staleAfterHours: 1 });
    expect(calendar.stale).toBe(true);
    const db2 = fakeDb([
      { sql: "calendar_sync_state", rows: [{ last_synced_at: new Date(NOW.getTime() - 2 * HOUR) }] },
      { sql: "gmail_sync_state", rows: [] },
    ]);
    const [cal2] = await sourceFreshness(db2, PRINCIPAL, { now, staleAfterHours: 4 });
    expect(cal2.stale).toBe(false);
    const db3 = fakeDb([]);
    await expect(sourceFreshness(db3, PRINCIPAL, { now, staleAfterHours: 0 })).rejects.toThrow(
      /staleAfterHours/,
    );
  });

  it("STALE_AFTER_HOURS default is 6", () => {
    expect(STALE_AFTER_HOURS).toBe(6);
  });
});

describe("freshnessLines", () => {
  it("renders stale lines with pre-rendered ages; fresh sources say nothing", async () => {
    const db = fakeDb([
      { sql: "calendar_sync_state", rows: [{ last_synced_at: new Date(NOW.getTime() - 6.5 * HOUR) }] },
      { sql: "gmail_sync_state", rows: [{ last_synced_at: new Date(NOW.getTime() - 30 * 60_000) }] },
    ]);
    const freshness = await sourceFreshness(db, PRINCIPAL, { now });
    expect(freshnessLines(freshness)).toEqual(["calendar last synced 6h ago"]);
  });

  it("renders never-synced sources honestly", async () => {
    const db = fakeDb([
      { sql: "calendar_sync_state", rows: [] },
      { sql: "gmail_sync_state", rows: [] },
    ]);
    const freshness = await sourceFreshness(db, PRINCIPAL, { now });
    expect(freshnessLines(freshness)).toEqual([
      "calendar has never synced",
      "gmail has never synced",
    ]);
  });

  it("renders long ages in whole hours, never negative", async () => {
    const db = fakeDb([
      { sql: "calendar_sync_state", rows: [{ last_synced_at: new Date(NOW.getTime() - 31.9 * HOUR) }] },
      { sql: "gmail_sync_state", rows: [] },
    ]);
    const freshness = await sourceFreshness(db, PRINCIPAL, { now });
    expect(freshnessLines(freshness)).toEqual(["calendar last synced 31h ago", "gmail has never synced"]);
  });

  it("fresh everything → zero lines (no-noise)", async () => {
    const db = fakeDb([
      { sql: "calendar_sync_state", rows: [{ last_synced_at: new Date(NOW.getTime() - HOUR) }] },
      { sql: "gmail_sync_state", rows: [{ last_synced_at: new Date(NOW.getTime() - 2 * HOUR) }] },
    ]);
    const freshness = await sourceFreshness(db, PRINCIPAL, { now });
    expect(freshnessLines(freshness)).toEqual([]);
  });
});
