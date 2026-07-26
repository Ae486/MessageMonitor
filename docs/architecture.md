# 系统架构

## 1. 架构目标

系统围绕四个优先级设计：消息不丢失或明确披露缺口、QQ 侧只读、离线低资源、Agent 工具面精简。QQ 版本相关能力全部隔离在 Message Bridge 适配层，领域逻辑不依赖具体桥（LLOneBot/NapCat）的内部代码或数据库。

## 2. 组件职责

```text
┌─────────────────────────────────────────────────────────┐
│ QQ Message Monitor MCP                                  │
│                                                         │
│  Bridge Adapter ─→ Normalizer ─→ Ingest Coordinator     │
│       ↑                              │                  │
│       │                              ├─→ SQLite          │
│  Lifecycle Controller               ├─→ Feed Projector  │
│                                      └─→ Summary Queue   │
│                                               │         │
│                                      Summary Producer    │
│                                                         │
│  MCP Tools ─→ Query Service / Progress Service           │
└─────────────────────────────────────────────────────────┘
            ↑ OneBot 11 WebSocket          ↑ MCP stdio
          LLOneBot                       TakiAgent
```

| 组件 | 单一职责 |
|---|---|
| Lifecycle Controller | 管理桥接连接、账号验证、恢复和休眠 |
| Bridge Adapter | 收发 OneBot 请求/事件并转换桥接错误 |
| Normalizer | 将事件转换为统一消息、撤回和生命周期模型 |
| Ingest Coordinator | 白名单、去重、排序、事务写入和 Feed 事件生成 |
| Gap Recorder | 在断开与重连边界记录 Capture Gap |
| Summary Queue | 冻结摘要单元、串行调度、重试和失败跨越 |
| Summary Producer | 调用 OpenAI-compatible API 并校验结构化结果 |
| Query Service | 读取摘要、消息、缺口和短引用证据 |
| Progress Service | 管理 Feed Progress 和 Conversation Read Progress |
| Maintenance Service | 清理过期内容、检查点和 WAL 维护 |
| MCP Server | 暴露三个只读 QQ 工具；不包含 QQ 写操作 |

## 3. 运行时边界

### 3.1 外部依赖

- LLOneBot 独立安装，经 PMHQ 拉起官方 QQ 并旁挂目标账号；GUI 保持日常可用。
- LLOneBot 开启 OneBot 11 正向 WebSocket 服务端。
- MCP 是 WebSocket 客户端，连接 `127.0.0.1` 的配置端点。
- 摘要模型是独立的 OpenAI-compatible 服务。
- TakiAgent 通过 stdio 创建并持有 MCP 进程。

### 3.2 权威信号

- WebSocket 是否连接决定桥接是否可用。
- OneBot `self_id` 是否匹配决定目标账号是否可采集。
- Windows `QQ.exe` 进程不参与正确性判断。
- SQLite 已提交数据是 Agent 查询的唯一事实源，内存队列不是事实源。

## 4. 生命周期

### 4.1 内部状态机

```text
BOOT
  → DORMANT
  → CONNECTING
  → VERIFYING
  → ACTIVE
  → DRAINING
  → DORMANT
```

| 状态 | 行为 |
|---|---|
| `DORMANT` | SQLite 可读；每 5 秒尝试连接桥 |
| `CONNECTING` | 建立带鉴权的 WebSocket |
| `VERIFYING` | 获取或等待 `self_id`，拒绝非目标账号；非首次连接在此记录断开区间的 Capture Gap |
| `ACTIVE` | 实时采集、落库并调度摘要 |
| `DRAINING` | 停止接收、刷新批次、保存检查点、释放会话资源 |

状态工具将 `CONNECTING` 和 `DRAINING` 映射为 `dormant`，对外只暴露 `dormant / verifying / active`。健康度使用独立的 `healthy / degraded`，避免把生命周期和故障状态混为一谈。未来引入历史补偿扩展时再恢复 `recovering` 状态。

### 4.2 启动

1. 解析并严格校验配置。
2. 打开数据库并执行向前迁移。
3. 恢复摘要队列、检查点和 Agent 进度。
4. 启动 MCP stdio 服务。
5. 尝试连接桥；失败时进入 `DORMANT`。
6. 连接后验证 `self_id`。
7. 首次连接创建 Monitoring Baseline；非首次连接为断开区间记录 Capture Gap。
8. 进入 `ACTIVE`。

### 4.3 断开

socket 关闭或超过配置的心跳超时（默认 130 秒，对应 LLOneBot 默认 60 秒心跳间隔）无心跳活动时：

1. 原子切换为 `DRAINING`，停止接受该会话的新事件。
2. 刷新已接收消息事务。
3. 保存最后成功事件时间、恢复检查点和断开时间。
4. 不修改已冻结摘要单元。
5. 释放桥接 socket、事件缓冲和账号会话。
6. 进入 `DORMANT` 并开始重连。

MCP、SQLite、清理任务和已冻结摘要任务继续运行，因此离线时已有数据仍可读取。

## 5. 实时消息数据流

```text
OneBot message event
  → 校验连接账号 self_id
  → 识别 group / friend 会话
  → 应用采集白名单
  → 标准化消息段与 Message Projection
  → 计算幂等键
  → SQLite 短事务：消息 + 会话状态 + Feed 事件
  → 提交后更新内存计数
  → 若达到阈值，尝试创建摘要任务
```

