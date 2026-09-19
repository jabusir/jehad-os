// db.ts tests — read-only chat.db access layer (fixture DBs only; the real
// ~/Library/Messages is never touched by tests).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { ChatDbError, openChatDb } from "../src/db.js";
import { bodyFor, createFixtureChatDb, fixtureDir } from "./fixture-db.js";

const root = mkdtempSync(join(tmpdir(), "imessage-sensor-db-test-"));
afterAll(() => {
  // tmpdir cleanup is the OS's job; fixture DBs live under this root only.
});

const dbPath = createFixtureChatDb(join(fixtureDir(root, "main"), "chat.db"), {
  handles: [{ rowid: 1, id: "+15550000001" }, { rowid: 2, id: "owner@icloud.example" }],
  messages: [
    { rowid: 10, guid: "guid-10", isFromMe: 0, text: "hello there", handleRowid: 1 },
    {
      rowid: 11,
      guid: "guid-11",
      isFromMe: 1,
      text: null,
      attributedBody: bodyFor("Morning brief\nLINE ONE\nLINE TWO"),
      handleRowid: 1,
    },
    { rowid: 12, guid: "guid-12", isFromMe: 0, text: null, attributedBody: null, handleRowid: 2 },
  ],
});

describe("openChatDb", () => {
  it("opens read-only (URI mode=ro + readOnly) and NEVER allows writes", () => {
    const chat = openChatDb(dbPath);
    try {
      const ro = new DatabaseSync(`file:${encodeURIComponent(dbPath)}?mode=ro`, { readOnly: true });
      expect(() => ro.exec("INSERT INTO message (guid) VALUES ('x')")).toThrow(/readonly/);
      ro.close();
    } finally {
      chat.close();
    }
  });

  it("reads rows with the handle join; booleans and blobs normalized", () => {
    const chat = openChatDb(dbPath);
    try {
      const rows = chat.readBatch(0, 100);
      expect(rows.map((r) => r.rowid)).toEqual([10, 11, 12]);
      expect(rows[0]).toMatchObject({
        guid: "guid-10",
        isFromMe: false,
        text: "hello there",
        handleId: "+15550000001",
        handleService: "iMessage",
      });
      expect(rows[1]!.isFromMe).toBe(true);
      expect(rows[1]!.text).toBeNull();
      expect(rows[1]!.attributedBody).toBeInstanceOf(Uint8Array);
      expect(rows[1]!.attributedBody!.length).toBeGreaterThan(0);
      expect(rows[2]!.attributedBody).toBeNull();
    } finally {
      chat.close();
    }
  });

  it("respects the afterRowid cursor and the limit", () => {
    const chat = openChatDb(dbPath);
    try {
      expect(chat.readBatch(10, 100).map((r) => r.rowid)).toEqual([11, 12]);
      expect(chat.readBatch(10, 1).map((r) => r.rowid)).toEqual([11]);
      expect(chat.readBatch(12, 100)).toEqual([]);
    } finally {
      chat.close();
    }
  });

  it("snapshot: maxRowid, schema ok + stable fingerprint, WAL/SHM detection, db generation", () => {
    const withSidecars = createFixtureChatDb(join(fixtureDir(root, "sidecars"), "chat.db"), {
      sidecars: true,
      messages: [{ rowid: 3, guid: "g3", isFromMe: 0, text: "x" }],
    });
    // A rollback-journal fixture has no sidecars at all (absence detection).
    const noSidecars = createFixtureChatDb(join(fixtureDir(root, "nosidecars"), "chat.db"), {
      journal: "delete",
      messages: [{ rowid: 3, guid: "g3", isFromMe: 0, text: "x" }],
    });
    const a = openChatDb(dbPath);
    const b = openChatDb(dbPath);
    const c = openChatDb(withSidecars);
    const d = openChatDb(noSidecars);
    try {
      const sa = a.snapshot();
      const sb = b.snapshot();
      expect(sa.maxRowid).toBe(12);
      expect(sa.schema.ok).toBe(true);
      expect(sa.schema.missing).toEqual([]);
      expect(sa.schema.fingerprint).toBe(sb.schema.fingerprint);
      expect(sa.schema.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      // A WAL fixture materializes its sidecars (a ro open touches -shm).
      expect(sa.walPresent || sa.shmPresent).toBe(true);
      expect(sa.dbGeneration).toMatch(/^-?\d+-\d+$/);
      const sc = c.snapshot();
      expect(sc.walPresent).toBe(true);
      expect(sc.shmPresent).toBe(true);
      expect(sc.dbGeneration).not.toBe(sa.dbGeneration);
      const sd = d.snapshot();
      expect(sd.walPresent).toBe(false);
      expect(sd.shmPresent).toBe(false);
    } finally {
      a.close();
      b.close();
      c.close();
      d.close();
    }
  });

  it("flags missing expected tables/columns via the PRAGMA fingerprint (schema not ok)", () => {
    const drifted = createFixtureChatDb(join(fixtureDir(root, "drifted"), "chat.db"), {
      omitAttributedBodyColumn: true,
      messages: [{ rowid: 1, guid: "g1", isFromMe: 0, text: "x" }],
    });
    const chat = openChatDb(drifted);
    try {
      const snapshot = chat.snapshot();
      expect(snapshot.schema.ok).toBe(false);
      expect(snapshot.schema.missing).toEqual(["message.attributedBody"]);
    } finally {
      chat.close();
    }
  });

  it("open failure (missing file) → ChatDbError open-failed, never a crash", () => {
    expect(() => openChatDb(join(root, "does-not-exist", "chat.db"))).toThrow(ChatDbError);
    try {
      openChatDb(join(root, "does-not-exist", "chat.db"));
    } catch (err) {
      expect((err as ChatDbError).code).toBe("open-failed");
    }
  });

  it("empty message table → maxRowid 0", () => {
    const empty = createFixtureChatDb(join(fixtureDir(root, "empty"), "chat.db"), {});
    const chat = openChatDb(empty);
    try {
      expect(chat.snapshot().maxRowid).toBe(0);
    } finally {
      chat.close();
    }
  });
});
