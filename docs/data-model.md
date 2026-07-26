# SQLite 数据模型

## 1. 状态

本文定义第一版逻辑 Schema 和必须保持的约束。仓库尚无迁移代码；实际 DDL 可在实现时调整字段命名，但不得改变本文描述的身份、边界、幂等和清理语义。

## 2. SQLite 设置

每次连接必须执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

服务使用一个写协调器和短事务。摘要网络请求不得占用数据库事务。

## 3. 表关系

```text
conversations
  ├─ messages
  ├─ bridge_checkpoints
  ├─ capture_gaps
  ├─ summary_units
  │    └─ summary_findings
  │          └─ summary_finding_messages ─→ messages
  ├─ feed_events
  └─ conversation_read_progress

feed_progress ─→ feed_events
runtime_state
schema_migrations
```

## 4. 表定义

### 4.1 `schema_migrations`

| 字段 | 类型 | 约束 |
|---|---|---|
| `version` | INTEGER | PRIMARY KEY |
| `name` | TEXT | NOT NULL |
| `applied_at` | INTEGER | NOT NULL |

迁移只允许向前执行。破坏性迁移必须先提供备份和回滚说明。

### 4.2 `runtime_state`

| 字段 | 类型 | 约束 |
|---|---|---|
| `key` | TEXT | PRIMARY KEY |
| `value_json` | TEXT | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

只保存少量全局状态，例如 Monitoring Baseline、最后连接/断开时间和清理时间。业务集合不得塞入该表。

### 4.3 `conversations`

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `self_uin` | TEXT | NOT NULL |
| `type` | TEXT | `group | friend` |
| `source_id` | TEXT | NOT NULL，群号或好友 QQ 号 |
| `display_name` | TEXT | NULLABLE |
| `capture_enabled` | INTEGER | NOT NULL，0/1 |
| `summary_enabled` | INTEGER | NOT NULL，0/1 |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

唯一约束：

```sql
UNIQUE (self_uin, type, source_id)
```

配置移除会话时保留行并设置 `capture_enabled=0`，不因此删除历史数据。

好友会话的 `source_id` 固定为对端好友 QQ 号。`display_name` 可以随新事件更新，但 `messages.sender_name` 是消息发生时快照。

### 4.4 `messages`

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT，本地顺序 |
| `conversation_id` | INTEGER | NOT NULL，FK conversations |
| `source_message_id` | TEXT | NOT NULL，OneBot 消息 ID |
| `source_sequence` | TEXT | NULLABLE，桥接提供时保存 |
| `source_timestamp` | INTEGER | NOT NULL |
| `ingested_at` | INTEGER | NOT NULL |
| `sender_uin` | TEXT | NOT NULL |
| `sender_name` | TEXT | NOT NULL |
| `is_owner` | INTEGER | NOT NULL，0/1 |
| `direction` | TEXT | `in | out` |
| `summary_unit_id` | INTEGER | NULLABLE，FK summary_units；一个消息最多属于一个单元 |
| `segments_json` | TEXT | NULLABLE，结构化消息段 |
| `projection` | TEXT | NULLABLE，Message Projection |
| `recalled_at` | INTEGER | NULLABLE |
| `recall_operator_uin` | TEXT | NULLABLE |
| `content_expired_at` | INTEGER | NULLABLE |

幂等约束：

```sql
UNIQUE (conversation_id, source_message_id)
```

核心索引：

```sql
INDEX messages_conversation_id_id (conversation_id, id)
INDEX messages_unassigned (conversation_id, summary_unit_id, id)
INDEX messages_conversation_time (conversation_id, source_timestamp, id)
INDEX messages_ingested_at (ingested_at)
```

`segments_json` 和 `projection` 清空表示内容过期；消息元数据行仍可保留，用于摘要边界和证据引用。

