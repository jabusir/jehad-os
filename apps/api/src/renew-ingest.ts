import { issueGrant } from "@jehad/core";
import { Pool } from "pg";

const pool = new Pool({ connectionString: "postgres://localhost:5432/jehad" });
const domain = (await pool.query("SELECT id FROM domains WHERE key = $1", ["personal"])).rows[0].id;
const harness = (
  await pool.query("SELECT id FROM principals WHERE name = $1", ["imessage-sensor"])
).rows[0].id;
const ttlMs = 7 * 24 * 60 * 60 * 1000;
const { grant } = await issueGrant(pool, {
  principalId: harness,
  runId: null,
  capability: "imessage:ingest",
  resource: "imessage",
  domainId: domain,
  ttlMs,
});
console.log(`renewed imessage:ingest -> expires ${grant.expiresAt.toISOString()}`);
await pool.end();
