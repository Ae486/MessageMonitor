# 配置规范

## 1. 加载规则

配置格式为 UTF-8 JSON，不支持注释。配置路径优先级：

1. 命令行 `--config <path>`
2. 环境变量 `QQ_MONITOR_CONFIG`
3. 默认 `${LOCALAPPDATA}/QQMessageMonitor/config.json`

`${NAME}` 形式的环境变量只允许出现在路径字段中。密钥字段保存环境变量名称，不保存密钥值。

配置在 MCP 启动时一次性读取。修改摘要维度、工具描述或连接参数后必须重启 MCP，并让 TakiAgent 重新连接以刷新工具定义。

## 2. 完整示例

```json
{
  "configVersion": 1,
  "account": {
    "targetSelfUin": "14549711115"
  },
  "bridge": {
    "provider": "llonebot",
    "protocol": "onebot11",
    "mode": "forward-websocket",
    "url": "ws://127.0.0.1:3001",
    "accessTokenEnv": "QQ_MONITOR_ONEBOT_TOKEN",
    "connectTimeoutMs": 5000,
    "reconnectIntervalMs": 5000,
    "heartbeatTimeoutMs": 130000,
    "requireSelfMessageReporting": true
  },
  "capture": {
    "groups": {
      "whitelist": ["123456789", "987654321"]
    },
    "friends": {
      "mode": "all",
      "whitelist": []
    }
  },
  "messages": {
    "retainRecalledContent": true,
    "exposeRecalledContentToAgent": false
  },
  "storage": {
    "databasePath": "${LOCALAPPDATA}/QQMessageMonitor/data/monitor.db",
    "messageRetentionDays": 30,
    "summaryRetentionDays": 180,
    "cleanupIntervalHours": 24
  },
  "summary": {
    "enabled": true,
    "groupWhitelist": ["123456789"],
    "threshold": 30,
    "maxConcurrentTasks": 1,
    "maxInputTokensPerCall": 12000,
    "maxRetries": 3,
    "retryBaseDelayMs": 5000,
    "requestTimeoutMs": 60000,
    "additionalPrompt": "使用简体中文，优先保留对后续交流有价值的明确事实。",
    "producer": {
      "type": "openai-compatible",
      "baseUrl": "https://api.example.com/v1",
      "model": "summary-model",
      "apiKeyEnv": "QQ_MONITOR_LLM_API_KEY"
    },
    "dimensions": {
      "keyPoints": {
        "description": "值得注意的关键事实或信息"
      },
      "decisions": {
        "description": "参与者明确达成的决定、约定或安排"
      },
      "openQuestions": {
        "description": "尚未解决或仍待确认的问题"
      },
      "ownerRelevance": {
        "description": "与主人直接相关或明确提到主人的内容"
      },
      "conflicts": {
        "description": "参与者之间明确出现的分歧、争执或冲突"
      }
    }
  },
  "agent": {
    "consumerId": "taki-main"
  },
  "logging": {
    "level": "info",
    "includeMessageContent": false
  }
}
```

## 3. 字段定义

### 3.1 根字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `configVersion` | integer | 是 | 第一版固定为 `1` |
| `account` | object | 是 | 目标 QQ 账号 |
| `bridge` | object | 是 | OneBot 桥接连接 |
| `capture` | object | 是 | 会话采集范围 |
| `messages` | object | 否 | 撤回内容策略 |
| `storage` | object | 是 | SQLite 和保留期 |
| `summary` | object | 否 | 后台摘要；整块缺省时视为禁用 |
| `agent` | object | 否 | Agent consumer 标识 |
| `logging` | object | 否 | 本地日志策略 |

未知根字段或未知嵌套字段均视为配置错误，避免拼写错误被静默忽略。

### 3.2 `account`

| 字段 | 类型 | 默认 | 校验 |
|---|---|---|---|
| `targetSelfUin` | string | 无 | 必填；仅数字；非空 |

QQ 号始终使用字符串，禁止配置为 JSON number。

### 3.3 `bridge`

| 字段 | 类型 | 默认 | 校验/行为 |
|---|---|---|---|
| `provider` | string | `llonebot` | 接受 `llonebot`（已验证）或 `napcat`（协议兼容，未验证） |
| `protocol` | string | `onebot11` | 第一版只接受 `onebot11` |
| `mode` | string | `forward-websocket` | 第一版只接受该值 |
| `url` | string | 无 | 必填；`ws://` 或 `wss://` |
| `accessTokenEnv` | string | 无 | 必填；环境变量名 |
| `connectTimeoutMs` | integer | `5000` | `1000..30000` |
| `reconnectIntervalMs` | integer | `5000` | `1000..60000` |
| `heartbeatTimeoutMs` | integer | `130000` | 建议不低于 2 倍桥心跳间隔；LLOneBot 默认心跳 60 秒 |
| `requireSelfMessageReporting` | boolean | `true` | 为真时启动状态必须披露该前置条件 |

服务不得回显 `accessTokenEnv` 对应的值。Token 通过 `Authorization: Bearer` 请求头提交，`access_token` 查询参数仅作为兼容后备。`requireSelfMessageReporting` 不能远程修改桥的配置，只用于验证和状态说明。

### 3.4 `capture`

```ts
type CaptureConfig = {
  groups: { whitelist: string[] };
  friends: {
    mode: "all" | "whitelist";
    whitelist: string[];
  };
};
```

- 群白名单不能为空数组是允许的，表示不采集任何群。
- `friends.mode=all` 时忽略 `friends.whitelist`，建议保持空数组。
- `friends.mode=whitelist` 时只采集名单内 QQ 号。
- 名单去重后使用；非法 QQ/群号导致启动失败。

