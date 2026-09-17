// Golden set v2 data tests (hermetic, pure): structural invariants of
// golden-set.json and self-consistency of every (temporal_expression,
// resolution_status, resolved_due_date) triple against the eval reference
// normalizer — the golden answers must be exactly what resolving the golden
// expression against the golden anchor produces.

import { describe, expect, it } from "vitest";
import { loadDefaultGoldenSet, GOLDEN_SET_VERSION } from "./golden.js";
import { DEFAULT_ANCHOR_TIMEZONE, normalizeTemporalExpression } from "@jehad/core";
import { COMMITMENT_STATES } from "./metrics.js";

const ANCHOR = "2026-09-17T09:00:00.000Z";

describe("golden-set.json v2 invariants", () => {
  const set = loadDefaultGoldenSet();

  it("is version 2 with ~60 items and unique ids", () => {
    expect(set.version).toBe(GOLDEN_SET_VERSION);
    expect(set.items.length).toBeGreaterThanOrEqual(58);
    expect(set.items.length).toBeLessThanOrEqual(62);
    const ids = new Set(set.items.map((i) => i.id));
    expect(ids.size).toBe(set.items.length);
  });

  it("keeps all 37 v1 items (25 base + 12 hard-case) and adds the new categories", () => {
    const base = set.items.filter((i) => i.id.startsWith("base-"));
    const hard = set.items.filter((i) => i.id.startsWith("hard-"));
    expect(base.length).toBe(25);
    expect(hard.length).toBe(12);
    const temporal = set.items.filter((i) => i.category === "temporal-rules");
    const state = set.items.filter((i) => i.category === "state-adversarials");
    expect(temporal.length).toBe(14); // one per normalizer rule
    expect(state.length).toBe(10); // owner four + completed + historical + 2 renegotiated + 2 cancelled
  });

  it("uses the fixed anchor and the v2 expected shape on every item", () => {
    for (const item of set.items) {
      expect(item.occurredAt).toBe(ANCHOR);
      // Stance is recorded only where an obligation is expressed (null
      // otherwise); is=true requires an open stance.
      if (item.expected.commitment_state !== null) {
        expect(COMMITMENT_STATES).toContain(item.expected.commitment_state);
      }
      if (item.expected.is_commitment) {
        expect(["active", "renegotiated"]).toContain(item.expected.commitment_state);
      }
      expect(["resolved", "ambiguous", "unsupported", "none"]).toContain(item.expected.resolution_status);
      if (item.expected.resolution_status === "resolved") {
        expect(item.expected.resolved_due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      } else {
        expect(item.expected.resolved_due_date).toBeNull();
      }
      if (item.expected.temporal_expression !== null) {
        // The golden expression must be a phrase the text actually contains.
        const expr: string | null = item.expected.temporal_expression ?? null;
        expect(expr).not.toBeNull();
        expect(item.text.toLowerCase()).toContain(expr!.toLowerCase());
      }
    }
  });

  it("covers every commitment state", () => {
    const states = new Set(set.items.map((i) => i.expected.commitment_state));
    for (const state of COMMITMENT_STATES) expect(states.has(state)).toBe(true);
  });

  it("is_commitment=true only for open commitments (active | renegotiated)", () => {
    for (const item of set.items) {
      if (item.expected.is_commitment) {
        expect(["active", "renegotiated"]).toContain(item.expected.commitment_state);
      }
    }
    // …and the adversarial standpoints are all represented as non-open.
    const byId = new Map(set.items.map((i) => [i.id, i]));
    expect(byId.get("time-owner-01")).toMatchObject({
      text: "I told him last Friday I would send it Monday.",
      expected: { is_commitment: false, commitment_state: "historical" },
    });
    expect(byId.get("state-completed-01")?.expected).toMatchObject({ is_commitment: false, commitment_state: "completed" });
    expect(byId.get("state-historical-01")?.expected).toMatchObject({ is_commitment: false, commitment_state: "historical" });
    expect(byId.get("state-renegotiated-01")?.expected).toMatchObject({ is_commitment: true, commitment_state: "renegotiated" });
    expect(byId.get("state-cancelled-01")?.expected).toMatchObject({ is_commitment: false, commitment_state: "cancelled" });
  });

  it("every golden triple is exactly what the reference normalizer produces from the golden expression", () => {
    const mismatches: string[] = [];
    for (const item of set.items) {
      const result = normalizeTemporalExpression({
        expression: item.expected.temporal_expression ?? null,
        anchorTime: item.occurredAt,
        anchorTimezone: DEFAULT_ANCHOR_TIMEZONE,
      });
      if (
        result.normalizedTime !== (item.expected.resolved_due_date ?? null) ||
        result.resolutionStatus !== item.expected.resolution_status
      ) {
        mismatches.push(
          `${item.id}: golden ${item.expected.resolution_status}/${item.expected.resolved_due_date} vs normalizer ${result.resolutionStatus}/${result.normalizedTime}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("covers the owner temporal rules with distinct resolved answers", () => {
    const byId = new Map(set.items.map((i) => [i.id, i]));
    const expected: Record<string, string> = {
      "time-tomorrow-01": "2026-09-18",
      "time-weekday-01": "2026-09-22",
      "time-next-weekday-01": "2026-09-25",
      "time-in-two-weeks-01": "2026-10-01",
      "time-end-of-month-01": "2026-09-30",
      "time-this-weekend-01": "2026-09-19",
      "time-next-week-01": "2026-09-21",
      "time-month-day-this-year-01": "2026-10-06",
      "time-month-day-rollover-01": "2027-03-02",
      "time-later-today-01": "2026-09-17",
      "time-explicit-iso-01": "2026-10-15",
      "time-by-weekday-01": "2026-09-18",
    };
    for (const [id, date] of Object.entries(expected)) {
      expect(byId.get(id)?.expected.resolved_due_date).toBe(date);
    }
    // The two deliberately ambiguous rules resolve to null + ambiguous.
    expect(byId.get("time-vague-next-week-01")?.expected).toMatchObject({
      resolution_status: "ambiguous",
      resolved_due_date: null,
    });
    expect(byId.get("time-vague-chance-01")?.expected).toMatchObject({
      resolution_status: "ambiguous",
      resolved_due_date: null,
    });
  });
});
