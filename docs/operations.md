# 运行与运维

## 1. 当前状态声明

本仓库尚无可执行程序。本文描述实现完成后的标准运行方式，以及开发阶段必须验证的外部前置条件。文中的命令路径是目标形态示例，不代表当前已经存在。

## 2. 前置条件

### 2.1 QQ 与 LLOneBot

1. 安装受当前 LLOneBot 版本支持的 Windows 官方 NTQQ。
2. 独立安装 LLOneBot（Windows 发行包含 PMHQ 与自带 Node 运行时）。
3. 通过 LLOneBot/PMHQ 启动入口拉起官方 QQ；日常使用改用该入口（可设开机自启）。
4. 在该 QQ 窗口登录 `account.targetSelfUin` 对应账号；GUI 可照常日常聊天。
5. 在 LLOneBot 管理界面（WebUI 默认端口 3080）启用 OneBot 11 正向 WebSocket 服务端；该服务端默认关闭，默认端口 3001。
6. 服务端只监听 `127.0.0.1`。
7. 设置 Token。
8. 在对应连接类型上开启 `reportSelfMessage`，确保主人自己发送的消息会上报。

普通 QQ 快捷方式启动、未经 PMHQ 拉起的已有进程不属于第一版消息来源，无法事后贴附。

### 2.2 摘要模型

- 第一版预期使用云端 OpenAI-compatible API：白名单群的消息投影会发送给该服务，应选择可信的服务商。
- 提供 OpenAI-compatible API 根地址和模型名。
- API Key 放入 `summary.producer.apiKeyEnv` 指向的环境变量。
- 本地模型服务同样受支持，可消除消息外发，但其内存属于模型进程，不属于 MCP 自身。
- 摘要模型不可用时，消息采集继续，摘要任务排队并报告降级。

### 2.3 TakiAgent

TakiAgent 需要以 stdio MCP 方式启动本服务。TakiAgent 的 MCP 配置位于其数据目录（`TAKI_DATA_DIR`）下的 `mcp-servers.json`，格式是扁平的“服务名 → 配置”映射，没有 `mcpServers` 包装层；子进程以 `shell:false` 启动，`command` 必须是真实可执行文件（如 `node`）：

```json
{
  "qq-message-monitor": {
    "command": "node",
    "args": [
      "H:/QQMessageMonitor/dist/main.js",
      "--config",
      "H:/QQMessageMonitor/config/config.json"
    ],
    "env": {
      "QQ_MONITOR_ONEBOT_TOKEN": "...",
      "QQ_MONITOR_LLM_API_KEY": "..."
    }
  }
}
```

`dist/main.js` 目前尚不存在，实现后以实际构建产物为准。TakiAgent 在启动时连接全部配置的 MCP 服务并为工具加命名空间；修改本服务的工具描述后，需重启 TakiAgent 使其重新连接。

## 3. 推荐启动顺序

顺序不是正确性前提，但以下顺序最容易观察状态：

1. 启动 TakiAgent，由其创建 MCP。
2. MCP 打开 SQLite 并进入 `dormant`。
3. 通过 LLOneBot/PMHQ 启动目标官方 QQ。
4. LLOneBot WebSocket 服务端就绪。
5. MCP 在下一次重连时连接并校验 `self_id`。
6. 首次连接建立 Monitoring Baseline；后续重连为断开区间记录 Capture Gap。
7. 状态进入 `active`。

若先启动 LLOneBot 与 QQ，MCP 启动后会直接连接；不需要重启 QQ。

## 4. 停止行为

### 4.1 QQ 或 LLOneBot 退出

- WebSocket 关闭后立即刷新已接收消息和检查点。
- 生命周期进入 `dormant`。
- 已有消息仍可读取。
- 已冻结摘要任务可继续运行。
- MCP 每 5 秒尝试重新连接。

### 4.2 MCP 正常退出

- 停止接收新事件。
- 等待当前 SQLite 短事务完成。
- 保存任务和进度状态。
- 关闭 WebSocket 和数据库连接。
- 不等待长时间模型调用；未完成任务恢复为可重试状态。

### 4.3 非正常退出

WAL 和事务保证未提交写入不会成为部分消息。重启时必须：

