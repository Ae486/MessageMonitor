import type { Database } from "../database.ts";

/** Small global scalars only (monitoring baseline, timestamps) — never collections. */
export interface RuntimeStateRepo {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown, now: number): void;
}

export function createRuntimeStateRepo(db: Database): RuntimeStateRepo {
  const select = db.raw.prepare("SELECT value_json FROM runtime_state WHERE key = ?");
  const upsert = db.raw.prepare(`
    INSERT INTO runtime_state (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `);

  return {
    get<T>(key: string): T | undefined {
      const row = select.get(key) as { value_json: string } | undefined;
      if (row === undefined) return undefined;
      return JSON.parse(row.value_json) as T;
    },
    set(key, value, now) {
      upsert.run(key, JSON.stringify(value), now);
    },
  };
}
