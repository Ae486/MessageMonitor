# MCP 工具契约

## 1. 总则

第一版只暴露三个工具：

```text
qq_monitor_status
qq_feed_pull
qq_read_conversation
```

所有工具只影响 QQ Message Monitor 的本地查询或进度状态，不执行 QQ 侧写操作。QQ 号、群号、消息 ID 和游标在 JSON 中一律使用字符串。

MCP 启动时会将当前 Summary Dimension 的字段名和描述加入工具说明。工具结果使用动态 `sections` 映射，以兼容使用旧 Summary Schema Snapshot 的历史单元。

## 2. 通用引用

| 前缀 | 资源 | 示例 |
|---|---|---|
| `qqc_` | 会话 | `qqc_c` |
| `qqsu_` | Summary Unit | `qqsu_16` |
| `qqsf_` | Summary Finding | `qqsf_3j` |
| `qqm_` | 消息 | `qqm_89e` |

后缀是数据库本地整数 ID 的 base36 表示。引用只在当前数据库内稳定；数据库重建或数据导入后不保证保持一致。

Agent 不需要提交 OneBot `message_id`。Summary Producer 返回的源消息 ID 经校验后只用于建立内部证据关联。

## 3. `qq_monitor_status`

### 3.1 目的

判断 MCP 是否可读取、可采集、是否正在恢复，以及存储和摘要子系统是否健康。

### 3.2 输入

```json
{}
```

无参数、无副作用，不主动重连、探测模型或修改配置。

### 3.3 输出

```json
{
  "lifecycleState": "active",
  "healthState": "healthy",
  "readyForReads": true,
  "readyForCapture": true,
  "account": {
    "targetSelfUin": "14549711115",
    "connectedSelfUin": "14549711115",
    "verified": true
  },
  "bridge": {
    "provider": "llonebot",
    "connected": true,
    "connectedAt": 1785027600000,
    "lastEventAt": 1785027852000,
    "nextReconnectAt": null
  },
  "capture": {
    "monitoringBaseline": 1784500000000,
    "lastMessageAt": 1785027845000,
    "monitoredGroupCount": 3,
    "friendMode": "all",
    "unresolvedGapCount": 0
  },
  "storage": {
    "available": true,
    "messageCount": 12481,
    "summaryUnitCount": 93,
    "messageRetentionDays": 30,
    "summaryRetentionDays": 180,
    "lastCleanupAt": 1785000000000
  },
  "summary": {
    "enabled": true,
    "producerState": "available",
    "threshold": 30,
    "queuedTaskCount": 1,
    "runningTaskCount": 0,
    "failedUnitCount": 2,
    "lastCompletedAt": 1785027000000,
    "schemaHash": "sumcfg_a81f"
  },
  "agentProgress": {
    "pendingFeedConversationCount": 2,
    "unreadConversationCount": 4
  },
  "issues": []
}
```

#### 枚举

- `lifecycleState`: `dormant | verifying | active`（`recovering` 保留给未来的补偿扩展）
- `healthState`: `healthy | degraded`
- `summary.producerState`: `disabled | unknown | available | unavailable`

桥离线（QQ 未启动）是正常 `dormant + healthy`。摘要模型离线通常是 `active + degraded`，采集仍可继续。

`failedUnitCount` 是保留期内统计，不会单独导致永久降级。历史 Capture Gap 也不会让服务永久降级。

#### `issues`

`issues` 数组披露需要主人知晓的异常状况，Agent 应在合适时机转述给主人。每项结构：

```json
{
  "code": "SUMMARY_PRODUCER_UNAVAILABLE",
  "severity": "warning",
  "message": "摘要模型已连续 40 分钟不可达，摘要任务排队中，消息采集不受影响。",
  "since": 1785025000000,
  "count": 5
}
```

| 字段 | 说明 |
|---|---|
| `code` | 稳定枚举：`ACCOUNT_MISMATCH`、`SUMMARY_PRODUCER_UNAVAILABLE`、`SUMMARY_GAP_CREATED`、`STORAGE_DEGRADED`、`MAINTENANCE_FAILED` |
| `severity` | `info | warning | error` |
| `message` | 自然语言描述，可直接转述；不包含 Token、API Key 或绝对路径 |
| `since` | 状况开始或首次发生时间 |
| `count` | 可选聚合计数，如保留期内 Summary Gap 数量 |

