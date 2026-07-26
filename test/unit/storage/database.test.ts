import { describe, expect, it } from "vitest";
import { openDatabase, MigrationError } from "../../../src/storage/database.ts";
import { MIGRATIONS } from "../../../src/storage/migrations/index.ts";
import { openTestDb } from "./helpers.ts";

describe("openDatabase", () => {
  it("applies the documented pragmas", () => {
    const t = openTestDb();
    try {
      const journal = t.db.raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(journal.journal_mode).toBe("wal");
      const fk = t.db.raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(fk.foreign_keys).toBe(1);
      const busy = t.db.raw.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      expect(busy.timeout).toBe(5000);
      const sync = t.db.raw.prepare("PRAGMA synchronous").get() as { synchronous: number };
      expect(sync.synchronous).toBe(1);
    } finally {
      t.dispose();
    }
  });

  it("records migrations and re-opens idempotently", () => {
    const t = openTestDb();
    try {
      const rows = t.db.raw
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all() as unknown as { version: number; name: string }[];
      expect(rows).toHaveLength(MIGRATIONS.length);
      expect(rows[0]).toMatchObject({ version: 1, name: "initial-schema" });

      t.db.close();
      const reopened = openDatabase(t.path);
      const again = reopened.raw
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get() as { count: number };
      reopened.close();
      expect(again.count).toBe(MIGRATIONS.length);
    } finally {
      t.dispose();
    }
  });

  it("refuses to open a database from a newer build", () => {
    const t = openTestDb();
    try {
      t.db.raw
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'future', 0)")
        .run();
      t.db.close();
      expect(() => openDatabase(t.path)).toThrow(MigrationError);
    } finally {
      t.dispose();
    }
  });

  it("rolls back a failed transaction completely", () => {
    const t = openTestDb();
    try {
      expect(() =>
        t.db.transaction(() => {
          t.db.raw
            .prepare(
              "INSERT INTO runtime_state (key, value_json, updated_at) VALUES ('a', '1', 0)",
            )
            .run();
          throw new Error("boom");
        }),
      ).toThrow("boom");
      const row = t.db.raw.prepare("SELECT * FROM runtime_state WHERE key = 'a'").get();
      expect(row).toBeUndefined();
    } finally {
      t.dispose();
    }
  });

  it("rejects nested transactions", () => {
    const t = openTestDb();
    try {
      expect(() =>
        t.db.transaction(() => t.db.transaction(() => 1)),
      ).toThrow("nested");
    } finally {
      t.dispose();
    }
  });

  it("stays usable after BEGIN itself fails", () => {
    const t = openTestDb();
    try {
      t.db.raw.exec("BEGIN");
      expect(() => t.db.transaction(() => 1)).toThrow();
      t.db.raw.exec("ROLLBACK");
      expect(t.db.transaction(() => 42)).toBe(42);
    } finally {
      t.dispose();
    }
  });
});