### 3.5 `messages`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `retainRecalledContent` | boolean | `true` | 撤回后是否继续保留已捕获正文 |
| `exposeRecalledContentToAgent` | boolean | `false` | 工具是否可返回撤回正文 |

当 `retainRecalledContent=false` 时，`exposeRecalledContentToAgent` 必须为 `false`。

### 3.6 断线区间

第一版没有 `recovery` 配置块：断线区间不执行历史补偿，直接记录账号级 Capture Gap。配置中出现 `recovery` 字段按未知字段处理并导致启动失败。未来引入补偿扩展时再定义相关配置。

### 3.7 `storage`

| 字段 | 类型 | 默认 | 校验/说明 |
|---|---|---|---|
| `databasePath` | string | `${LOCALAPPDATA}/QQMessageMonitor/data/monitor.db` | 必须是本地可写路径 |
| `messageRetentionDays` | integer | `30` | `1..3650` |
| `summaryRetentionDays` | integer | `180` | `1..3650` |
| `cleanupIntervalHours` | integer | `24` | `1..168` |

`summaryRetentionDays` 必须不小于 `messageRetentionDays`：摘要单元先于消息过期会把已归属消息释放回摘要管线，违反单元一次性归属约束。原始消息先过期时，摘要单元转为 Summary-Only Unit。

### 3.8 `summary`

| 字段 | 类型 | 默认 | 校验/说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 关闭后不创建新摘要任务 |
| `groupWhitelist` | string[] | `[]` | 必须是采集群白名单子集 |
| `threshold` | integer | `30` | `1..10000`，表示触发数量 |
| `maxConcurrentTasks` | integer | `1` | 第一版允许 `1..4`；同会话始终为 1 |
| `maxInputTokensPerCall` | integer | `12000` | `1000..100000` |
| `maxRetries` | integer | `3` | `0..10` |
| `retryBaseDelayMs` | integer | `5000` | `1000..600000` |
| `requestTimeoutMs` | integer | `60000` | `5000..600000` |
| `additionalPrompt` | string | `""` | 最大 8000 字符 |
| `producer` | object | 无 | `enabled=true` 时必填 |
| `dimensions` | object | `{}` | 动态摘要维度 |

`threshold` 只触发任务。任务开始时按 `maxInputTokensPerCall` 预算冻结最旧一段未摘要消息（通常为全部）；超出预算的剩余消息在当前单元完成后成为后续单元。

整个 `summary` 块缺省等价于 `enabled=false`，不要求 `producer`；显式写出 `summary` 块（包括空对象）则按字段默认 `enabled=true` 处理并要求 `producer`。

`storage.databasePath` 的 `${NAME}` 展开不得引用 `accessTokenEnv` 或 `apiKeyEnv` 指定的密钥变量，出现即配置错误。

#### `summary.producer`

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | 第一版固定 `openai-compatible` |
| `baseUrl` | string | API 根地址，不包含密钥 |
| `model` | string | 模型标识 |
| `apiKeyEnv` | string | 可选；保存 API Key 的环境变量名 |

模型暂时不可用不会阻止消息采集，但会使健康度降级并积压摘要任务。

#### `summary.dimensions`

字段名就是摘要结果的 key，值当前只包含 `description`：

```json
{
  "conflicts": {
    "description": "参与者之间明确出现的分歧、争执或冲突"
  }
}
```

校验规则：

- key 匹配 `^[a-z][A-Za-z0-9]{0,63}$`。
- 最多 32 个维度。
- `description` 去除首尾空白后长度为 `1..1000`。
- key 不得使用保留名：`summaryText`、`metadata`、`sourceMessageIds`、`ref`、`schemaHash`。
- 所有维度统一输出 Summary Finding 数组；无内容时返回 `[]`。
- 配置快照和规范化后内容的哈希随 Summary Unit 保存。

### 3.9 `agent`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `consumerId` | string | `taki-main` | Feed 和会话阅读进度的命名空间 |

第一版仅支持一个配置 consumer，但数据模型保留多 consumer 键。

### 3.10 `logging`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `level` | string | `info` | `debug / info / warn / error` |
| `includeMessageContent` | boolean | `false` | 是否在 debug 日志包含正文 |

即使开启正文日志，Token 和 API Key 仍必须脱敏。

MCP 使用 stdout 传输协议消息，日志只能写入 stderr 或本地文件，禁止写 stdout。

## 4. 启动校验

以下情况应立即终止启动并给出具体字段路径：

- JSON 解析失败或版本不支持。
- `targetSelfUin`、群号或好友 QQ 号不是数字字符串。
- 摘要群名单不是采集群名单的子集。
- 配置了 `accessTokenEnv` 或 `apiKeyEnv`，但对应环境变量不存在或为空。
- `summary.enabled=true` 但 producer 缺失。
- 撤回配置相互矛盾。
- 数据库目录不可创建或不可写。
- 出现未知字段。

外部服务暂时不可达不是配置错误：桥不可达进入休眠，摘要模型不可达进入降级。

## 5. 配置变更

- 第一版不热加载配置。
- 重启后新的采集白名单立即生效，但不会删除此前已采集数据。
- 从摘要白名单移除群聊只停止新任务，已冻结任务继续完成。
- Summary Dimension 变化只影响新单元。
- 保留期缩短后，下次清理可能删除或清空更多内容；实施时应在日志中报告数量。
- `targetSelfUin` 变化视为新的监控身份。第一版应拒绝在已有数据库上直接更换，要求使用新的数据库路径，避免账号数据混合。