### 4.5 `bridge_checkpoints`

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `conversation_id` | INTEGER | PRIMARY KEY，FK conversations |
| `last_source_message_id` | TEXT | NULLABLE |
| `last_source_sequence` | TEXT | NULLABLE |
| `last_source_timestamp` | INTEGER | NULLABLE |
| `last_committed_message_id` | INTEGER | NULLABLE，FK messages |
| `updated_at` | INTEGER | NOT NULL |

该表只表示恢复起点，不表示消息已读。

### 4.6 `capture_gaps`

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `conversation_id` | INTEGER | NULLABLE；NULL 表示账号级缺口 |
| `started_at` | INTEGER | NOT NULL |
| `ended_at` | INTEGER | NOT NULL |
| `reason_code` | TEXT | NOT NULL |
| `details_json` | TEXT | NOT NULL，默认 `{}` |
| `recovery_attempted` | INTEGER | NOT NULL，0/1 |
| `resolved_at` | INTEGER | NULLABLE |
| `created_at` | INTEGER | NOT NULL |

索引：`(conversation_id, started_at)`、`(resolved_at)`。

### 4.7 `summary_units`

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `conversation_id` | INTEGER | NOT NULL，FK conversations |
| `start_message_id` | INTEGER | NOT NULL，FK messages |
| `end_message_id` | INTEGER | NOT NULL，FK messages |
| `preceding_unit_id` | INTEGER | NULLABLE，FK summary_units |
| `status` | TEXT | `queued | running | completed | failed` |
| `message_count` | INTEGER | NOT NULL |
| `summary_text` | TEXT | NULLABLE |
| `schema_hash` | TEXT | NOT NULL |
| `schema_snapshot_json` | TEXT | NOT NULL |
| `retry_count` | INTEGER | NOT NULL，默认 0 |
| `last_error_code` | TEXT | NULLABLE |
| `last_error_message` | TEXT | NULLABLE，需脱敏 |
| `contains_recalled_messages` | INTEGER | NOT NULL，0/1 |
| `source_available` | INTEGER | NOT NULL，0/1 |
| `created_at` | INTEGER | NOT NULL |
| `started_at` | INTEGER | NULLABLE |
| `completed_at` | INTEGER | NULLABLE |

约束：

```sql
CHECK (start_message_id <= end_message_id)
UNIQUE (conversation_id, start_message_id, end_message_id)
```

同一会话中单元区间不得重叠。创建单元和设置 `messages.summary_unit_id` 必须在同一事务中完成；已经归属单元的消息不得再次分配。

### 4.8 `summary_findings`

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `summary_unit_id` | INTEGER | NOT NULL，FK summary_units ON DELETE CASCADE |
| `dimension_key` | TEXT | NOT NULL |
| `ordinal` | INTEGER | NOT NULL，从 0 开始 |
| `text` | TEXT | NOT NULL |

唯一约束：

```sql
UNIQUE (summary_unit_id, dimension_key, ordinal)
```

### 4.9 `summary_finding_messages`

| 字段 | 类型 | 约束 |
|---|---|---|
| `summary_finding_id` | INTEGER | FK summary_findings ON DELETE CASCADE |
| `message_id` | INTEGER | FK messages ON DELETE RESTRICT |

主键：

```sql
PRIMARY KEY (summary_finding_id, message_id)
```

每个关联消息必须位于 Finding 所属 Summary Unit 的冻结边界内。该约束由事务代码验证。

### 4.10 `feed_events`

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT，全局 Feed 顺序 |
| `conversation_id` | INTEGER | NOT NULL，FK conversations |
| `kind` | TEXT | `message | summary_completed | summary_failed | capture_gap | recall` |
| `message_id` | INTEGER | NULLABLE，FK messages |
| `summary_unit_id` | INTEGER | NULLABLE，FK summary_units |
| `capture_gap_id` | INTEGER | NULLABLE，FK capture_gaps |
| `occurred_at` | INTEGER | NOT NULL |

