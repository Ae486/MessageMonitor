/**
 * v1 schema per docs/data-model.md. Circular FKs (messages <-> summary_units)
 * are legal in SQLite because FK existence is checked at DML time, not DDL.
 * feed_events enforces the kind/entity pairing with a CHECK so no code path
 * can create a mismatched row.
 */
import type { DatabaseSync } from "node:sqlite";

export function up(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE runtime_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  self_uin TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('group', 'friend')),
  source_id TEXT NOT NULL,
  display_name TEXT,
  capture_enabled INTEGER NOT NULL CHECK (capture_enabled IN (0, 1)),
  summary_enabled INTEGER NOT NULL CHECK (summary_enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (self_uin, type, source_id)
) STRICT;

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  source_message_id TEXT NOT NULL,
  source_sequence TEXT,
  source_timestamp INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  sender_uin TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  is_owner INTEGER NOT NULL CHECK (is_owner IN (0, 1)),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  summary_unit_id INTEGER REFERENCES summary_units(id),
  segments_json TEXT,
  projection TEXT,
  recalled_at INTEGER,
  recall_operator_uin TEXT,
  content_expired_at INTEGER,
  UNIQUE (conversation_id, source_message_id)
) STRICT;

CREATE INDEX messages_conversation_id_id ON messages(conversation_id, id);
CREATE INDEX messages_unassigned ON messages(conversation_id, summary_unit_id, id);
CREATE INDEX messages_conversation_time ON messages(conversation_id, source_timestamp, id);
CREATE INDEX messages_ingested_at ON messages(ingested_at);

CREATE TABLE bridge_checkpoints (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id),
  last_source_message_id TEXT,
  last_source_sequence TEXT,
  last_source_timestamp INTEGER,
  last_committed_message_id INTEGER REFERENCES messages(id),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE capture_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES conversations(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  recovery_attempted INTEGER NOT NULL CHECK (recovery_attempted IN (0, 1)),
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX capture_gaps_conversation_started ON capture_gaps(conversation_id, started_at);
CREATE INDEX capture_gaps_resolved ON capture_gaps(resolved_at);

CREATE TABLE summary_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  start_message_id INTEGER NOT NULL REFERENCES messages(id),
  end_message_id INTEGER NOT NULL REFERENCES messages(id),
  preceding_unit_id INTEGER REFERENCES summary_units(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  message_count INTEGER NOT NULL,
  summary_text TEXT,
  schema_hash TEXT NOT NULL,
  schema_snapshot_json TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  contains_recalled_messages INTEGER NOT NULL CHECK (contains_recalled_messages IN (0, 1)),
  source_available INTEGER NOT NULL CHECK (source_available IN (0, 1)),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  CHECK (start_message_id <= end_message_id),
  UNIQUE (conversation_id, start_message_id, end_message_id)
) STRICT;

CREATE TABLE summary_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_unit_id INTEGER NOT NULL REFERENCES summary_units(id) ON DELETE CASCADE,
  dimension_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  UNIQUE (summary_unit_id, dimension_key, ordinal)
) STRICT;

CREATE TABLE summary_finding_messages (
  summary_finding_id INTEGER NOT NULL REFERENCES summary_findings(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  PRIMARY KEY (summary_finding_id, message_id)
) STRICT;

CREATE TABLE feed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  kind TEXT NOT NULL CHECK (kind IN ('message', 'summary_completed', 'summary_failed', 'capture_gap', 'recall')),
  message_id INTEGER REFERENCES messages(id),
  summary_unit_id INTEGER REFERENCES summary_units(id),
  capture_gap_id INTEGER REFERENCES capture_gaps(id),
  occurred_at INTEGER NOT NULL,
  CHECK (
    (kind IN ('message', 'recall')
      AND message_id IS NOT NULL AND summary_unit_id IS NULL AND capture_gap_id IS NULL)
    OR (kind IN ('summary_completed', 'summary_failed')
      AND summary_unit_id IS NOT NULL AND message_id IS NULL AND capture_gap_id IS NULL)
    OR (kind = 'capture_gap'
      AND capture_gap_id IS NOT NULL AND message_id IS NULL AND summary_unit_id IS NULL)
  )
) STRICT;

CREATE INDEX feed_events_conversation_id ON feed_events(conversation_id, id);

CREATE TABLE feed_progress (
  consumer_id TEXT PRIMARY KEY,
  last_feed_event_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE conversation_read_progress (
  consumer_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  last_message_id INTEGER NOT NULL REFERENCES messages(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (consumer_id, conversation_id)
) STRICT;

-- O(1) row counts for the status tool: requirements 3.2 forbids scanning the
-- full messages table, and SQLite COUNT(*) walks every leaf page.
CREATE TABLE table_counters (
  name TEXT PRIMARY KEY,
  count INTEGER NOT NULL
) STRICT;
INSERT INTO table_counters (name, count) VALUES ('messages', 0), ('summary_units', 0);

CREATE TRIGGER messages_counter_insert AFTER INSERT ON messages
BEGIN UPDATE table_counters SET count = count + 1 WHERE name = 'messages'; END;
CREATE TRIGGER messages_counter_delete AFTER DELETE ON messages
BEGIN UPDATE table_counters SET count = count - 1 WHERE name = 'messages'; END;
CREATE TRIGGER summary_units_counter_insert AFTER INSERT ON summary_units
BEGIN UPDATE table_counters SET count = count + 1 WHERE name = 'summary_units'; END;
CREATE TRIGGER summary_units_counter_delete AFTER DELETE ON summary_units
BEGIN UPDATE table_counters SET count = count - 1 WHERE name = 'summary_units'; END;
`);
}
