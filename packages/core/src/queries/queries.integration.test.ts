// Structured-query service integration tests (M6A; plan §13, review §17/§25)
// against a seeded isolated database. Covers the §25 dependency-leverage
// scenario verbatim (Decision A blocks B/C/D, E blocks F → A), §7
// overdue/due-soon variants, the derived silently-stalled rule (per-type
// thresholds, blocked-not-stalled, expired edges, progress-event rescue),
// whatChanged deltas, blocked_by cycles, and cross-domain isolation.
// Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { seedQueryFixtureWorld, type FixtureIds } from "./fixtures.js";
import { whatAmIWaitingFor, whatWaitsOnMe } from "./waiting.js";
import { whatChanged } from "./changed.js";
import { whatIsBlocked } from "./blocked.js";
import { highestLeverageDecision } from "./leverage.js";
import * as queriesModule from "./index.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-17T12:00:00.000Z");
const now = (): Date => NOW;

describe.skipIf(!TEST_DATABASE_URL)("structured queries (integration)", () => {
  let db: IsolatedDb;
  let f: FixtureIds;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "m6aqueries");
    await migrateUp(db.pool);
    f = await seedQueryFixtureWorld(db.pool, { now: NOW });
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  // ---- §25 verbatim: A blocks B, C, D; E blocks F → highest-leverage is A ----
  it("highestLeverageDecision ranks Decision A first (review §25 dependency leverage)", async () => {
    const ranked = await highestLeverageDecision(db.pool, { domainId: "personal", now });

    const a = ranked.find((d) => d.decisionId === f.decisions.decisionA);
    const e = ranked.find((d) => d.decisionId === f.decisions.decisionE);
    expect(a).toBeDefined();
    expect(e).toBeDefined();
    expect(ranked[0]!.decisionId).toBe(f.decisions.decisionA);

    // Direct downstream of A: exactly Tasks B, C, D.
    expect(a!.directDownstreamCount).toBe(3);
    const directIds = a!.topBlockedItems.filter((i) => i.depth === 1).map((i) => i.itemId).sort();
    expect(directIds).toEqual(
      [f.commitments.taskB, f.commitments.taskC, f.commitments.taskD].sort(),
    );
    // Transitive: B, C, D + T2 (depth 2) + T3 (depth 3); T4 is beyond the cap.
    expect(a!.transitiveDownstreamCount).toBe(5);
    expect(a!.topBlockedItems.map((i) => i.itemId)).not.toContain(f.commitments.taskT4);
    expect(a!.topBlockedItems.find((i) => i.itemId === f.commitments.taskT2)?.depth).toBe(2);
    expect(a!.topBlockedItems.find((i) => i.itemId === f.commitments.taskT3)?.depth).toBe(3);
    // E sits below A (F + the blocked-stale fixture item).
    expect(e!.directDownstreamCount).toBe(2);
    expect(ranked.indexOf(e!)).toBeGreaterThan(ranked.indexOf(a!));

    // Decisions with non-empty revisit_conditions and no open downstream are
    // resolved and excluded; revisit-empty decisions with no edges stay as
    // zero-downstream candidates ranked last.
    expect(ranked.find((d) => d.decisionId === f.decisions.decisionClosed)).toBeUndefined();
    const none = ranked.find((d) => d.decisionId === f.decisions.decisionNoDownstream);
    expect(none).toBeDefined();
    expect(none!.directDownstreamCount).toBe(0);
    expect(none!.transitiveDownstreamCount).toBe(0);
    expect(ranked[ranked.length - 1]!.decisionId).toBe(f.decisions.decisionNoDownstream);

    // Unfiltered includes the work-domain decision; the personal filter never does.
    const all = await highestLeverageDecision(db.pool, { now });
    expect(all.find((d) => d.decisionId === f.decisions.decisionWork)).toBeDefined();
    expect(ranked.find((d) => d.decisionId === f.decisions.decisionWork)).toBeUndefined();
  });

  it("highestLeverageDecision respects the depth cap option", async () => {
    const depthOne = await highestLeverageDecision(db.pool, {
      domainId: "personal",
      now,
      maxDepth: 1,
    });
    const a = depthOne.find((d) => d.decisionId === f.decisions.decisionA)!;
    expect(a.directDownstreamCount).toBe(3);
    expect(a.transitiveDownstreamCount).toBe(3);
  });

  // ---- §7 overdue variants ----------------------------------------------------
  it("whatAmIWaitingFor returns open owes_me rows with overdue flags; renegotiated/void excluded", async () => {
    const waiting = await whatAmIWaitingFor(db.pool, { domainId: "personal", now });
    const ids = waiting.map((c) => c.id);

    expect(ids).toContain(f.commitments.waitingOverdue);
    expect(ids).toContain(f.commitments.waitingFuture);
    expect(ids).not.toContain(f.commitments.renegotiatedPast);
    expect(ids).not.toContain(f.commitments.voidPast);
    expect(ids).not.toContain(f.commitments.metPast);
    // i_owe rows and work rows never appear.
    expect(ids).not.toContain(f.commitments.mineOverdue);
    expect(ids).not.toContain(f.commitments.workMine);

    const overdue = waiting.find((c) => c.id === f.commitments.waitingOverdue)!;
    expect(overdue.overdue).toBe(true);
    expect(overdue.counterpartyText).toBe("Acme Corp");
    expect(overdue.counterpartyEntityId).toBe(f.entities.acmeOrg);
    expect(overdue.domainKey).toBe("personal");
    expect(waiting.find((c) => c.id === f.commitments.waitingFuture)!.overdue).toBe(false);
    // Overdue (past due) sorts before future-dated.
    expect(waiting.findIndex((c) => c.id === f.commitments.waitingOverdue)).toBeLessThan(
      waiting.findIndex((c) => c.id === f.commitments.waitingFuture),
    );
  });

  it("whatWaitsOnMe flags overdue and due-soon; due-soon window is configurable", async () => {
    const mine = await whatWaitsOnMe(db.pool, { domainId: "personal", now, dueSoonDays: 3 });
    const byId = new Map(mine.map((c) => [c.id, c]));

    expect(byId.get(f.commitments.mineOverdue)).toMatchObject({ overdue: true, dueSoon: false });
    expect(byId.get(f.commitments.mineDueSoon)).toMatchObject({ overdue: false, dueSoon: true });
    // due_at in 2 days is outside a 1-day window, inside a 3-day window.
    const oneDay = await whatWaitsOnMe(db.pool, { domainId: "personal", now, dueSoonDays: 1 });
    expect(oneDay.find((c) => c.id === f.commitments.mineDueSoon)!.dueSoon).toBe(false);
    expect(byId.get(f.commitments.mineNoDue)).toMatchObject({ overdue: false, dueSoon: false });
    expect(byId.has(f.commitments.metPast)).toBe(false);
    expect(byId.has(f.commitments.workMine)).toBe(false);
  });

  // ---- review §17 derived silently-stalled -------------------------------------
  it("whatIsBlocked reports explicitly blocked items with blocker info and cycle notes", async () => {
    const { blocked } = await whatIsBlocked(db.pool, { domainId: "personal", now });
    const ids = blocked.map((b) => b.itemId);

    for (const task of [f.commitments.taskB, f.commitments.taskC, f.commitments.taskD]) {
      const item = blocked.find((b) => b.itemId === task)!;
      expect(item).toBeDefined();
      expect(item.blockerType).toBe("decision");
      expect(item.blockerId).toBe(f.decisions.decisionA);
      expect(item.blockerLabel).toBe("Choose the migration approach");
      expect(item.cycle).toBe(false);
    }
    // Expired edge (valid_until yesterday) no longer blocks.
    expect(ids).not.toContain(f.commitments.expiredBlocked);
    // Cycle pair: both blocked, both flagged, no infinite loop.
    const cycXItem = blocked.find((b) => b.itemId === f.commitments.cycX)!;
    const cycYItem = blocked.find((b) => b.itemId === f.commitments.cycY)!;
    expect(cycXItem.cycle).toBe(true);
    expect(cycYItem.cycle).toBe(true);
    expect(cycXItem.blockerId).toBe(f.commitments.cycY);
    expect(cycYItem.blockerId).toBe(f.commitments.cycX);
    // Work edge filtered out.
    expect(ids).not.toContain(f.commitments.workTask);
    expect(blocked.every((b) => b.domainKey === "personal")).toBe(true);
  });

  it("derives silently-stalled per review §17 (never a stored status)", async () => {
    const { stalled } = await whatIsBlocked(db.pool, { domainId: "personal", now });
    const ids = stalled.map((s) => s.itemId);

    // 8 days silent, unblocked → stalled at the 7d default.
    const stale = stalled.find((s) => s.itemId === f.commitments.staleUnblocked)!;
    expect(stale).toBeDefined();
    expect(stale.itemType).toBe("commitment");
    expect(stale.thresholdDays).toBe(7);
    expect(stale.stalledForDays).toBe(8);
    // Updated 2 days ago → not stalled.
    expect(ids).not.toContain(f.commitments.freshUnblocked);
    // Old row rescued by a progress event referencing it yesterday → not stalled.
    expect(ids).not.toContain(f.commitments.progressRescued);
    // Explicitly blocked (even though 8 days stale) → blocked, NOT stalled.
    expect(ids).not.toContain(f.commitments.blockedStale);
    // Edge expired → back to stalled (the blocking no longer explains silence).
    expect(ids).toContain(f.commitments.expiredBlocked);
    // 12-day-silent project also crosses the 7d default.
    const project = stalled.find((s) => s.itemId === f.entities.projectStalled)!;
    expect(project).toBeDefined();
    expect(project.itemType).toBe("project");
    expect(project.itemLabel).toBe("Legacy Migration");
    expect(ids).not.toContain(f.entities.projectActive);
    // Stored status untouched — derivation only.
    const statusRow = await db.pool.query(
      `SELECT status FROM commitments WHERE id = $1::uuid`,
      [f.commitments.staleUnblocked],
    );
    expect(statusRow.rows[0]!.status).toBe("open");
  });

  it("stalled thresholds are configurable per type (review §17)", async () => {
    const relaxedProjects = await whatIsBlocked(db.pool, {
      domainId: "personal",
      now,
      stalled: { defaultDays: 7, byType: { project: 30 } },
    });
    expect(relaxedProjects.stalled.map((s) => s.itemId)).not.toContain(f.entities.projectStalled);
    expect(relaxedProjects.stalled.map((s) => s.itemId)).toContain(f.commitments.staleUnblocked);

    const strictCommitments = await whatIsBlocked(db.pool, {
      domainId: "personal",
      now,
      stalled: { defaultDays: 10, byType: { commitment: 10, project: 30 } },
    });
    const strictIds = strictCommitments.stalled.map((s) => s.itemId);
    expect(strictIds).not.toContain(f.commitments.staleUnblocked); // 8d < 10d
    expect(strictIds).not.toContain(f.commitments.expiredBlocked);
    expect(strictIds).not.toContain(f.entities.projectStalled); // 12d < 30d
  });

  // ---- whatChanged deltas -------------------------------------------------------
  it("whatChanged returns only deltas since the timestamp, grouped by event type", async () => {
    const result = await whatChanged(db.pool, {
      since: new Date(NOW.getTime() - 3 * 86_400_000),
      domainId: "personal",
    });

    expect(result.eventGroups.map((g) => g.type)).toEqual([
      "capture.recorded",
      "commitment.detected",
    ]);
    // Recent capture.recorded: the 3 fresh commitment source events
    // (waitingFuture, mineDueSoon, mineNoDue), cycX/cycY/freshUnblocked source
    // events (2 days), and the progress event.
    const captureGroup = result.eventGroups[0]!;
    expect(captureGroup.count).toBe(7);
    const captureIds = captureGroup.events.map((e) => e.id);
    expect(captureIds).toContain(f.events.progressEvent);
    const detected = result.eventGroups[1]!;
    expect(detected.count).toBe(2);
    // Work-domain events never leak into a personal delta.
    expect(result.eventGroups.every((g) => g.events.every((e) => e.domainKey === "personal"))).toBe(
      true,
    );

    expect(result.commitments.map((c) => c.id).sort()).toEqual(
      [
        f.commitments.waitingFuture,
        f.commitments.mineDueSoon,
        f.commitments.mineNoDue,
        f.commitments.cycX,
        f.commitments.cycY,
        f.commitments.freshUnblocked,
      ].sort(),
    );
    // All fixture decisions are older than the delta bound.
    expect(result.decisions).toEqual([]);
    // Only the two cycle edges (2 days old) are recent relationship writes.
    expect(result.relationships.map((r) => r.fromId).sort()).toEqual(
      [f.commitments.cycX, f.commitments.cycY].sort(),
    );

    const older = await whatChanged(db.pool, {
      since: new Date(NOW.getTime() - 1.5 * 86_400_000),
      domainId: "personal",
    });
    expect(older.commitments.map((c) => c.id).sort()).toEqual(
      [f.commitments.waitingFuture, f.commitments.mineDueSoon].sort(),
    );
    expect(older.relationships).toEqual([]);
  });

  it("whatChanged rejects an invalid since", async () => {
    await expect(whatChanged(db.pool, { since: "not-a-date" })).rejects.toThrow(TypeError);
  });

  // ---- domain isolation -----------------------------------------------------------
  it("work-domain rows never leak into personal-domain queries", async () => {
    const workUuids = [
      f.commitments.workMine,
      f.commitments.workTask,
      f.decisions.decisionWork,
    ];
    const waiting = await whatAmIWaitingFor(db.pool, { domainId: "personal", now });
    const mine = await whatWaitsOnMe(db.pool, { domainId: "personal", now });
    const changed = await whatChanged(db.pool, { since: new Date(0), domainId: "personal" });
    const { blocked, stalled } = await whatIsBlocked(db.pool, { domainId: "personal", now });
    const leverage = await highestLeverageDecision(db.pool, { domainId: "personal", now });

    const allRows: Array<Record<string, unknown>> = [
      ...waiting,
      ...mine,
      ...changed.eventGroups.flatMap((g) => g.events as unknown[] as Record<string, unknown>[]),
      ...changed.commitments,
      ...changed.decisions,
      ...changed.relationships,
      ...blocked,
      ...stalled,
      ...leverage,
    ];
    for (const row of allRows) {
      expect(row.domainKey === undefined || row.domainKey === "personal").toBe(true);
      for (const uuid of workUuids) {
        expect(JSON.stringify(row)).not.toContain(uuid);
      }
    }

    // Unfiltered queries do see the work rows; work-filtered see only them.
    const allMine = await whatWaitsOnMe(db.pool, { now });
    expect(allMine.map((c) => c.id)).toContain(f.commitments.workMine);
    const workMine = await whatWaitsOnMe(db.pool, { domainId: "work", now });
    expect(workMine.map((c) => c.id).sort()).toEqual(
      [f.commitments.workMine, f.commitments.workTask].sort(),
    );
    expect(workMine.every((c) => c.domainKey === "work")).toBe(true);
    const workLeverage = await highestLeverageDecision(db.pool, { domainId: "work", now });
    expect(workLeverage.map((d) => d.decisionId)).toEqual([f.decisions.decisionWork]);
    expect(workLeverage[0]!.directDownstreamCount).toBe(1);
  });

  // ---- read-only surface ------------------------------------------------------------
  it("exposes a read-only surface and mutates nothing", async () => {
    const surface = Object.keys(queriesModule);
    expect(surface).toContain("whatAmIWaitingFor");
    expect(surface).toContain("whatWaitsOnMe");
    expect(surface).toContain("whatChanged");
    expect(surface).toContain("whatIsBlocked");
    expect(surface).toContain("highestLeverageDecision");
    expect(surface.filter((name) => /insert|update|delete|remove|create|write/i.test(name))).toEqual(
      [],
    );

    const countSql = `
      SELECT (SELECT count(*) FROM commitments) AS commitments,
             (SELECT count(*) FROM decisions) AS decisions,
             (SELECT count(*) FROM relationships) AS relationships,
             (SELECT count(*) FROM entities) AS entities,
             (SELECT count(*) FROM events) AS events
    `;
    const before = await db.pool.query(countSql);
    await Promise.all([
      whatAmIWaitingFor(db.pool, { domainId: "personal", now }),
      whatWaitsOnMe(db.pool, { domainId: "personal", now }),
      whatChanged(db.pool, { since: new Date(0) }),
      whatIsBlocked(db.pool, { domainId: "personal", now }),
      highestLeverageDecision(db.pool, { now }),
    ]);
    const after = await db.pool.query(countSql);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("handles an empty world deterministically", async () => {
    const empty = await createIsolatedTestDb(TEST_DATABASE_URL!, `m6aempty${randomUUID().slice(0, 8)}`);
    try {
      await migrateUp(empty.pool);
      await expect(whatAmIWaitingFor(empty.pool, { now })).resolves.toEqual([]);
      await expect(whatWaitsOnMe(empty.pool, { now })).resolves.toEqual([]);
      await expect(highestLeverageDecision(empty.pool, { now })).resolves.toEqual([]);
      const emptyBlocked = await whatIsBlocked(empty.pool, { now });
      expect(emptyBlocked).toEqual({ blocked: [], stalled: [] });
      const emptyChanged = await whatChanged(empty.pool, { since: new Date(0) });
      expect(emptyChanged.eventGroups).toEqual([]);
      expect(emptyChanged.commitments).toEqual([]);
    } finally {
      await dropIsolatedTestDb(TEST_DATABASE_URL!, empty);
    }
  });
});
