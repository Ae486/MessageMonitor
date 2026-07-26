# 实施计划

## 1. 当前成熟度

需求和架构已形成第一版基线，代码尚未开始。技术栈已确认并与 TakiAgent 工程对齐；目录结构为推荐方案，可在第一个可运行切片中微调。

## 2. 技术栈（已确认）

| 项目 | 选择 | 原因 |
|---|---|---|
| 运行时 | Node.js 24+ | 与 TakiAgent `engines.node >= 24` 一致，标准库含 `fetch` 和 `node:sqlite` |
| 包管理 | pnpm | 与 TakiAgent 一致 |
| 语言 | TypeScript strict | 适合动态配置 Schema 和 MCP 契约 |
| MCP | 官方 TypeScript SDK | stdio 与工具 Schema 支持完整 |
| WebSocket | 成熟轻量客户端库或经验证的 Node 原生客户端 | 只需要客户端和自动重连 |
| 数据库 | `node:sqlite` | 避免额外数据库进程和大型 ORM；阶段 1 验证不达标则退回锁定版本的 `better-sqlite3` |
| 配置校验 | Zod | 配置、提示词输出和工具输入共用约束，与 TakiAgent 同库 |
| 测试 | Vitest | 与 TakiAgent 同栈；单元、临时 SQLite 和集成测试 |

任何新增依赖都应在实施前单独确认并锁定版本。第一版不引入 ORM、消息总线、向量数据库或 Web 框架。

## 3. 推荐目录

```text
QQMessageMonitor/
├─ src/
│  ├─ main.ts
│  ├─ config/
│  │  ├─ schema.ts
│  │  └─ load-config.ts
│  ├─ runtime/
│  │  ├─ lifecycle-controller.ts
│  │  └─ service-state.ts
│  ├─ bridge/
│  │  ├─ message-bridge.ts
│  │  └─ onebot11-adapter.ts
│  ├─ normalize/
│  │  ├─ normalize-message.ts
│  │  └─ project-message.ts
│  ├─ ingest/
│  │  ├─ ingest-coordinator.ts
│  │  └─ gap-recorder.ts
│  ├─ storage/
│  │  ├─ database.ts
│  │  ├─ migrations/
│  │  └─ repositories/
│  ├─ summary/
│  │  ├─ summary-queue.ts
│  │  ├─ prompt-builder.ts
│  │  ├─ summary-producer.ts
│  │  └─ summary-validator.ts
│  ├─ feed/
│  │  └─ feed-service.ts
│  ├─ query/
│  │  ├─ conversation-reader.ts
│  │  └─ reference-resolver.ts
│  └─ mcp/
│     ├─ server.ts
│     └─ tools/
├─ test/
│  ├─ unit/
│  ├─ integration/
│  ├─ fixtures/
│  └─ contract/
├─ config/
│  └─ config.example.json
├─ docs/
└─ package.json
```

目录按职责组织。Bridge Adapter 不得直接调用摘要、MCP 或具体 SQL。

## 4. 实施阶段

### 阶段 0：工程骨架

交付：

- TypeScript strict 构建。
- stdio MCP 空服务可启动。
- 配置加载和严格校验。
- 结构化日志与退出处理。
- CI 或本地统一的 typecheck/test 命令。

验证：非法配置失败、密钥不回显、正常 SIGTERM 退出。

### 阶段 1：SQLite 与领域仓储

交付：

- 迁移框架和第一版 Schema。
- WAL、外键、busy timeout。
- conversations/messages/checkpoints/gaps。
- 幂等消息写入和短引用编码。
- 保留期清理最小实现。

验证：重复写入、事务回滚、进度单调、内容到期不破坏引用。

### 阶段 2：桥接实时采集（LLOneBot）

交付：

- 正向 WebSocket 客户端。
- 鉴权、重连、心跳超时。
- `self_id` 账号验证。
- 群/好友过滤、自身消息。
- 结构化消息段和 Message Projection。
- 撤回通知。

验证：使用录制 OneBot fixture 完成群聊、好友、主人消息、重复事件、撤回和错误账号测试。

### 阶段 3：断线缺口

交付：

- 断开与重连边界的检查点维护。
- 账号级 Capture Gap 记录、状态计数和读取时 gap item。

验证：重连后 gap 边界正确、重复事件幂等、非正常停机区间重启后成 gap。

### 阶段 4：摘要单元

交付：

- 阈值统计和按 token 预算的有界原子冻结。
- 同会话串行队列和全局并发。
- OpenAI-compatible producer。
- 动态维度提示词和输出 Schema。
- Summary Schema Snapshot。
- Finding 证据关联、重试、Summary Gap、前序摘要上下文。

