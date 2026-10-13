/**
 * W1.2 Missions view — integration. Read-only projection of existing
 * Outcomes: principal isolation, status grouping, bounded recently-finished,
 * hostile HTML escaped, principal-scoped outcome links.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../../packages/db/tests/test-db";
import { resetTodayAuthPolicyCache } from "../tailscale-auth";
import { buildApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TS_LOGIN = "owner@example.tailnet";
const HOSTILE = `<script>alert("xss")</script>`;

describe.skipIf(!TEST_DATABASE_URL)("missions view (integration)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;
  let userId: string;
  let otherId: string;
  let cookie: string;
  let configPath: string;

  async function seedMission(
    principalId: string,
    ref: string,
    title: string,
    status: string,
    updatedOffsetMs = 0,
  ): Promise<void> {
    await db.pool.query(
      `INSERT INTO outcomes (id, principal_id, ref, title, directive, status, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'd', $5, now() - ($6 || ' milliseconds')::interval)`,
      [randomUUID(), principalId, ref, title, status, String(Math.abs(updatedOffsetMs))],
    );
  }

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w12missions");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "josctl", credentialHash: sha256Hex(randomBytes(32).toString("hex")),
    });
    userId = user.id;
    const other = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "second", credentialHash: sha256Hex(randomBytes(32).toString("hex")),
    });
    otherId = other.id;

    configPath = join(tmpdir(), `w12missions-${randomUUID()}.json`);
    await fs.writeFile(
      configPath,
      JSON.stringify({ tailscale: { enabled: true, identities: { [TS_LOGIN]: "josctl" } } }),
    );
    process.env.TODAY_AUTH_CONFIG = configPath;
    resetTodayAuthPolicyCache();

    app = await buildApp({ db: db.pool, dispatch: { start: async () => ({ runId: "fake" }) } });

    // grouping coverage for the owner principal
    await seedMission(userId, "MNEED1", "Waiting on owner", "waiting_user");
    await seedMission(userId, "MNEED2", "Blocked mission", "blocked");
    await seedMission(userId, "MRUN1", "Queued mission", "queued");
    await seedMission(userId, "MRUN2", "Running mission", "running");
    await seedMission(userId, "MRUN3", "Waiting external", "waiting_external");
    await seedMission(userId, "MRUN4", "Verifying mission", "verifying");
    await seedMission(userId, "MRUN5", "Accepted mission", "accepted");
    await seedMission(userId, "MDONE1", HOSTILE, "completed");
    await seedMission(userId, "MDONE2", "Old finished", "failed", 30 * 86_400_000);
    for (let i = 0; i < 22; i += 1) {
      // distinct offsets → deterministic updated_at DESC ordering
      await seedMission(userId, `MOLD${i}`, `Old bulk ${i}`, "cancelled", 3 * 86_400_000 + i * 60_000);
    }
    // foreign principal's missions must never appear
    await seedMission(otherId, "MFOR1", "Foreign waiting", "waiting_user");
    await seedMission(otherId, "MFOR2", "Foreign running", "running");

    // auto-login via the tailscale path (the normal W1.2 flow)
    const res = await app.inject({ method: "GET", url: "/ui", headers: { "Tailscale-User-Login": TS_LOGIN } });
    expect(res.statusCode).toBe(200);
    const line = Array.isArray(res.headers["set-cookie"]) ? (res.headers["set-cookie"] as string[]).join(";") : String(res.headers["set-cookie"]);
    const m = line.match(/jehad_session=[^;]+/);
    expect(m).not.toBeNull();
    cookie = m![0];
  });

  afterAll(async () => {
    delete process.env.TODAY_AUTH_CONFIG;
    resetTodayAuthPolicyCache();
    await fs.rm(configPath, { force: true });
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  function getMissions() {
    return app.inject({ method: "GET", url: "/ui/missions", headers: { cookie } });
  }

  it("requires an authenticated session", async () => {
    const anon = await app.inject({ method: "GET", url: "/ui/missions" });
    expect(anon.statusCode).toBe(401);
  });

  it("groups active statuses; recently-finished bounded to 7 days / 20 rows", async () => {
    const res = await getMissions();
    expect(res.statusCode).toBe(200);
    const needs = res.body.split("Needs you")[1]!.split("<h2>Running</h2>")[0]!;
    const running = res.body.split("<h2>Running</h2>")[1]!.split("Recently finished")[0]!;
    const finished = res.body.split("Recently finished")[1]!;

    expect(needs).toContain("Waiting on owner");
    expect(needs).toContain("Blocked mission");
    expect(running).toContain("Queued mission");
    expect(running).toContain("Running mission");
    expect(running).toContain("Waiting external");
    expect(running).toContain("Verifying mission");
    expect(running).toContain("Accepted mission");

    // 22 three-day-old cancelled outcomes + 1 fresh completion exist; only
    // 20 render (the oldest bulk rows spill past the cap), and the
    // 30-day-old failure is outside the 7-day window
    const finishedCount = (finished.match(/<article>/g) ?? []).length;
    expect(finishedCount).toBe(20);
    expect(finished).toContain("Old bulk 0"); // newest of the bulk
    expect(finished).not.toContain("Old bulk 20"); // spilled past the cap
    expect(finished).not.toContain("Old bulk 21");
    expect(finished).not.toContain("Old finished"); // 30 days old
  });

  it("hostile titles are HTML-escaped", async () => {
    const res = await getMissions();
    expect(res.body).not.toContain(`<script>alert`);
    expect(res.body).toContain(`&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;`);
  });

  it("principal isolation: only the session principal's missions render", async () => {
    const res = await getMissions();
    expect(res.body).not.toContain("Foreign waiting");
    expect(res.body).not.toContain("Foreign running");
  });

  it("outcome links are the principal-scoped detail view", async () => {
    const res = await getMissions();
    expect(res.body).toContain(`/ui/outcome/MNEED1`);
    // foreign ref through the same view → 404 (fail-closed, never a leak)
    const foreign = await app.inject({
      method: "GET", url: "/ui/outcome/MFOR1", headers: { cookie },
    });
    expect(foreign.statusCode).toBe(404);
    expect(otherId).toBeTruthy();
  });
});