- 检查运行中的摘要单元并恢复为队列状态。
- 为停机区间记录 Capture Gap。
- 对重复到达的实时事件进行幂等去重。

## 5. 状态检查

Agent 或人工诊断优先调用：

```json
qq_monitor_status({})
```

关键判断：

| 观察值 | 含义 |
|---|---|
| `dormant + healthy` | 桥/QQ 未连接，MCP 和已有数据正常 |
| `active + healthy` | 所有关键链路正常 |
| `active + degraded` | 采集可用，但摘要或维护子系统异常 |
| `readyForReads=false` | 数据库初始化或读取故障，需要优先处理 |
| `readyForCapture=false` | 当前不会接收目标账号消息 |

状态调用只读取最近已知状态，不主动探测外部服务，因此 `lastEventAt` 和 issue 时间比单个布尔值更有诊断价值。

## 6. 常见问题

### 6.1 一直处于 `dormant`

依次检查：

1. QQ 是否经 LLOneBot/PMHQ 入口启动。
2. 目标账号是否已完成登录。
3. LLOneBot WebSocket 服务端是否启用。
4. MCP 与 LLOneBot 的 URL、端口和 Token 是否一致。
5. LLOneBot 是否只监听了另一个网络接口。
6. `connectedSelfUin` 是否与 `targetSelfUin` 不同。

### 6.2 收不到主人自己发送的消息

检查 LLOneBot 对应连接类型配置中的 `reportSelfMessage`。MCP 配置只能声明该能力是必需前置条件，无法替桥开启它。

### 6.3 消息正常但摘要积压

检查：

- `summary.producerState`
- 模型 API 地址、模型名和 API Key 环境变量
- `queuedTaskCount` 和 `lastCompletedAt`
- 模型上下文限制与 `maxInputTokensPerCall`
- 最近 Summary Gap 的错误码

不要为了恢复摘要而暂停消息采集。

### 6.4 出现 Capture Gap

Capture Gap 表示服务确认该时间段覆盖不完整。第一版不执行历史补偿，因此任何断线或离线区间都会形成账号级 Gap，这是预期行为而非故障。

Gap 是数据事实，重启服务不会自动消除；未来的补偿扩展可在回补后将其标记为已解决。

### 6.5 证据引用返回过期

摘要保留期长于消息保留期时属于正常行为。Summary Reference 仍可读取摘要，但 `evidenceAvailable=false`。

## 7. 日志

日志至少包含：

- 生命周期状态变化。
- 连接失败、账号不匹配和心跳超时。
- 断开与重连边界以及 Capture Gap 记录。
- 消息批次写入数量，不默认包含正文。
- 摘要单元引用、状态、耗时、重试次数和错误码。
- 清理影响的行数和耗时。
- 工具错误码与调用耗时，不记录密钥。

日志不得包含：

- OneBot Token。
- 模型 API Key。
- 默认情况下的完整消息正文和完整模型提示词。

## 8. 数据备份

- 使用 SQLite backup API 或服务提供的维护命令创建一致性备份。
- 不直接复制正在写入的 `.db` 文件而忽略 `-wal` 和 `-shm`。
- 配置、数据库和密钥环境变量应分别备份。
- 恢复数据库后，短引用只要表 ID 未改变即可继续使用。

## 9. 更新 QQ 或 LLOneBot

1. 更新前备份数据库和 LLOneBot 配置。
2. 停止目标账号采集会话。
3. 更新 QQ/LLOneBot。
4. 验证登录、WebSocket、`self_id` 和自身消息上报。
5. 执行消息、撤回、群聊和好友冒烟测试。
6. 确认无异常后恢复长期运行。

项目不绑定固定 QQ 版本，但“版本不固定”不代表无须兼容性验证。QQ/LLOneBot 更新后，适配结果应由测试证明。

## 10. 资源验证

实现后需要在 Windows 上记录：

- `dormant` 和 `active` 的工作集内存。
- 空闲及消息突发时 CPU。
- 每秒消息写入能力。
- 10 万、100 万消息数据库下三个工具的延迟。
- 摘要任务运行时对采集延迟的影响。

在这些测试完成前，项目只承诺架构上避免不必要工作，不承诺具体资源数字。