验证：边界冻结、超预算积压分批成串行单元、无内容维度为空、越界证据拒绝、失败后下一单元继续。

### 阶段 5：三个 MCP 工具

交付：

- `qq_monitor_status`
- `qq_feed_pull`
- `qq_read_conversation`
- Feed/Read 双进度。
- 短引用解析和一键已读。
- 动态工具描述。
- 结构化 `issues` 故障披露。

验证：合同测试覆盖每个参数组合、错误码、分页和进度副作用。

### 阶段 6：TakiAgent 接入与性能

交付：

- `mcp-servers.json` 接入示例。
- Windows 启停验证。
- LLOneBot 配置说明和冒烟脚本。
- 资源基准、数据库规模基准和故障恢复报告。

验收：满足 [requirements.md](./requirements.md) 的 AC-01 至 AC-19。

## 5. 测试矩阵

### 5.1 单元测试

- 配置默认值、未知字段和交叉校验。
- 白名单、owner 标记和消息投影。
- 短引用编码/解析。
- 动态摘要 JSON Schema 和 evidence 校验。
- 状态机转换。
- 保留期判定。

### 5.2 SQLite 集成测试

- 并发重复消息只插入一次。
- 消息与 Feed 事件原子提交。
- Summary Unit 区间不重叠。
- 进度只单调前进。
- Summary-Only Unit 清理。
- 进程中断后的 WAL 恢复。

### 5.3 OneBot 合同测试

fixture 至少包含：

- 群消息和好友消息。
- 主人自己发送的消息。
- `string` 与 `array` 消息格式；生产配置要求 `array`。
- 回复、`@`、图片、语音、文件占位。
- 好友撤回和群撤回。
- lifecycle/meta/heartbeat。
- 错误 `self_id`。
- 重复、乱序和断线重连事件。

### 5.4 摘要测试

- 使用确定性假 producer 测试队列，不依赖真实付费 API。
- 使用录制模型响应验证结构校验和修复/重试。
- 少量人工样本评估事实性、说话人归属和话题覆盖。
- 模型内容不得被消息中的指令改变系统边界；聊天正文始终作为数据分隔。

### 5.5 MCP 合同测试

- 工具清单严格为三个。
- 输入 Schema 与 [mcp-tools.md](./mcp-tools.md) 一致。
- `qq_feed_pull` 不推进会话阅读进度。
- 定点引用不推进进度。
- `scope=unread` 和 `mark_read` 的副作用准确。
- 过期证据是成功状态而不是不存在错误。

### 5.6 性能测试

- 休眠 30 分钟 CPU 与工作集。
- 每秒 10、100、500 条消息突发写入。
- 10 万和 100 万消息下 Feed、unread、reference 查询。
- 摘要调用同时进行时的采集延迟。
- 清理任务对写入和读取的影响。

具体指标应在首个实现切片后设定，当前不虚构目标数字。

## 6. 代码质量门

每个阶段合并前至少满足：

- TypeScript 类型检查通过。
- 单元/集成测试通过。
- MCP 和配置契约变更同步更新文档。
- 未增加 QQ 写操作或通用 OneBot action 透传。
- 日志 fixture 中无 Token/API Key。
- 数据库变更含迁移和回滚/备份说明。

## 7. 需要在实现中验证的事项

这些不是产品歧义，而是外部兼容性验证项：

- OneBot 心跳和 lifecycle 事件在 LLOneBot/PMHQ Windows 环境下的实际时序。
- LLOneBot `reportSelfMessage` 的实际行为，以及主人从手机端发送后同步到 PC 的消息是否上报。
- Node.js 目标版本中 `node:sqlite` 的稳定 API 和分发要求。
- 所选摘要模型服务对结构化输出的实际支持方式（`json_schema`、tool 调用或文本解析加校验）。
- TakiAgent 对 MCP 工具输出 Schema、工具描述刷新和进程退出的实际行为。

验证结果若改变外部契约，应先更新需求/工具/配置文档；若只是适配细节，记录在测试 fixture 和 Adapter 注释中。

## 8. 回滚思路

- 每次数据库迁移前备份。
- 新版本服务异常时停止 MCP，恢复旧二进制和迁移前数据库副本。
- LLOneBot/QQ 更新导致兼容故障时，MCP 保持休眠或记录 Gap，不尝试修改 QQ。
- 摘要模型配置故障时可关闭 `summary.enabled`，消息采集与读取继续运行。