`healthState=degraded` 时 `issues` 必须非空并解释原因。摘要单元失败除进入 `issues` 聚合外，同时以 `summary_failed` Feed 更新出现，Agent 在常规 `qq_feed_pull` 中即可发现，无需轮询状态工具。

## 4. `qq_feed_pull`

### 4.1 目的

返回 Feed Progress 之后发生变化的会话索引。它回答“哪些会话有更新以及大致发生了什么”，不表示 Agent 已阅读会话。

### 4.2 输入

```json
{
  "limit": 20
}
```

| 参数 | 类型 | 必填 | 默认 | 约束 |
|---|---|---:|---:|---|
| `limit` | integer | 否 | `20` | `1..100`，最多返回的会话数 |

第一版 consumer 由配置的 `agent.consumerId` 决定，不允许 Agent 任意指定其他 consumer。

### 4.3 更新类型

`updateKinds` 可包含：

- `messages`
- `summary_completed`
- `summary_failed`
- `recall`

账号级 Capture Gap 不产生 Feed 更新，通过 `qq_monitor_status` 的缺口计数和会话读取中的 gap item 披露；`capture_gap` 类型保留给未来的会话级缺口。

摘要完成是独立 Feed 更新，因此允许 `newMessageCount=0`。

### 4.4 输出

```json
{
  "hasUpdates": true,
  "hasMore": false,
  "conversations": [
    {
      "conversationRef": "qqc_c",
      "conversationType": "group",
      "conversationId": "123456789",
      "conversationName": "项目交流群",
      "updateKinds": ["messages", "summary_completed"],
      "newMessageCount": 37,
      "unreadMessageCount": 64,
      "from": 1784563200000,
      "to": 1784566800000,
      "summaryState": "completed",
      "summaryUnits": [
        {
          "ref": "qqsu_16",
          "summaryText": "讨论了周末测试安排和交付时间分歧。",
          "availableDimensions": ["keyPoints", "conflicts"]
        }
      ],
      "summarizingMessageCount": 0,
      "unsummarizedMessageCount": 6
    }
  ]
}
```

`summaryState`：

- `disabled`: 该会话不参与摘要。
- `waiting`: 有未摘要消息但未达到阈值。
- `queued`: 已冻结单元，等待执行。
- `running`: 摘要调用中。
- `completed`: 本次 Feed 包含完成摘要，或当前最近单元已完成。
- `failed`: 本次 Feed 包含 Summary Gap。

`summaryUnits` 只包含本次 Feed 范围中新完成的单元。它返回整体摘要和非空维度名称，不展开完整 `sections`。

### 4.5 进度语义

- 工具成功生成结果时，将 Feed Progress 推进到本次返回事件的截止点。
- `limit` 截断时只推进到已返回范围，下一次调用继续返回剩余更新。
- 分页按每个会话最早的未消费 Feed 事件排序，选取前 `limit` 个会话；截止点停在下一个未选会话的首个事件之前。截止点之后同一会话的新事件留给下一次调用。
- Feed Progress 不改变任何 Conversation Read Progress。
- 调用后 socket/stdio 在极窄窗口内中断时，存在“服务已提交 Feed Progress，但 Agent 未看到结果”的残余可能。该场景不会删除消息；`unreadMessageCount` 和 `scope=unread` 仍可恢复内容。第一版不增加显式 Feed ACK 工具。

## 5. `qq_read_conversation`

### 5.1 目的

统一承担：

- 连续读取会话。
- 最近内容和游标分页。
- 读取完整摘要单元。
- 根据 Summary Finding 查询证据。
- 查看单条消息上下文。
- 单会话一键已读。

### 5.2 操作模式

`operation`：

- `read`，默认值。
- `mark_read`，不返回正文并推进本地阅读进度。

### 5.3 会话读取输入

可以使用会话类型与 ID：

```json
{
  "operation": "read",
  "conversationType": "group",
  "conversationId": "123456789",
  "scope": "unread",
  "view": "auto",
  "limit": 50
}
```

也可以使用 Feed 返回的会话引用：

```json
{
  "operation": "read",
  "reference": "qqc_c",
  "scope": "unread",
  "view": "auto",
  "limit": 50
}
```

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `conversationType` | `group | friend` | 无 | 与 `conversationId` 成对出现 |
| `conversationId` | string | 无 | 群号或好友 QQ 号 |
| `reference` | string | 无 | 与类型/ID 二选一 |
| `scope` | `unread | recent | after_cursor` | `unread` | 查询起点 |
| `cursor` | string | 无 | `after_cursor` 时必填 |
| `view` | `auto | summaries | messages | both` | `auto` | 返回内容形态 |
| `limit` | integer | `50` | `1..200` 个逻辑项目 |

