// Claim-route recipient tests (multi-principal Lane P — contracts "Edge
// recipient honoring", server side). Needs PostgreSQL 16 — skipped unless
// TEST_DATABASE_URL is set (per-file isolated db). The claim response
// carries `recipient` ONLY on approved kind=reply rows: a
// conjunction-approved reply to a paired principal returns HER canonical
// handle; briefs/escalations never carry one (even when a row is corrupted
// to hold one — defense in depth); a reply with a failing conjunction is
// pending and thus never claimable at all.

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { createNotification, issueGrant } from "@jehad/core";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../packages/db/tests/test-db";
import { buildApp } from "../src/index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const EDGE_CREDENTIAL = randomBytes(32).toString("hex");
const YUSRA_HANDLE = "+15550002222";

describe.skipIf(!TEST_DATABASE_URL)("claim route recipient (integration)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;
  let yusraId: string;
  let edgeHarnessId: string;
  let sendChannelToken: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igclaim");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const yusra = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', 'yusra') RETURNING id",
    );
    yusraId = String(yusra.rows[0].id);
    const edge = await upsertPrincipalCredential(db.pool, {
      type: "harness",
      name: "imessage-local",
      credentialHash: sha256Hex(EDGE_CREDENTIAL),
    });
    edgeHarnessId = edge.id;
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    const personalDomainId = String(domain.rows[0].id);
    const sendChannel = await issueGrant(db.pool, {
      principalId: edgeHarnessId,
      runId: null,
      capability: "send_channel:imessage",
      resource: "notifications",
      domainId: personalDomainId,
      ttlMs: 60 * 60_000,
    });
    sendChannelToken = sendChannel.token;
    // Pair yusra: the reply conjunction needs a verified handle.
    const session = await db.pool.query(
      `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, expires_at)
       VALUES ($1::uuid, 'pair', $2, now() + interval '5 minutes') RETURNING id`,
      [yusraId, "c".repeat(64)],
    );
    await db.pool.query(
      `INSERT INTO transport_identities (principal_id, transport, handle, verified_at, last_seen_at, paired_via_session)
       VALUES ($1::uuid, 'imessage', $2, now(), now(), $3::uuid)`,
      [yusraId, YUSRA_HANDLE, session.rows[0].id],
    );
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

  async function claim(): Promise<Record<string, unknown> | null> {
    const res = await app.inject({
      method: "POST",
      url: "/harness/notifications/claim",
      headers: edgeHeaders(),
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { notification: Record<string, unknown> | null }).notification;
  }

  async function seedReply(overrides: Record<string, unknown> = {}): Promise<string> {
    const notification = await createNotification(db.pool, {
      kind: "reply",
      title: "Reply",
      payload: { content: "pong", recipient: YUSRA_HANDLE },
      recipient: YUSRA_HANDLE,
      sourceType: "run",
      sourceId: randomUUID(),
      createdBy: yusraId,
      surface: "imessage",
      requestingPrincipalId: yusraId,
      conversationPrincipalId: yusraId,
      thirdPartyRecipient: false,
      ...overrides,
    });
    return notification.id;
  }

  it("an approved kind=reply claim carries recipient = her canonical handle", async () => {
    const id = await seedReply();
    const row = (
      await db.pool.query("SELECT status FROM notifications WHERE id = $1::uuid", [id])
    ).rows[0];
    expect(row.status).toBe("approved"); // conjunction approved at creation

    const notification = await claim();
    expect(notification).not.toBeNull();
    expect(notification!.id).toBe(id);
    expect(notification!.kind).toBe("reply");
    expect(notification!.recipient).toBe(YUSRA_HANDLE);
    expect(notification!.payload).toMatchObject({ content: "pong", recipient: YUSRA_HANDLE });
  });

  it("a brief claim NEVER carries a recipient (even with one corruptly on the row)", async () => {
    const notification = await createNotification(db.pool, {
      kind: "brief",
      title: "Morning brief",
      payload: { content: "hello" },
      sourceType: "brief",
      sourceId: randomUUID(),
      createdBy: yusraId,
    });
    expect(notification.status).toBe("approved");
    // Defense-in-depth probe: corrupt the row so a non-reply kind holds a
    // recipient — the claim projection must still omit it.
    await db.pool.query("UPDATE notifications SET recipient = $2 WHERE id = $1::uuid", [
      notification.id,
      YUSRA_HANDLE,
    ]);

    const claimed = await claim();
    expect(claimed).not.toBeNull();
    expect(claimed!.kind).toBe("brief");
    expect(claimed!.recipient).toBeUndefined();
    expect("recipient" in claimed!).toBe(false);
  });

  it("a failing-conjunction reply is PENDING — never claimable, recipient or not", async () => {
    // Recipient ∉ her verified handles → queue.
    const pendingId = await seedReply({
      recipient: "+15559998888",
      payload: { content: "pong", recipient: "+15559998888" },
    });
    const status = (
      await db.pool.query("SELECT status FROM notifications WHERE id = $1::uuid", [pendingId])
    ).rows[0];
    expect(status.status).toBe("pending");

    const claimed = await claim();
    if (claimed !== null) {
      expect(claimed.id).not.toBe(pendingId);
    }
  });
});
