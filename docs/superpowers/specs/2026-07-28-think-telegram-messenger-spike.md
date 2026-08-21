---
title: Think Telegram Messenger 隔离 Spike
date: 2026-07-28
status: evaluated-no-cutover
production_authorized: false
---

# Think Telegram Messenger 隔离 Spike

## 结论

`@cloudflare/think@0.15.0` 的 Telegram Messenger 已提供 webhook secret 校验、会话分片、流式编辑、
长文本切分、附件/action capability 和 durable reply fiber。它适合新的普通 Telegram agent，
但目前不能无损替代 Operia 的 TG owner，因此 S5 结论是 **不切生产 webhook**。

当前锁定安装树还有一个直接兼容缺口：该子路径运行时 import `@chat-adapter/telegram`，而主项目没有
安装这个可选 adapter；真实 import 会得到 `ERR_MODULE_NOT_FOUND`。在没有 TG cutover ADR 前不为 spike
新增这项依赖，避免扩大生产依赖面。

## 对照矩阵

| Operia 现有不变量 | Think 0.15 现成能力 | 本轮结论 |
| --- | --- | --- |
| webhook secret | `telegramSecretTokenVerifier()` | 可复用 |
| runtime adapter dependency | `@chat-adapter/telegram` | 当前未安装；独立 compatibility Gate |
| 流式消息编辑与长文本分片 | `telegramMessenger()` + `splitTelegramMessageText()` | 可复用；后续单独体验 Gate |
| chat/thread 分片 | `defaultTelegramThreadShard()` / `shardTelegramStateKey()` | 可复用，但不等于 exact QA authority |
| exact Owner 私聊与固定 QA room/thread | 通用 conversation resolver/shard | 缺少 Operia authority envelope；保留现 owner |
| `/pause`、stop、批准/拒绝 | Messenger actions 可承载 | 当前 callback 与 Agent/Memory pin 已成熟；暂不迁移 |
| reply/reaction/image/voice/Mini App | 通用附件/action capability | 未逐项证明语义等价；暂不迁移 |
| Bot API unknown outcome、known-final、FIFO outbox | durable reply fiber 与错误分类 | 尚未证明覆盖现有 D1 证据链；禁止替换 |
| 家庭群边界与 bot-to-bot loop guard | 无 Operia 特定实现 | 必须保留 TG owner |

## 删除与重评条件

只有在隔离 fixture 同时证明 exact room/thread authority、回复与 reaction 定向、媒体/voice、Mini App、
Bot API unknown outcome、不重复投递和 `/pause` 后，才允许提出 TG owner cutover ADR。S0-S4 的 SDK
瘦身不依赖 Messenger 迁移。