#### `view` 规则

好友会话的 `conversationId` 始终是对端好友 QQ 号，与消息方向无关。

- `auto`: 已完成区域使用摘要；未摘要尾部和可恢复的失败区域使用消息；缺失区域使用 gap item。
- `summaries`: 返回摘要单元和缺口，不回退到原始消息。
- `messages`: 返回 Message Projection，不返回摘要。
- `both`: 返回摘要和对应原始消息，用于核验，仍受 `limit` 限制。

#### 阅读进度

- 只有 `scope=unread` 自动推进到实际连续返回的最高消息边界。
- `recent` 和 `after_cursor` 不推进。
- `limit` 截断时不越过未返回内容。
- 返回 Capture Gap 标记后允许越过该已披露区间继续推进。

### 5.4 短引用读取

#### 完整摘要单元

```json
{
  "reference": "qqsu_16"
}
```

默认返回 `summaryText`、Schema Snapshot 和完整动态 `sections`，不自动返回全部原文。需要原文时传 `view=both` 和 `limit`。

#### Finding 证据

```json
{
  "reference": "qqsf_3j",
  "contextRadius": 2
}
```

MCP 解析内部消息关联，返回每条证据及前后上下文，重叠窗口自动合并。

#### 单条消息上下文

```json
{
  "reference": "qqm_89e",
  "contextRadius": 5
}
```

| 参数 | 默认 | 约束 |
|---|---:|---|
| `contextRadius` | `2` | `0..10` |
| `limit` | `50` | `1..200` |

任何 `qqsu_ / qqsf_ / qqm_` 定点引用都不推进 Conversation Read Progress。

原始内容过期时返回成功结果：

```json
{
  "evidenceAvailable": false,
  "reason": "source_messages_expired"
}
```

这不是工具错误，因为摘要引用本身仍然有效。

### 5.5 一键已读

```json
{
  "operation": "mark_read",
  "reference": "qqc_c"
}
```

或：

```json
{
  "operation": "mark_read",
  "conversationType": "group",
  "conversationId": "123456789"
}
```

返回：

```json
{
  "conversationRef": "qqc_c",
  "operation": "mark_read",
  "markedMessageCount": 86,
  "readProgressBefore": "qqm_80",
  "readProgressAfter": "qqm_9e",
  "markedThroughTimestamp": 1784566800000
}
```

规则：

- 截止点在操作开始时冻结；调用期间新到消息保持未读。
- 操作幂等。
- 不改变 Feed Progress。
- 不调用 QQ 或 OneBot 的客户端已读接口。
- 第一版不提供跨会话批量已读。

## 6. 消息输出

```json
{
  "kind": "message",
  "ref": "qqm_89e",
  "senderUin": "345678",
  "senderName": "小雨",
  "isOwner": false,
  "direction": "in",
  "text": "周六下午有时间吗？",
  "timestamp": 1784566100000,
  "recalled": false
}
```

撤回内容默认返回 `[消息已撤回]`。只有配置同时允许保留和暴露时才返回原文，并继续带 `recalled=true`。

## 7. Summary Finding 输出

```json
{
  "ref": "qqsf_3j",
  "text": "小明和小王对交付时间存在分歧。",
  "evidenceCount": 4
}
```

普通工具输出不暴露 `sourceMessageIds`。证据关系由 MCP 内部解析。

## 8. 工具错误

错误统一返回：

```json
{
  "isError": true,
  "error": {
    "code": "REFERENCE_NOT_FOUND",
    "message": "The requested local reference does not exist.",
    "retryable": false,
    "details": {
      "reference": "qqsf_missing"
    }
  }
}
```

| code | 含义 | 可重试 |
|---|---|---:|
| `INVALID_ARGUMENT` | 参数组合、枚举或范围非法 | 否 |
| `CONVERSATION_NOT_FOUND` | 会话未被采集或不存在 | 否 |
| `REFERENCE_NOT_FOUND` | 本地短引用不存在或已清理 | 否 |
| `STORAGE_UNAVAILABLE` | SQLite 当前不可读 | 是 |
| `SERVICE_NOT_READY` | 初始化尚未完成 | 是 |
| `INTERNAL_ERROR` | 未归类内部故障 | 视 `retryable` |

桥离线不影响读取已有数据，因此不会单独导致 `qq_feed_pull` 或 `qq_read_conversation` 失败。
