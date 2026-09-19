// Delivered-report fingerprint integration tests (Phase A Lane C —
// ig-phase-a-contracts.md §Lane C.1): the iMessage edge's delivery report
// optionally carries { recipient, rendered_text_sha256 }; the handler stores
// a sent_message_fingerprints row tied to the exact delivery so the shadow
// sensor can correlate our own sends out of the inbound stream (loop
// defense, imessage-gateway.md §5.2).
//
// The fingerprints TABLE belongs to Lane B's migration 010, which is NOT in
// this worktree — this suite creates the three sensor tables from a local
// fixture (fixtures/imessage-sensor-tables.sql, CREATE TABLE IF NOT EXISTS)
// so it also runs clean once the real migration lands.

import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { createNotification, issueGrant } from "@jehad/core";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../packages/db/tests/test-db";
import { buildApp } from "../src/index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const EDGE_CREDENTIAL = randomBytes(32).toString("hex");

// The edge sends the canonical (NFC + LF) form's digest — pinned vector,
// identical to the one in apps/edge-agent/test/loop.test.ts.
const RENDERED_TEXT = "Morning brief\nLINE ONE\nLINE TWO";
const RENDERED_TEXT_SHA256 = "ff4dae0659223bc0223b82d779ceb3494d4c43109e9b7ae7502757e3f2575fa0";
const RECIPIENT = "owner+phone@example.com";

