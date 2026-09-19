// A' spike probe — read-only, runs ONLY under bin/sensor-node (FDA holder)
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import fs from "node:fs";
const out = { identity: process.env.XPC_SERVICE_NAME ?? "interactive" };
const p = `${os.homedir()}/Library/Messages/chat.db`;
out.exists = fs.existsSync(p);
try {
  const files = fs.readdirSync(`${os.homedir()}/Library/Messages`);
  out.readdir = "OK"; out.walPresent = files.includes("chat.db-wal"); out.shmPresent = files.includes("chat.db-shm");
} catch (e) { out.readdir = `${e.code ?? e.message}`; }
try {
  const db = new DatabaseSync(p, { readOnly: true });
  out.open = "OK (mode=ro)";
  out.rows = db.prepare("SELECT count(*) c FROM message").get().c;
  out.journal = db.prepare("PRAGMA journal_mode").get();
  const cols = db.prepare("PRAGMA table_info(message)").all().map(c => c.name);
  out.hasText = cols.includes("text"); out.hasAttributedBody = cols.includes("attributedBody");
  out.maxRowid = db.prepare("SELECT max(rowid) m FROM message").get().m;
  const stats = db.prepare(`SELECT
      count(*) total,
      sum(CASE WHEN text IS NOT NULL AND length(text)>0 THEN 1 ELSE 0 END) with_text,
      sum(CASE WHEN (text IS NULL OR length(text)=0) AND attributedBody IS NOT NULL THEN 1 ELSE 0 END) only_attributed,
      sum(CASE WHEN attributedBody IS NOT NULL THEN 1 ELSE 0 END) with_ab
    FROM (SELECT * FROM message ORDER BY rowid DESC LIMIT 2000)`).get();
  out.recent2000 = stats;
  const ab = db.prepare(`SELECT attributedBody FROM message WHERE attributedBody IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get();
  if (ab) { const b = ab.attributedBody; out.abHeadHex = Buffer.from(b.buffer ?? b).subarray(0, 32).toString("hex"); out.abType = typeof b; }
  db.close();
} catch (e) { out.open = `${e.code ?? ""} ${e.message}`.slice(0, 200); }
console.log(JSON.stringify(out, null, 1));
