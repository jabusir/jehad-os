// chat.db access layer (gateway Phase A — docs/spikes/a-prime-chatdb.md).
//
// READ-ONLY by construction: the database is opened through a `file:` URI
// with `mode=ro` AND DatabaseSync's `readOnly: true` (belt and braces —
// both independently refuse writes). The sensor NEVER writes the Messages
// database; every statement issued here is a SELECT or a PRAGMA read.
//
// Freshness: each open is a new connection, the pattern the A′ spike
// validated (fresh messages appear on a new read-only connection with no
// WAL mutation), so the agent opens per poll cycle.
//
// Health inputs surfaced per snapshot: max(rowid) (cursor math + reset
// detection), the PRAGMA table_info fingerprint over the expected tables
// (schema drift), the file identity dev-inodes (DB replacement), and
// WAL/SHM sidecar presence (a missing WAL pair after steady activity is a
// degraded signal worth a detail line, never a silent nothing).

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type ChatDbErrorCode = "open-failed" | "schema-read-failed";

export class ChatDbError extends Error {
  readonly code: ChatDbErrorCode;
  constructor(code: ChatDbErrorCode, message: string) {
    super(message);
    this.name = "ChatDbError";
    this.code = code;
  }
}

/** Columns the poll query and decoder depend on (PRAGMA table_info names). */
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  message: ["guid", "text", "handle_id", "attributedBody", "service", "is_from_me"],
  handle: ["id", "service"],
};

export interface SchemaCheck {
  /** true iff every required table and column is present. */
  readonly ok: boolean;
  /** Missing requirements as `table.column` strings. */
  readonly missing: readonly string[];
  /** sha256 of the full column layout of the expected tables. */
  readonly fingerprint: string;
}

export interface ChatDbSnapshot {
  readonly maxRowid: number;
  readonly schema: SchemaCheck;
  /** File identity (dev-inodes) — changes when chat.db is replaced. */
  readonly dbGeneration: string;
  readonly walPresent: boolean;
  readonly shmPresent: boolean;
}

export interface ChatMessageRow {
  readonly rowid: number;
  readonly guid: string;
  readonly isFromMe: boolean;
  readonly text: string | null;
  readonly attributedBody: Uint8Array | null;
  readonly service: string | null;
  readonly handleId: string | null;
  readonly handleService: string | null;
}

export interface ChatDbHandle {
  readonly path: string;
  snapshot(): ChatDbSnapshot;
  /** Rows with rowid > afterRowid, ascending, at most `limit`. */
  readBatch(afterRowid: number, limit: number): ChatMessageRow[];
  close(): void;
}

function tableColumns(db: DatabaseSync, table: string): readonly string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly Record<
    string,
    unknown
  >[];
  return rows.map((c) => String(c["name"]));
}

function schemaCheck(db: DatabaseSync): SchemaCheck {
  const layouts: Record<string, readonly string[]> = {};
  const missing: string[] = [];
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    let columns: readonly string[] = [];
    try {
      columns = tableColumns(db, table);
    } catch {
      columns = [];
    }
    layouts[table] = columns;
    for (const column of required) {
      if (!columns.includes(column)) missing.push(`${table}.${column}`);
    }
  }
  return {
    ok: missing.length === 0,
    missing,
    fingerprint: createHash("sha256").update(JSON.stringify(layouts), "utf8").digest("hex"),
  };
}

function fileGeneration(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.dev}-${stat.ino}`;
  } catch {
    return "unknown";
  }
}

function asUint8Array(value: unknown): Uint8Array | null {
  if (!(value instanceof Uint8Array)) return null;
  return value.length > 0 ? value : null;
}

const READ_BATCH_SQL = `
  SELECT m.ROWID AS rowid, m.guid AS guid, m.is_from_me AS is_from_me,
         m.text AS text, m.attributedBody AS attributedBody, m.service AS service,
         h.id AS handle_id, h.service AS handle_service
  FROM message m
  LEFT JOIN handle h ON m.handle_id = h.ROWID
  WHERE m.rowid > ?
  ORDER BY m.rowid ASC
  LIMIT ?
`;

/**
 * Opens chat.db read-only (URI mode=ro + readOnly). Throws ChatDbError
 * (code open-failed) when the file is missing, TCC-denied, or not a
 * database — the caller turns that into health_database=failed, never a
 * crash.
 */
export function openChatDb(path: string): ChatDbHandle {
  const uri = `file:${encodeURIComponent(path)}?mode=ro`;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(uri, { readOnly: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ChatDbError("open-failed", `cannot open ${path} read-only: ${detail}`);
  }

  const snapshot = (): ChatDbSnapshot => {
    try {
      const maxRow = db.prepare("SELECT max(ROWID) AS max_rowid FROM message").get() as
        | { max_rowid: number | null }
        | undefined;
      return {
        maxRowid: maxRow === undefined || maxRow.max_rowid === null ? 0 : Number(maxRow.max_rowid),
        schema: schemaCheck(db),
        dbGeneration: fileGeneration(path),
        walPresent: existsSync(`${path}-wal`),
        shmPresent: existsSync(`${path}-shm`),
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ChatDbError("schema-read-failed", `cannot read schema/cursor facts: ${detail}`);
    }
  };

  const readBatch = (afterRowid: number, limit: number): ChatMessageRow[] => {
    const raw = db.prepare(READ_BATCH_SQL).all(afterRowid, limit) as readonly Record<string, unknown>[];
    return raw.map((r) => ({
      rowid: Number(r["rowid"]),
      guid: typeof r["guid"] === "string" ? r["guid"] : "",
      isFromMe: Number(r["is_from_me"] ?? 0) === 1,
      text: typeof r["text"] === "string" ? r["text"] : null,
      attributedBody: asUint8Array(r["attributedBody"]),
      service: typeof r["service"] === "string" ? r["service"] : null,
      handleId: typeof r["handle_id"] === "string" ? r["handle_id"] : null,
      handleService: typeof r["handle_service"] === "string" ? r["handle_service"] : null,
    }));
  };

  return { path, snapshot, readBatch, close: () => db.close() };
}