摘要模型调用永远发生在提交之后、采集事务之外。

## 6. 断线与缺口

第一版不执行历史补偿。重连并通过账号验证后：

1. 以最后成功事件时间与断开时间中较早者为起点、重连时间为终点，记录一条账号级 Capture Gap。
2. 直接进入 `ACTIVE`，实时事件照常采集。
3. 账号级缺口通过状态工具计数和会话读取中的 gap item 披露，不产生 Feed 事件。

历史补偿是未来扩展；引入时必须复用同一幂等键、保持已冻结单元边界不变，并恢复 `recovering` 状态与会话级缺口。

实时事件的幂等键为：

```text
targetSelfUin + conversationType + conversationId + sourceMessageId
```

若真实样本证明 `message_id` 在某些事件中不稳定，适配器必须增加经过测试的后备键；该规则不得凭猜测实现。

## 7. 摘要流水线

### 7.1 触发与冻结

```text
未摘要消息数达到 threshold
  → 获取该会话摘要锁
  → 按 maxInputTokensPerCall 预算从最旧未摘要消息截取有界前缀
  → 在事务中创建固定 start/end 边界的 Summary Unit
  → 新到消息与超出预算的剩余消息从下一单元开始累计
```

阈值是触发条件，不是强制单元大小。任务启动时已有 47 条且阈值为 30，预算装得下则单元覆盖全部 47 条。积压超出预算时（如摘要模型长时间不可用后恢复），冻结装得下的最旧一段，当前单元完成后立即冻结下一段，形成串行的时间段单元。

### 7.2 提示词组合

```text
固定事实性约束
  + additionalPrompt
  + 当前 Summary Dimension 定义
  + 紧邻前一成功摘要（如存在）
  + 当前冻结消息
  + 动态 JSON Schema
```

有界冻结保证单元内容不超过单次调用预算，每个单元恰好一次模型调用，不存在单元内分块归并。单条消息投影本身超过预算的极端情况下，截断该条投影并在提示词中标注截断。

### 7.3 输出校验

- `summaryText` 必须是字符串。
- 所有配置维度必须存在并返回数组；无内容时为空数组。
- 每个 Summary Finding 包含 `text` 和源消息 ID 数组。
- 源消息 ID 必须属于当前冻结单元。
- 非法字段、未知维度和越界消息引用导致本次输出校验失败。
- 重试始终使用同一个冻结边界。

### 7.4 失败

- 重试次数耗尽后将单元标记为 `failed`，形成 Summary Gap。
- 后续单元继续执行，不注入失败单元或更早摘要来伪造直接连续性。
- 原始消息继续按消息保留策略保存。
- 失败单元后续可由维护命令重新处理，但第一版不提供 MCP 重试工具。

## 8. Feed 与阅读进度

### 8.1 Feed

消息提交、摘要完成、摘要失败和撤回都会产生 Feed 事件。账号级 Capture Gap 不产生 Feed 事件，通过状态工具和会话读取披露；`capture_gap` 事件类型保留给未来的会话级缺口。`qq_feed_pull` 将上次 Feed Progress 之后的事件按会话聚合，并返回消息数量、摘要预览和状态。

摘要可能在消息通知之后完成，因此允许：

```json
{
  "updateKinds": ["summary_completed"],
  "newMessageCount": 0
}
```

### 8.2 阅读

- `scope=unread` 从当前 Conversation Read Progress 连续读取，并推进到实际返回边界。
- `recent`、`after_cursor` 和短引用查询是观察操作，不推进阅读进度。
- `operation=mark_read` 不返回正文，直接推进到调用开始时的最新已提交消息。
- 进度只属于 MCP 的 Agent consumer，不修改 QQ 客户端未读状态。

## 9. 并发与背压

- SQLite 单写协调器保证短事务顺序提交。
- WebSocket 事件处理不得直接执行模型调用或长时间文件操作。
- 每个会话最多一个摘要任务；默认全局摘要并发为 1。
- 摘要队列过长时继续采集，状态工具报告降级，不丢弃消息。
- 写入队列达到实现定义的硬上限时，应停止从 socket 消费并触发背压；不得静默丢弃。

## 10. 故障隔离

| 故障 | 采集 | 读取 | 摘要 | 对外表现 |
|---|---:|---:|---:|---|
| 桥离线（QQ 未启动或退出） | 暂停 | 可用 | 已冻结任务可继续 | 生命周期 `dormant` |
| 账号不匹配 | 禁止 | 可用 | 可用 | `ACCOUNT_MISMATCH` |
| 摘要模型离线 | 可用 | 可用 | 排队/重试 | 健康度 `degraded` |
| 断线后重连 | 恢复 | 可用 | 可用 | 账号级 Capture Gap |
| SQLite 写失败 | 暂停 | 视故障而定 | 暂停 | 健康度 `degraded` |
| 配置非法 | 不启动 | 不可用 | 不可用 | 进程启动失败并输出明确错误 |

## 11. 安全与只读保证

- OneBot Adapter 只注册读取和状态查询所需 action allowlist。
- 不实现通用 `call_onebot_action` 透传接口。
- MCP 工具中不存在发送或管理操作。
- Token 和 API Key 只从环境变量解析。
- 日志默认不输出完整消息正文和密钥。
- 桥 WebSocket 推荐仅监听 `127.0.0.1`。
