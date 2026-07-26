/**
 * Database bootstrap per docs/data-model.md section 2: WAL, foreign keys,
 * synchronous NORMAL, busy_timeout 5000, forward-only migrations. A single
 * Database instance is the process's one write coordinator; transactions are
 * short and never span network calls.
 */
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations/index.ts";

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export interface Database {
  readonly raw: DatabaseSync;
  transaction<T>(fn: () => T): T;
  close(): void;
}

function applyPragmas(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT;`);

  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  const currentVersion = row?.version ?? 0;

  const knownMax = MIGRATIONS.at(-1)?.version ?? 0;
  if (currentVersion > knownMax) {
    throw new MigrationError(
      `database schema version ${String(currentVersion)} is newer than this build (max ${String(knownMax)}); refusing to open`,
    );
  }

  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      record.run(migration.version, migration.name, Date.now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function openDatabase(path: string): Database {
  const raw = new DatabaseSync(path);
  try {
    applyPragmas(raw);
    runMigrations(raw);
  } catch (error) {
    raw.close();
    throw error;
  }

  let inTransaction = false;
  return {
    raw,
    transaction<T>(fn: () => T): T {
      if (inTransaction) {
        throw new Error("nested transactions are not supported");
      }
      raw.exec("BEGIN IMMEDIATE");
      inTransaction = true;
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        // SQLite may have auto-rolled back (SQLITE_FULL/IOERR); a failing
        // ROLLBACK must not mask the original error.
        try {
          raw.exec("ROLLBACK");
        } catch {
          // already rolled back
        }
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close(): void {
      raw.close();
    },
  };
}
