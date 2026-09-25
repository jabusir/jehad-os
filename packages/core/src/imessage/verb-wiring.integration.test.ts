// Verifier C (W4+W5 wave): conversation-level pins for the new wired
// pre-passes — occurrence verbs (gated + sole/multi), commitment verbs
// (resolver rule), and the profile propose→confirm persistence flow.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { FakeModelProvider } from "@jehad/adapters";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import { issueGrant } from "../policy/grants.js";
import { CONVERSE_CAPABILITY, handleInbound, type ConversationDeps } from "./conversation.js";

// §22 dual-window: this suite pins the LEGACY orchestration path (the
// rollback path) — pin the fixture policy (routing: legacy) file-wide.
process.env.POLICY_YAML_PATH ??= new URL("./legacy-routing.fixture.yaml", import.meta.url).pathname;

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const T0 = new Date();

const REGISTRY = new ModelEgressPolicyRegistry([
  {
    id: "test-personal-normal",
    domainId: "personal",
    sensitivity: "normal",
    allowedProviders: ["fake"],
    allowRemote: false,
    requireRedaction: false,
  },
]);

describe.skipIf(!TEST_DATABASE_URL)("W4/W5 verb wiring pins (integration)", () => {
  let db: IsolatedDb;
  let domainId: string;
  const handles = new Map<string, string>();

  const setup = async (name: string, seq: number) => {
    const handle = `+1555000${String(6000 + seq)}`;
    handles.set(name, handle);
    const principal = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
      [name],
    );
    const id = String(principal.rows[0].id);
    const session = await db.pool.query(
      `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, expires_at)
       VALUES ($1::uuid, 'pair', $2, now() + interval '5 minutes') RETURNING id`,
      [id, "b".repeat(64)],
    );
    await db.pool.query(
      `INSERT INTO transport_identities (principal_id, transport, handle, verified_at, last_seen_at, paired_via_session)
       VALUES ($1::uuid, 'imessage', $2, $3::timestamptz, $3::timestamptz, $4::uuid)`,
      [id, handle, T0.toISOString(), session.rows[0].id],
    );
    await issueGrant(db.pool, {
      principalId: id,
      runId: null,
      capability: CONVERSE_CAPABILITY,
      resource: "imessage",
      domainId,
      expiresAt: new Date(T0.getTime() + 60 * 60_000),
    });
    return id;
  };

  const deps = (reads: string[]): ConversationDeps => ({
    db: db.pool,
    provider: new FakeModelProvider({ respond: { text: "model handled it" } }),
    registry: REGISTRY,
    principalPolicy: () => ({
      model: "fake/model-x",
      requestsPerHour: 30,
      costPerDay: 5,
      reads,
    }),
    now: () => T0,
  });

  const seedPastUnverifiedEvent = async (title: string, hoursAgo: number) => {
    const end = new Date(T0.getTime() - hoursAgo * 60 * 60_000);
    const start = new Date(end.getTime() - 60 * 60_000);
    const sourceEvent = await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, recorded_at, payload, idempotency_key, domain_id, sensitivity, schema_version)
       VALUES (gen_random_uuid(), 'calendar.event.created', 'test', $1::timestamptz, $1::timestamptz, '{}', $2, $3::uuid, 'normal', 1) RETURNING id`,
      [start.toISOString(), `w45-evt-${title}-${hoursAgo}-${Math.random()}`, domainId],
    );
    const row = await db.pool.query(
      `INSERT INTO calendar_events
         (google_event_id, google_calendar_id, summary, start_time, end_time, status, content_hash, occurrence, source_event_id)
       VALUES ($1, 'primary', $2, $3::timestamptz, $4::timestamptz, 'confirmed', 'x', 'scheduled_past_unverified', $5::uuid)
       RETURNING id`,
      [`evt-${title}-${hoursAgo}`, title, start.toISOString(), end.toISOString(), sourceEvent.rows[0].id],
    );
    return String(row.rows[0].id);
  };

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igw45");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    domainId = String(domain.rows[0].id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("occurrence verb confirms the SOLE eligible past event (user_declared graduation)", async () => {
    const id = await setup("w45-occ", 1);
    const eventId = await seedPastUnverifiedEvent("Henna sync", 3);
    const outcome = await handleInbound(deps(["calendar"]), {
      principalId: id,
      handle: handles.get("w45-occ")!,
      text: "it happened",
    });
    expect(outcome.replied).toBe(true);
    const row = await db.pool.query(
      "SELECT occurrence, occurrence_confirmed_by->>'kind' AS kind FROM calendar_events WHERE id = $1::uuid",
      [eventId],
    );
    expect(row.rows[0].occurrence).toBe("observed_occurred");
    expect(row.rows[0].kind).toBe("user_declared");
  });

  it("occurrence verbs are GATED on the calendar read — yusra cannot graduate state", async () => {
    const id = await setup("w45-nocal", 2);
    await seedPastUnverifiedEvent("Private planning", 2);
    const outcome = await handleInbound(deps(["commitments"]), {
      principalId: id,
      handle: handles.get("w45-nocal")!,
      text: "it happened",
    });
    expect(outcome.replied).toBe(true);
    const row = await db.pool.query(
      "SELECT occurrence FROM calendar_events WHERE summary = 'Private planning'",
    );
    expect(row.rows[0].occurrence).toBe("scheduled_past_unverified");
  });

  it("occurrence ambiguity clarifies with titles, never guesses", async () => {
    const id = await setup("w45-amb", 3);
    await seedPastUnverifiedEvent("Dentist", 2);
    await seedPastUnverifiedEvent("Standup", 5);
    const outcome = await handleInbound(deps(["calendar"]), {
      principalId: id,
      handle: handles.get("w45-amb")!,
      text: "that happened",
    });
    expect(outcome.replied).toBe(true);
    const reply = await db.pool.query(
      `SELECT payload->>'content' AS c FROM notifications WHERE kind='reply' AND payload->>'content' LIKE 'Which one?%'`,
    );
    expect(reply.rows.length).toBeGreaterThanOrEqual(1);
    const still = await db.pool.query(
      "SELECT count(*)::int AS n FROM calendar_events WHERE summary IN ('Dentist', 'Standup') AND occurrence = 'observed_occurred'",
    );
    expect(still.rows[0].n).toBe(0);
  });

  it("commitment verb 'done' with one open commitment applies it (met) + audit", async () => {
    const id = await setup("w45-com", 4);
    const sourceEvent = await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, recorded_at, payload, idempotency_key, domain_id, sensitivity, schema_version)
       VALUES (gen_random_uuid(), 'memory.captured', 'test', now(), now(), '{}', $1, $2::uuid, 'normal', 1) RETURNING id`,
      [`w45-com-${Math.random()}`, domainId],
    );
    const commitment = await db.pool.query(
      `INSERT INTO commitments (domain_id, direction, description, counterparty_text, status, confidence, source_event_id, created_at, updated_at)
       VALUES ($1::uuid, 'owes_me', 'Confirm venue by Friday', 'Henna', 'open', 1.0, $2::uuid, now(), now()) RETURNING id`,
      [domainId, sourceEvent.rows[0].id],
    );
    const outcome = await handleInbound(deps(["commitments"]), {
      principalId: id,
      handle: handles.get("w45-com")!,
      text: "done",
    });
    expect(outcome.replied).toBe(true);
    const row = await db.pool.query("SELECT status FROM commitments WHERE id = $1::uuid", [
      commitment.rows[0].id,
    ]);
    expect(row.rows[0].status).toBe("met");
  });

  it("profile propose → 'yes, keep it' persists a versioned profile for the personas principal", async () => {
    const id = await setup("josctl", 5);
    const propose = await handleInbound(deps(["calendar"]), {
      principalId: id,
      handle: handles.get("josctl")!,
      text: "always call me Chief",
    });
    expect(propose.replied).toBe(true);
    const confirm = await handleInbound(deps(["calendar"]), {
      principalId: id,
      handle: handles.get("josctl")!,
      text: "yes, keep it",
    });
    expect(confirm.replied).toBe(true);
    const profiles = await db.pool.query(
      "SELECT definition->'address'->>'ownerName' AS owner, created_via, version FROM interaction_profiles WHERE principal_id = $1::uuid ORDER BY version",
      [id],
    );
    expect(profiles.rows.length).toBe(2); // v1 auto-seed + v2 self-persisted
    expect(profiles.rows[1].owner).toBe("Chief");
    expect(profiles.rows[1].created_via).toBe("self");
    const reply = await db.pool.query(
      `SELECT payload->>'content' AS c FROM notifications WHERE kind='reply' AND payload->>'content' LIKE 'Kept — permanent%'`,
    );
    expect(reply.rows.length).toBe(1);
  });
});
