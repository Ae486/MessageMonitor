# 架构决策记录

ADR 只记录难以逆转、代码本身难以解释且经过真实取舍的决定。

| 编号 | 决策 |
|---|---|
| [0001](./0001-use-an-external-message-bridge.md) | 使用外部 Message Bridge |
| [0002](./0002-use-forward-onebot-websocket.md) | 使用正向 OneBot WebSocket，不监听 QQ 进程 |
| [0003](./0003-freeze-summary-units.md) | 摘要任务开始时按调用预算冻结不可重叠的 Summary Unit |
| [0004](./0004-attach-to-daily-qq-via-llonebot.md) | 经 LLOneBot 旁挂主人日常官方 QQ，NapCat 降为未验证备选 |
| [0005](./0005-record-gaps-without-backfill.md) | 离线区间只记录 Capture Gap，第一版不做历史回补 |
