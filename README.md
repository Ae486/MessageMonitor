# QQ Message Monitor

QQ Message Monitor 是一个面向陪伴型 Agent 的只读 QQ 消息 MCP 服务。它通过外部 LLOneBot 桥（经 PMHQ 拉起并旁挂主人日常使用的官方 QQ）提供的 OneBot 11 WebSocket 接收目标账号的群聊和好友消息，在本地完成过滤、标准化、持久化、增量摘要和阅读进度管理，再以三个精简的 MCP 工具提供给 Agent。

## 项目状态

**核心实现已完成（阶段 0-5），待真实环境集成验证（阶段 6）。**

截至 2026-07-27，配置加载、SQLite 存储与迁移、LLOneBot 桥接采集、断线缺口记录、有界摘要流水线和三个 MCP 工具全部实现，130 个单元/集成/契约测试通过。尚未完成：与真实 LLOneBot 实例和 TakiAgent 的端到端联调、Windows 资源基准（实施计划阶段 6）。

构建与测试：

```bash
pnpm install
pnpm typecheck && pnpm test
pnpm build   # 产物 dist/main.js
```

## 核心边界

- 第一版仅面向 Windows PC QQ。
- LLOneBot 独立安装、配置和运行；官方 QQ 必须经其 PMHQ 入口启动，GUI 可照常日常使用；本项目不捆绑或启动它。
- MCP 主动连接桥的 OneBot 11 正向 WebSocket 服务端；NapCat 协议兼容但第一版不验证（见 ADR-0004）。
- 目标账号以 OneBot `self_id` 与配置的 QQ 号严格匹配。
- 群聊只采集白名单；好友默认全部采集，也可切换为白名单。
- 捕获主人自己发送的消息，并以 `isOwner` 标记。
- QQ 侧只读，不提供发送消息、修改好友或管理群聊能力。
- 原始消息和摘要分别配置保留期。
- 摘要维度由配置定义，不在代码中写死。
- Agent 只需三个工具：状态、增量动态、会话读取。
- 自动 hook、主动唤醒 Agent、移动端和多媒体理解不属于第一版。

## 系统概览

```text
目标账号 QQ
    ↕
LLOneBot（旁挂官方 QQ 的外部桥）
    ↕ OneBot 11 正向 WebSocket
QQ Message Monitor MCP
    ├─ 账号与白名单过滤
    ├─ 消息标准化与 SQLite
    ├─ 断线缺口记录
    ├─ 后台摘要任务
    └─ 本地阅读进度
    ↕ MCP stdio
TakiAgent
```

## 文档导航

| 文档 | 用途 |
|---|---|
| [CONTEXT.md](./CONTEXT.md) | 领域词汇表；规定项目中的标准术语 |
| [需求规格](./docs/requirements.md) | 功能范围、非功能约束和验收标准 |
| [系统架构](./docs/architecture.md) | 组件职责、数据流、生命周期和异常路径 |
| [配置规范](./docs/configuration.md) | 完整配置结构、默认值、校验规则和示例 |
| [配置示例](./config/config.example.json) | 可供实现和部署复用的机器可读配置基线 |
| [MCP 工具契约](./docs/mcp-tools.md) | 三个工具的参数、返回值、进度和错误语义 |
| [数据模型](./docs/data-model.md) | SQLite 逻辑表、约束、索引和保留策略 |
| [运行与运维](./docs/operations.md) | LLOneBot 前置条件、启动顺序、状态和排障 |
| [实施计划](./docs/implementation-plan.md) | 已确认技术栈、模块结构、阶段和测试策略 |
| [架构决策](./docs/adr/) | 难以从代码直接看出的长期决策 |

## 文档权威顺序

出现冲突时按以下顺序处理：

1. `CONTEXT.md` 决定术语含义。
2. `docs/requirements.md` 决定产品行为与范围。
3. `docs/mcp-tools.md` 和 `docs/configuration.md` 决定外部契约。
4. `docs/architecture.md` 和 `docs/data-model.md` 决定内部职责与持久化设计。
5. ADR 解释长期决策及其原因。
6. `docs/implementation-plan.md` 只规定推荐实施顺序，不覆盖上述契约。

## 已知前置条件

- 目标账号必须登录在经 LLOneBot（PMHQ）启动的官方 QQ 中；未经该入口启动的 QQ 进程无法被捕获。
- LLOneBot 必须开启 OneBot 11 正向 WebSocket 服务端，并启用自身消息上报。
- 摘要功能需要一个独立配置的 OpenAI-compatible 模型服务；需要鉴权时通过环境变量提供密钥。
- TakiAgent 需要以 stdio MCP 方式启动本服务。

具体安装命令将在实现产生可执行入口后补充。当前文档不会虚构尚不存在的命令。
