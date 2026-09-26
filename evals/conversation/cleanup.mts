// One-off owner-authorized data repair (§24 F5): close the 6 wedding-prep
// commitments the owner reported complete 2026-09-24 20:42, and the legacy
// artifact row. Canonical transitions only (auditable, reversible-in-intent).
import { applyCommitmentTransition } from "@jehad/core";
import pg from "pg";
const pool = new pg.Pool({ connectionString: "postgres://jejo@localhost:5432/jehad" });
const rows = (await pool.query(`SELECT id, description FROM commitments WHERE status='open' ORDER BY created_at`)).rows;
for (const row of rows) {
  const artifact = row.description === "Mark seating chart as done";
  const r = await applyCommitmentTransition(pool, {
    commitmentId: String(row.id),
    verb: "done",
    note: artifact
      ? "void artifact: legacy lane minted a commitment whose content was closing another commitment"
      : "owner reported complete 2026-09-24 20:42 (wedding prep); closed in §24 F5 data repair 2026-09-26",
    principalId: "66a33582-e749-472b-832c-dc38a3d3a74f",
    now: () => new Date(),
  });
  console.log(row.description, "->", r.applied ? r.toStatus : `NOT applied (${r.reason})`);
}
await pool.end();
