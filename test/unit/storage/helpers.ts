import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "../../../src/storage/database.ts";
import { createStorage, type Storage } from "../../../src/storage/index.ts";
import type { ConversationIdentity } from "../../../src/storage/repositories/conversations.ts";
import type { IncomingMessage } from "../../../src/storage/repositories/messages.ts";

export interface TestDb {
  db: Database;
  storage: Storage;
  dir: string;
  path: string;
  dispose(): void;
}

export function openTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "qqmon-db-"));
  const path = join(dir, "test.db");
  const db = openDatabase(path);
  return {
    db,
    storage: createStorage(db),
    dir,
    path,
    dispose() {
      try {
        db.close();
      } catch {
        // already closed by the test
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function groupConversation(sourceId = "123456789"): ConversationIdentity {
  return {
    selfUin: "10001",
    type: "group",
    sourceId,
    displayName: "test group",
    summaryEnabled: true,
  };
}

export function incomingMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    sourceMessageId: "src-1",
    sourceTimestamp: 1_700_000_000_000,
    senderUin: "20002",
    senderName: "sender",
    isOwner: false,
    direction: "in",
    segmentsJson: '[{"type":"text","data":{"text":"hi"}}]',
    projection: "hi",
    ...overrides,
  };
}

export function countRows(db: Database, table: string): number {
  const row = db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}
