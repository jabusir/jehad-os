// Fixture chat.db builder for sensor tests (gateway Phase A, Lane D).
//
// Creates a REAL SQLite database in tmp (node:sqlite, WAL mode — the same
// substrate facts the A′ spike validated) with the chat.db columns the
// sensor's poll query touches. Tests NEVER read the real
// ~/Library/Messages/chat.db; attributedBody blobs are produced by the
// Lane A test encoder (test/decoder/stream-encoder.ts), byte-compatible
// with real Apple archives.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeAttributedBody } from "./decoder/stream-encoder.js";

export interface FixtureHandle {
  readonly rowid: number;
  readonly id: string;
  readonly service?: string;
}

export interface FixtureMessage {
  readonly rowid: number;
  readonly guid: string;
  readonly isFromMe: 0 | 1;
  readonly text?: string | null;
  readonly attributedBody?: Uint8Array | string | null;
  readonly handleRowid?: number;
  readonly service?: string | null;
}

export interface FixtureDbOptions {
  readonly handles?: readonly FixtureHandle[];
  readonly messages?: readonly FixtureMessage[];
  /** Build a body-only message blob (text column empty) from plain text. */
  readonly omitAttributedBodyColumn?: boolean;
  /** Touch `-wal`/`-shm` sidecars so db.ts presence checks see them. */
  readonly sidecars?: boolean;
  /** Journal mode of the fixture (default wal — the real chat.db substrate). */
  readonly journal?: "wal" | "delete";
}

export function fixtureDir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Convenience: an encoder-backed attributedBody blob for plain text. */
export function bodyFor(text: string): Uint8Array {
  return encodeAttributedBody({ text });
}

/** A blob that is structurally malformed for the typedstream parser. */
export function malformedBody(): Uint8Array {
  return Uint8Array.from([0x04, 0x0b, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99]);
}

export function createFixtureChatDb(path: string, opts: FixtureDbOptions = {}): string {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=${opts.journal ?? "wal"}`);
  db.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT NOT NULL,
      text TEXT,
      handle_id INTEGER,
      ${opts.omitAttributedBodyColumn ? "" : "attributedBody BLOB,"}
      service TEXT,
      is_from_me INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id TEXT,
      service TEXT
    )
  `);
  const insertHandle = db.prepare("INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)");
  for (const handle of opts.handles ?? []) {
    insertHandle.run(handle.rowid, handle.id, handle.service ?? "iMessage");
  }
  const insertMessage = opts.omitAttributedBodyColumn
    ? db.prepare(
        "INSERT INTO message (ROWID, guid, text, handle_id, service, is_from_me) VALUES (?, ?, ?, ?, ?, ?)",
      )
    : db.prepare(
        "INSERT INTO message (ROWID, guid, text, handle_id, attributedBody, service, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
  for (const message of opts.messages ?? []) {
    const blob =
      message.attributedBody === undefined || message.attributedBody === null
        ? null
        : typeof message.attributedBody === "string"
          ? bodyFor(message.attributedBody)
          : message.attributedBody;
    if (opts.omitAttributedBodyColumn) {
      insertMessage.run(
        message.rowid,
        message.guid,
        message.text ?? null,
        message.handleRowid === undefined ? null : message.handleRowid,
        message.service ?? null,
        message.isFromMe,
      );
    } else {
      insertMessage.run(
        message.rowid,
        message.guid,
        message.text ?? null,
        message.handleRowid === undefined ? null : message.handleRowid,
        blob,
        message.service ?? null,
        message.isFromMe,
      );
    }
  }
  db.close();
  if (opts.sidecars) {
    writeFileSync(`${path}-wal`, new Uint8Array(0));
    writeFileSync(`${path}-shm`, new Uint8Array(0));
  }
  return path;
}
