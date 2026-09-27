const { readFileSync } = await import("node:fs");
const { createOpenRouterProvider } = await import("@jehad/adapters");
const { ModelEgressPolicyRegistry, callModel, buildVerificationPrompt, parseVerificationVerdict } = await import("@jehad/core");
const { createIsolatedTestDb, dropIsolatedTestDb } = await import("../../packages/db/tests/test-db.js");
const { migrateUp, seedDomains } = await import("@jehad/db");
const db = await createIsolatedTestDb("postgres://jejo@localhost:5432/jehad", "jdg2");
await migrateUp(db.pool); await seedDomains(db.pool);
const apiKey = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m)![1]!.trim();
const registry = new ModelEgressPolicyRegistry([{ id: "x", domainId: "personal", sensitivity: "normal", allowedProviders: ["openrouter"], allowRemote: false, requireRedaction: false }]);
const real = createOpenRouterProvider({ apiKey });
const p = await db.pool.query("INSERT INTO principals (type,name) VALUES ('user','josctl') RETURNING id");
const d = await db.pool.query("SELECT id FROM domains WHERE key='personal' LIMIT 1");
const run = await db.pool.query(`INSERT INTO runs (kind, principal_id, status, intent, domain_id, started_at, ended_at, created_at, updated_at) VALUES ('harness', $1::uuid, 'completed', 'x', $2::uuid, now(), now(), now(), now()) RETURNING id`, [p.rows[0]!.id, d.rows[0]!.id]);
const prompt = buildVerificationPrompt(
  "You have two open to-dos: call the florist, and seating chart. Neither has a due date.",
  [],
  "NO DELEGATED WORK EXISTS (canonical work state is empty)",
  "Today is Friday, September 25, 2026 (America/Los_Angeles).",
  'commitments.waiting (coverage: all open commitments): {"overdueCount":0,"overdue":[],"dueSoonCount":0,"dueSoon":[],"otherOpenCount":2,"open":[{"description":"call the florist"},{"description":"seating chart"}],"openTruncated":false}',
);
for (let i = 0; i < 3; i++) {
  const out = await callModel({ db: db.pool, provider: real, registry }, {
    domainId: "personal", sensitivity: "normal", provider: "openrouter", model: "openai/gpt-4.1",
    prompt, promptVersion: "dbg", principalId: String(p.rows[0]!.id), surface: "imessage", runId: String(run.rows[0]!.id),
  });
  console.log(i, "->", out.result.text.slice(0, 160));
}
await dropIsolatedTestDb("postgres://jejo@localhost:5432/jehad", db);
process.exit(0);
