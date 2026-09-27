// throwaway judge debug — not committed
process.env.TEST_DATABASE_URL = "postgres://jejo@localhost:5432/jehad";
const { createIsolatedTestDb, dropIsolatedTestDb } = await import("../../packages/db/tests/test-db.js");
const { migrateUp, seedDomains } = await import("@jehad/db");
const db = await createIsolatedTestDb(process.env.TEST_DATABASE_URL!, "jdgdbg");
await migrateUp(db.pool);
await seedDomains(db.pool);
const { readFileSync } = await import("node:fs");
const apiKey = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m)![1]!.trim();
const { createOpenRouterProvider } = await import("@jehad/adapters");
const { ModelEgressPolicyRegistry, callModel, buildVerificationPrompt } = await import("@jehad/core");
const registry = new ModelEgressPolicyRegistry([{ id: "x", domainId: "personal", sensitivity: "normal", allowedProviders: ["openrouter"], allowRemote: false, requireRedaction: false }]);
const real = createOpenRouterProvider({ apiKey });
const p = await db.pool.query("INSERT INTO principals (type,name) VALUES ('user','josctl') RETURNING id");
const pid = String(p.rows[0]!.id);
const d = await db.pool.query("SELECT id FROM domains WHERE key='personal' LIMIT 1");
const run = await db.pool.query(
  `INSERT INTO runs (kind, principal_id, status, intent, domain_id, started_at, ended_at, created_at, updated_at)
   VALUES ('harness', $1::uuid, 'completed', 'judge debug', $2::uuid, now(), now(), now(), now()) RETURNING id`,
  [pid, d.rows[0]!.id],
);
try {
  const out = await callModel({ db: db.pool, provider: real, registry }, {
    domainId: "personal", sensitivity: "normal", provider: "openrouter",
    model: "google/gemini-2.5-flash",
    prompt: buildVerificationPrompt("I set the reminder.", [], "NO DELEGATED WORK EXISTS (canonical work state is empty)"),
    promptVersion: "judge-debug", principalId: pid, surface: "imessage",
    runId: String(run.rows[0]!.id),
  });
  console.log("JUDGE OK:", JSON.stringify(out.result.text.slice(0, 120)));
} catch (err) {
  console.log("JUDGE THREW:", err instanceof Error ? `${err.name}: ${err.message.slice(0, 400)}` : String(err));
}
await dropIsolatedTestDb(process.env.TEST_DATABASE_URL!, db);
process.exit(0);