每行必须且只能引用与 `kind` 对应的实体。消息幂等插入未发生时不得重复创建 Feed 事件。第一版只产生 `message | summary_completed | summary_failed | recall`；`capture_gap` 保留给未来的会话级缺口，账号级缺口不写 Feed。

索引：`(id)`、`(conversation_id, id)`。

### 4.11 `feed_progress`

| 字段 | 类型 | 约束 |
|---|---|---|
| `consumer_id` | TEXT | PRIMARY KEY |
| `last_feed_event_id` | INTEGER | NOT NULL，默认 0 |
| `updated_at` | INTEGER | NOT NULL |

`qq_feed_pull` 的结果范围和进度推进应在同一事务内确定。

### 4.12 `conversation_read_progress`

| 字段 | 类型 | 约束 |
|---|---|---|
| `consumer_id` | TEXT | NOT NULL |
| `conversation_id` | INTEGER | NOT NULL，FK conversations |
| `last_message_id` | INTEGER | NOT NULL，FK messages |
| `updated_at` | INTEGER | NOT NULL |

主键：

```sql
PRIMARY KEY (consumer_id, conversation_id)
```

进度只允许单调前进。定点引用查询不得更新该表。

## 5. 短引用编码

短引用不需要独立映射表：

```text
qqc_  + base36(conversations.id)
qqm_  + base36(messages.id)
qqsu_ + base36(summary_units.id)
qqsf_ + base36(summary_findings.id)
```

解析时必须校验前缀、base36 合法性、资源存在和目标账号隔离。工具不得接受任意 SQL ID 类型混用。

## 6. 关键事务

### 6.1 消息写入

```text
BEGIN IMMEDIATE
  upsert conversation metadata
  insert message or detect duplicate
  update checkpoint
  if inserted: insert feed event
COMMIT
```

### 6.2 摘要冻结

```text
BEGIN IMMEDIATE
  verify no running/queued unit for conversation
  select all unassigned messages through current high-water mark
  insert summary unit with fixed boundaries and schema snapshot
  assign selected messages to unit
COMMIT
```

模型调用在事务外执行。

### 6.3 摘要完成

```text
BEGIN IMMEDIATE
  verify unit remains running and boundary unchanged
  validate every evidence message belongs to unit
  update summary unit
  insert findings and evidence links
  insert summary_completed feed event
COMMIT
```

### 6.4 一键已读

```text
BEGIN IMMEDIATE
  freeze latest committed message ID for conversation
  monotonically update conversation read progress
COMMIT
```

调用期间新提交的消息位于冻结截止点之后，保持未读。

## 7. 保留与清理

### 7.1 消息内容到期

- 非摘要消息到期且无证据引用时可删除整行。
- 摘要单元覆盖或 Finding 引用的消息先清空 `segments_json` 和 `projection`，保留身份、时间和边界元数据。
- 设置 `content_expired_at`，并将受影响 Summary Unit 的 `source_available` 更新为 0。

### 7.2 摘要到期

- 删除 Summary Unit 时级联删除 Finding 和 Finding-message 关联。
- 关联解除后，已超过消息保留期的消息元数据可删除。
- 删除旧 Feed 事件前，必须确保其 ID 不大于所有 consumer 的 Feed Progress，并且对应实体已超过保留范围。

### 7.3 清理一致性

- 每次清理使用有上限的批次，避免长事务。
- 清理失败不阻塞采集，状态工具报告维护故障。
- 缩短保留期后的首次清理应记录受影响数量，不记录正文。

## 8. 数据库损坏与备份

- 第一版至少提供启动时 `PRAGMA quick_check` 的可配置或维护入口。
- 迁移前创建数据库副本；运行期备份使用 SQLite backup API，不直接复制活跃 WAL 文件组合。
- 数据库不可写时暂停采集和摘要状态提交，不在内存中无限积压。
- 数据库不可恢复时保留文件用于诊断，禁止自动新建空库覆盖原文件。