describe.skipIf(!TEST_DATABASE_URL)("harness delivered-report fingerprints (integration)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;
  let edgeHarnessId: string;
  let personalDomainId: string;
  let sendChannelToken: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "apifingerprint");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    // The sensor tables (migration 010, Lane B) if that migration is absent
    // in this worktree; no-op if it has landed.
    const fixture = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "imessage-sensor-tables.sql"),
      "utf8",
    );
    await db.pool.query(fixture);
    const edgeHarness = await upsertPrincipalCredential(db.pool, {
      type: "harness",
      name: "imessage-local",
      credentialHash: sha256Hex(EDGE_CREDENTIAL),
    });
    edgeHarnessId = edgeHarness.id;
    personalDomainId = String(
      (await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`)).rows[0].id,
    );
    const grant = await issueGrant(db.pool, {
      principalId: edgeHarnessId,
      runId: null,
      capability: "send_channel:imessage",
      resource: "notifications",
      domainId: personalDomainId,
      ttlMs: 60 * 60_000,
    });
    sendChannelToken = grant.token;
    app = await buildApp({ db: db.pool });
  });

  afterAll(async () => {
    await app.close();
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  function edgeHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${EDGE_CREDENTIAL}`,
      "x-capability-token": sendChannelToken,
    };
  }

  async function seedClaimedBrief(): Promise<string> {
    const notification = await createNotification(db.pool, {
      kind: "brief", // auto-approves per policy.yaml
      title: "Morning brief",
      payload: { content: "LINE ONE\nLINE TWO" },
      domainId: personalDomainId,
      sourceType: "brief",
      sourceId: randomUUID(),
      createdBy: edgeHarnessId,
    });
    const claim = await app.inject({
      method: "POST",
      url: "/harness/notifications/claim",
      headers: edgeHeaders(),
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().notification.id).toBe(notification.id);
    return notification.id;
  }

  async function fingerprints(notificationId: string) {
    const rows = await db.pool.query(
      "SELECT notification_id, recipient, rendered_text_sha256, delivered_at FROM sent_message_fingerprints WHERE notification_id = $1::uuid",
      [notificationId],
    );
    return rows.rows;
  }

  it("delivered report with recipient + rendered_text_sha256 stores one fingerprint row tied to the exact delivery", async () => {
    // Sanity: the pinned vector IS the canonical digest of the rendered text.
    expect(sha256Hex(RENDERED_TEXT)).toBe(RENDERED_TEXT_SHA256);

    const id = await seedClaimedBrief();
    const delivered = await app.inject({
      method: "POST",
      url: `/harness/notifications/${id}/delivered`,
      headers: { ...edgeHeaders(), "content-type": "application/json" },
      payload: JSON.stringify({ recipient: RECIPIENT, rendered_text_sha256: RENDERED_TEXT_SHA256 }),
    });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().notification).toMatchObject({ id, status: "delivered" });

    const rows = await fingerprints(id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(String(row.notification_id)).toBe(id);
    expect(row.recipient).toBe(RECIPIENT);
    expect(row.rendered_text_sha256).toBe(RENDERED_TEXT_SHA256);
    // delivered_at matches the notifications row's own delivery stamp (the
    // sensor correlates on this timestamp window).
    const notification = (
      await db.pool.query("SELECT delivered_at FROM notifications WHERE id = $1::uuid", [id])
    ).rows[0];
    expect(new Date(String(row.delivered_at)).getTime()).toBe(
      new Date(String(notification.delivered_at)).getTime(),
    );

    // The fingerprint write is audited with the grant that authorized the cycle.
    const audit = await db.pool.query(
      `SELECT actor, grant_id, outputs_ref::jsonb AS o FROM audit_log
        WHERE action = 'notification.fingerprint_recorded'
          AND outputs_ref::jsonb->>'notificationId' = $1`,
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor).toBe("harness:imessage-local");
    expect(audit.rows[0].grant_id).not.toBeNull();
    expect(audit.rows[0].o.recipient).toBe(RECIPIENT);
    expect(audit.rows[0].o.renderedTextSha256).toBe(RENDERED_TEXT_SHA256);
  });

  it("legacy body-less delivered report still 200s and writes NO fingerprint (pinned-test compatibility)", async () => {
    const id = await seedClaimedBrief();
    const delivered = await app.inject({
      method: "POST",
      url: `/harness/notifications/${id}/delivered`,
      headers: edgeHeaders(),
    });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().notification.status).toBe("delivered");
    expect(await fingerprints(id)).toHaveLength(0);
  });

  it("malformed fingerprint body is 400 BEFORE any state change — the notification stays deliverable", async () => {
    const id = await seedClaimedBrief();
    const badPayloads = [
      { recipient: RECIPIENT, rendered_text_sha256: "not-a-hash" },
      { recipient: RECIPIENT, rendered_text_sha256: "FF4DAE0659223BC0223B82D779CEB3494D4C43109E9B7AE7502757E3F2575FA0" }, // uppercase rejected
      { recipient: RECIPIENT }, // hash missing
      { rendered_text_sha256: RENDERED_TEXT_SHA256 }, // recipient missing
      { recipient: "   ", rendered_text_sha256: RENDERED_TEXT_SHA256 }, // blank recipient
      ["array", "not", "object"],
    ];
    for (const payload of badPayloads) {
      const res = await app.inject({
        method: "POST",
        url: `/harness/notifications/${id}/delivered`,
        headers: { ...edgeHeaders(), "content-type": "application/json" },
        payload: JSON.stringify(payload),
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toBe("invalid_delivery_report");
    }
    // No delivery happened: still approved, no fingerprint row.
    const status = (
      await db.pool.query("SELECT status FROM notifications WHERE id = $1::uuid", [id])
    ).rows[0];
    expect(status.status).toBe("approved");
    expect(await fingerprints(id)).toHaveLength(0);

    // The row was not poisoned — a valid report still delivers it.
    const delivered = await app.inject({
      method: "POST",
      url: `/harness/notifications/${id}/delivered`,
      headers: { ...edgeHeaders(), "content-type": "application/json" },
      payload: JSON.stringify({ recipient: RECIPIENT, rendered_text_sha256: RENDERED_TEXT_SHA256 }),
    });
    expect(delivered.statusCode).toBe(200);
    expect(await fingerprints(id)).toHaveLength(1);
  });
});
