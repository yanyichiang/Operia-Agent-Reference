---
title: Operia Telegram Mini App Life Console Design
status: proposed-for-owner-review
date: 2026-07-17
depends_on:
  - 2026-07-14-operia-federated-control-plane-design.md
  - 2026-07-17-operia-heartbeat-studio-implementation.md
  - 2026-07-17-operia-production-acceptance-and-observation.md
  - 2026-07-17-operia-telegram-conversation-interactions-design.md
related:
  - 2026-07-16-operia-home-assistant-integration-design.md
  - 2026-07-17-operia-miniapp-artifacts-calendar-health-requirements.md
scope: Telegram Mini App, owner cockpit, federated timeline, pins, companion activities, Riddle, safe HTML artifacts, approvals and control projections
---

# Operia Telegram Mini App 生活总览与陪伴空间设计

## 1. 决策摘要

Operia Telegram Mini App 不是新的 Agent、控制面 owner、记忆库或 Provider Gateway。它是
Telegram 内的 owner-only 移动客户端，通过 `<TG_SERVICE>` 的 Mini App BFF 和私有 Service
Bindings，聚合现有 Memory、Agent、MCP、Telegram、Ops、Calendar、Home Assistant 与未来
Health owner 的受限投影。

产品定位从“缩小版 Dashboard”收敛为：

> 由 Opus 担任私人总管，用一个可追溯、可 Pin 的时间轴统摄用户的日程、开发、家庭、健康、
> Agent 任务与共同活动；控制、陪伴和游戏保持清晰分区。

主导航使用严肃产品名，允许在展示主题中使用带人格感的别名：

| 主导航 | 产品职责 | 可选主题文案 |
|---|---|---|
| 今日 | 当前最重要的日程、状态、异常与待办 | 御前 |
| 时间线 | 跨 owner 的事件流、搜索、过滤与 Pin | 起居注 |
| 一起 | 伴读、观影、专注与共同记录 | 伴读 |
| 工作台 | 任务、审批、MCP/Skills、开发与系统状态 | 奏折 |
| 游戏 | 独立的游戏目录与会话 | 游戏 / 游园 |

钱包、设置、隐私、连接状态与主题放入头像菜单，不占主导航。内部零钱包为延期能力，不阻塞
Mini App 首版，也不与真实 Provider 成本或 Agentic Payments 混用。

首个游戏固定为现有 Riddle 手写 PWA；Sudoku 按 Owner 当前决定留待后续，不在本 Spec 预设模式、
引擎或排期。健康数据源在进入相应实施阶段前完成单独来源审查。

## 2. 当前阶段门禁

本 Spec 只定义下一阶段产品与架构，不授权立即部署、配置 Cloudflare Access、登记 BotFather
Mini App、启用 Provider、接入 Calendar/Health、写 Home Assistant、修改生产 D1/DO 或制造
Heartbeat activity。

实施前必须满足：

1. 当前 `2026-07-17-operia-production-acceptance-and-observation.md` 的 Heartbeat P0 完成；
2. 生产 owner projection、TG durable outbox、continuation、MCP Elicitation、Fiber 和 Browser
   安全基线无未解释漂移；
3. Riddle 本地仓库、私有远端与生产 Worker 版本完成只读对账；
4. Mini App 精确 Access 例外、Telegram auth、回滚与 BotFather 变更有书面实施计划；
5. Calendar 与 Health 数据源分别完成字段、权限、保留期和撤销方式确认。

在以上条件满足前，本 Spec 状态保持 `proposed-for-owner-review`。

## 3. 目标

1. 在 Telegram 内一键打开适合手机和 iPad 的 Operia 私人总览。
2. 让 Owner 在一页看到 Calendar、开发、Agent、HA、健康与共同活动的真实状态。
3. 用统一的 `TimelineEventEnvelope` 汇总不同 owner 的事件，而不复制其权威数据。
4. 允许 Pin 任意事件、任务、日程、共同活动或 HTML artifact，并保留明确来源。
5. 将 MCP/Skills、审批、任务控制和 owner revision 安全地移动到更适合触控的界面。
6. 提供伴读、观影和游戏空间，同时避免把高频 UI 操作全部变成模型调用。
7. 复用 Riddle，保留其独立 PWA、Access 入口和 Operia profile，不建立第二套 Riddle backend。
8. 提供安全 HTML artifact 渲染，允许 Opus 生成可 Pin 的报告、卡片和可视化。
9. 为未来 Health、Calendar write、HA read-only、内部零钱包和链上身份预留受控接口。

## 4. 非目标

- 不把现有四个管理域的全部深层设置原样塞进 Mini App。
- 不在 Telegram D1 复制 Memory 正文、MCP catalog、Agent task、Calendar 事件或健康原始数据。
- 不让 Mini App 直接调用 Anthropic、xAI、Home Assistant、Riddle Oracle 或外部 MCP。
- 不让 Telegram `initDataUnsafe`、`start_param` 或 URL locator 直接授权数据读取或 mutation。
- 不在第一版创建、导入或管理链上钱包，不启用 x402、真实支付、购买或自动付费工具。
- 不让内部零钱兑换法币、稳定币、链上资产或真实 Provider credit。
- 不在第一版开放群聊、访客、多用户共享 Memory 或外部公开 profile。
- 不自动将 Calendar、Health、HA、游戏流水或读书电影进度写入长期记忆。
- 不允许任意 HTML 在 Mini App 同源上下文或带 ambient credential 的 frame 中执行 JavaScript；
  交互 Artifact 只允许在 opaque-origin、零网络、零表单、零导航的受限 Capsule 中运行本地逻辑。
- 不用 Mini App 绕过 Cloudflare Access 管理入口、应用 session、CSRF、owner scope 或高风险 step-up。

## 5. 产品信息架构

### 5.1 今日

`今日` 回答五个问题：

1. 今天有什么 Calendar 安排？
2. 当前开发与 Operia 主线推进到哪里？
3. Opus、Agent task、Heartbeat 和审批是否正常？
4. 家中 HA 与关键实体是否正常？
5. 健康数据是否出现值得 Owner 关注的变化？

页面区块：

- **Opus 状态卡**：事实状态与带 TTL 的叙事签名分层显示；
- **接下来**：最近三项 Calendar 事件和可用空闲块；
- **当前主线**：开发目标、最后验证、下一步和阻塞；
- **待处理**：approval、Elicitation、attention、Pin reminder；
- **家中**：HA core、只读传感器、关键 unavailable；
- **健康**：只显示经 Health owner 授权的摘要或 `not_configured`；
- **一起做**：当前书、电影、专注或游戏 continuation；
- **真实成本**：可选折叠显示 model/provider usage，永远与内部零钱分开。

事实状态必须带 `ownerDomain | sourceVersion | observedAt | staleAfter | deepLink`。Opus 生成的自然
语言总览不能覆盖结构化事实；source stale 时必须明确说“无法确认”，不能根据旧值推断正常。

### 5.2 时间线

`时间线` 是联邦只读视图，不是全系统事件数据库。默认聚合：

- Calendar event start/end/update；
- Ops deployment、health 和版本变化；
- Agent task/approval/attention/Heartbeat terminal event；
- TG message/delivery 的安全摘要和 locator；
- MCP Provider/catalog revision 与健康变化；
- HA 状态与后续规范化事件；
- Health owner 输出的授权摘要事件；
- 读书、电影、Riddle、未来游戏和内部零钱事件；
- Memory candidate/promotion 事件，不含完整记忆正文。

时间线支持：日期、来源、类型、只看 Pin、只看待处理、全文安全摘要搜索、按 owner deep link。
页面不得把隐藏 CoT、原始 prompt、完整工具结果、健康原始采样或 Calendar 私密正文放入通用索引。

### 5.3 一起

`一起` 是低压力陪伴空间，不承载系统管理：

- **一起读书**：书目、章节、进度、计时、短摘录、笔记、讨论问题、读完纪念卡；
- **一起看电影**：想看/看过、开始/暂停/结束、时间点反应、散场聊天、纪念卡；
- **一起专注**：定时、当前目标、安静陪伴、结束回顾；
- **共同计划**：从 Calendar 或 Pin 选择一个目标，不复制 Calendar 数据；
- **共同作品**：由安全 HTML renderer 或可信模块展示的小报告、卡片和视觉 artifact。

伴读不自动导入完整版权书籍；观影不登录流媒体、不绕 DRM、不购买影片。模型上下文只包含用户
明确提供或来源允许的内容、短摘录、笔记和进度元数据。

### 5.4 工作台

`工作台` 是现有控制面的移动 projection：

- 当前 tasks、continuations、approvals、Elicitation 与 attention；
- Heartbeat `off | armed | active`、usage、last decision 和 canonical Studio deep link；
- MCP Provider/tool catalog 状态、owner revision、Agent callable 与 approval requirement；
- Skills catalog、安装状态、运行记录和风险；
- Browser task 状态、read-only profile、pause/resume/stop；
- 模型、cache、usage 和 provider health 的只读摘要；
- 开发进度、commit/deploy/test/QA 证据；
- Security configured status 和 owner projection freshness。

Mini App 中必须把三个容易混淆的状态拆开显示：

1. `Gateway enabled`；
2. `Agent callable`；
3. `Approval required`。

开关和审批策略：

| 操作 | Mini App 首版 |
|---|---|
| 查看 catalog、status、revision | 允许 |
| reject/cancel/stop/disable | 允许，deny-only |
| 启用已配置的低风险 read tool | P1，可选，需确认、CAS、幂等、审计 |
| 精确批准一个既有 tool call | P1，绑定 ticket/args hash/expiry |
| 永久批准、Approve All、自动批准 Elicitation | 禁止 |
| secrets、Provider credential、HA token | 禁止 |
| write/message/device/purchase/admin tool enable | Mini App 禁止，跳转 Access step-up |
| spend limit、真实 payment、钱包 key | Mini App 禁止 |

### 5.5 游戏

游戏使用独立目录，不与工作台混排：

1. **Riddle**：首发；
2. 后续游戏（包括可能的 Sudoku）另写设计后再排序；
3. 内部零钱、房间装饰和成就属于延期 Arcade 能力。

高频规则由确定性游戏引擎执行，Opus 只参与叙事、对话和关键决策。任何游戏结果进入长期 Memory
前都需要明确 promotion；默认只保存在游戏 owner 与时间线 locator 中。

### 5.6 头像菜单

- Owner profile 与 Telegram binding configured status；
- Mini App session 和最近认证时间；
- 主题与严肃/人格化导航文案；
- 通知与安静时段 projection；
- 隐私、数据来源、授权、保留和导出入口；
- 内部零钱包（延期）；
- canonical Memory/Agent/MCP/TG/Ops 控制面 deep links；
- 登出并清除 Mini App session。

## 6. 唯一真源与域归属

| 事实 | Canonical owner | Mini App 职责 |
|---|---|---|
| persona、identity、长期记忆、recall、主模型 | Memory | 只读投影与显式 memory candidate/promotion UI |
| task、approval、Browser、Skills、Heartbeat、HTML artifact runtime | Agent | 展示、提交受限意图、精确 deep link |
| Provider、tool catalog、tool enabled、auth reference | MCP | 经 Agent/owner Service Binding 读取或 CAS mutation |
| TG owner/chat、Mini App session、展示、delivery/outbox | Telegram | BFF、认证、呈现和 transport |
| deployment、commit projection、route、health、version | Ops | 只读开发与基础设施状态 |
| Calendar event | 外部 Calendar owner | 只读 projection；write 由独立 adapter 和审批处理 |
| HA entity/device/area/state | Home Assistant | 只读 projection；控制保持独立安全门 |
| Health raw data、derived metrics | future Health owner | 只显示授权摘要，不复制原始数据 |
| Pin 与 memory promotion decision | Memory curation owner | 创建/删除 Pin；Pin 不等于长期 memory |
| Riddle session/oracle/history | Riddle owner | Mini App client/BFF，不复制 backend |
| 读书/观影/专注 session、批注、进度 | Agent Together DO | 确定性活动状态；Memory 只接显式 promotion |
| 内部零钱与游戏资产 | Agent Arcade DO | 延期显示和受限交易，不与真实成本混用 |

### 6.1 为什么 Pin 归 Memory curation

Pin 表达的是 Owner 对某个外部事实的长期策展意图，而不是源事实本身。Memory 只保存：

- source owner 与 opaque locator；
- 可选安全短标题；
- Owner 注释；
- pin category、创建时间、提醒时间和 retention；
- source tombstone 状态；
- 是否另行 promote 为长期 memory。

Pin 不保存完整 Calendar event、健康数据、工具结果、HA attributes 或聊天正文。`pin`、`reminder`、
`memory_candidate` 和 `long_term_memory` 是四种不同状态，不能由 UI 一键混写。

### 6.2 为什么不新增 Mini App 真源

Mini App 是 Telegram client。其本地状态只允许：theme、last tab、折叠状态和非敏感草稿。
任何跨设备有意义的事实必须写回 canonical owner。TG D1 不新增 MCP catalog、task、Calendar、
Health、Riddle 或 Arcade 的可写副本。

## 7. 联邦时间线合同

### 7.1 Event envelope

```ts
type TimelineEventEnvelope = {
  schemaVersion: 1;
  eventId: string;
  ownerDomain: string;
  sourceType:
    | "calendar" | "ops" | "agent" | "telegram" | "mcp"
    | "home_assistant" | "health" | "memory" | "together" | "game";
  sourceLocator: {
    routeTemplateId: string;
    locator: Record<string, string>;
  };
  occurredAt: string;
  observedAt: string;
  staleAfter?: string;
  title: string;
  summary?: string;
  status?: "info" | "success" | "warning" | "attention" | "unavailable";
  sensitivity: "private" | "sensitive" | "health";
  actions: Array<"open" | "pin" | "remind" | "approve" | "reject" | "stop">;
  correlation?: {
    traceId?: string;
    requestId?: string;
    taskId?: string;
    approvalId?: string;
    messageId?: string;
  };
};
```

每个 owner 提供 bounded timeline projection。BFF 并行读取、验证 schema、按 `occurredAt` 合并，
失败 owner 返回 `unavailable` sentinel。不得因一个 owner 不可达而把整个时间线缓存成旧的“正常”。

### 7.2 BFF projection cache

允许短 TTL 只读缓存，但必须保存 `ownerVersion | observedAt | staleAfter`。缓存没有 mutation API；
owner revision 变化时失效。Health 与 Calendar private event 默认不进入共享 edge cache。

### 7.3 Pin contract

```ts
type TimelinePin = {
  pinId: string;
  ownerId: string;
  sourceOwnerDomain: string;
  sourceEventId: string;
  sourceLocator: TimelineEventEnvelope["sourceLocator"];
  category: "important" | "later" | "discuss" | "memory_candidate" | "collection";
  note?: string;
  reminderAt?: string;
  sourceTitleSnapshot?: string;
  sourceState: "live" | "unavailable" | "deleted";
  createdAt: string;
  updatedAt: string;
  revision: number;
};
```

创建/修改 Pin 要求 `Idempotency-Key` 与 revision/CAS。Pin deep link 每次重新授权。源删除时只更新
`sourceState=deleted`；是否删除 Pin由 Owner 决定。

## 8. Opus 状态模型

Mini App 必须分开显示：

### 8.1 事实状态

- Memory inference/model/cache owner status；
- Agent Heartbeat mode、last real activity、next eligible window、usage；
- 当前 task/approval/attention；
- TG queue/outbox/delivery health；
- MCP/Skills/Browser/HA capability truth；
- Riddle/Arcade session state；
- raw owner timestamp 与 freshness。

### 8.2 陪伴叙事状态

Opus 可以基于事实状态生成一句 `status_line`，但必须：

- 带 `generatedAt`、`expiresAt` 与 source snapshot hash；
- 不声称模型拥有无法验证的持续意识或后台活动；
- 不掩盖 unavailable、attention、disabled；
- 不成为 scheduler、task、approval 或 health 判断的输入真源；
- 默认 ephemeral，不写普通聊天或长期记忆。

## 9. Calendar 映射

Calendar 数据源尚待 Owner 确认。接入时保持外部 Calendar 为真源。

### P0 read-only

- today/next/this week；
- event start/end/all-day/timezone；
- calendar label、busy/free 与受限标题；
- event deep link；
- Timeline projection 与 Pin；
- source unavailable 和 authorization expired。

### P1 write（另行授权）

- create/update/delete/invite 必须走 deterministic adapter；
- 显示 calendar、title、start/end、timezone、participants 和 recurrence diff；
- exact approval 绑定 operation、calendar ID、event ID、args hash、revision、expiry；
- 不允许 Opus 根据模糊自然语言静默删除、移动或邀请；
- recurring event 修改必须区分 one/following/all；
- Calendar write 不得通过 Browser 登录或表单自动化实现。

## 10. 开发进度与 Ops 映射

开发区只消费 verified evidence：

- repo/branch/commit；
- Worker deployment/version/traffic state；
- migration revision；
- typecheck/test/dry-run/QA result；
- taskId/ticket/intent/revision；
- current objective、strictly pending、blocked reason。

Ops 或 repo adapter 是源；Mini App 不解析 私有笔记库全文作为生产状态。自然语言“奏折”由 Opus
在这些 bounded facts 上生成，并明确区分已验证、观察中、未授权和计划中。

## 11. Home Assistant 映射

当前真实状态为 Operia HA Provider 未连接，Mini App 必须显示 `not_connected`，不能根据 HA Core
单独在线就显示“可用”。

未来只读投影依次包括：

- HA Core 与 MCP handshake；
- Provider `registered | connected | degraded | disabled | stale`；
- 首批 exposed sensor 的 bounded state；
- unavailable entity 与 last changed；
- canonical HA/MCP/Agent deep links。

HA control 不随 Mini App 状态卡开放。任何 `service | toggle | device` 继续遵守独立 HA Spec、
exact approval、call key、side-effect ledger 和 uncertain recovery。Mini App 首版只读。

## 12. Health 接口边界

Health 数据源待 Owner 在独立线程提供。本 Spec 只定义接入门：

1. 新建或确认 Health canonical owner；
2. 字段级 allowlist、采样频率、retention、删除与导出；
3. 原始数据与 derived metric 分开；
4. Opus 默认只收到明确授权的摘要，不收到完整原始序列；
5. 不自动进入 Memory、prompt cache stable prefix、日志或第三方 analytics；
6. 健康提醒是信息提示，不伪装成诊断；
7. 高敏感事件需要额外 reveal，而不是在锁屏或普通卡片直接展示；
8. timeline/pin 只引用 Health owner event，不复制 raw payload。

Health source 未完成独立 threat model 和字段映射前，UI 只显示 `not_configured`。

## 13. 一起读书、观影与专注

本节已对以下 Owner 指定参考项目做 2026-07-17 只读来源审查：

| 场景 | 上游快照 | 采用结论 |
|---|---|---|
| 共读 | `meowmana/coread@c1f80555` | 借交互合同和数据概念，暂不复制代码、不直接部署其 MCP/server |
| 观影 | `Kisera001/KI-CO@5a38f381` | 只拆观影室模式，暂不复制代码/素材，不接入其 persona、memory、provider 设置 |

`coread` 的 README 与 `package.json` 声明 MIT，但仓库没有 `LICENSE` 文件，GitHub 也未识别 license；
代码复用在作者补齐许可证或给出明确授权前保持 blocked。`KI-CO` 使用
CC BY-NC-SA 4.0；其代码、CSS、图片和音效若直接改编会带来署名、非商业与相同方式共享义务，
因此当前只把产品模式作为设计参考。未来公共/商业发行前必须重新做 license review。

### 13.1 Reading session

```ts
type ReadingSession = {
  sessionId: string;
  workRef: { source: string; id?: string; title: string };
  progress: { kind: "page" | "chapter" | "percent"; value: string };
  startedAt: string;
  endedAt?: string;
  notes: Array<{ id: string; text: string; createdAt: string }>;
  excerpts: Array<{ id: string; text: string; sourceLocation?: string }>;
  status: "active" | "paused" | "completed";
  revision: number;
};
```

限制 excerpt 数量和长度；不自动抓取整书。Opus 的讨论和总结进入普通对话前使用现有 Memory
pipeline；reading metadata 是否成为长期记忆由 Owner显式选择。

从 `coread` 保留的产品能力：EPUB/文本导入、分页阅读、划线、共享批注/回复、双方进度、目录、
批注导出，以及 AI 能在同一段落上下文中阅读和留言。实施时不原样运行其 Node + filesystem +
`better-sqlite3` backend；Mini App 使用 Operia 原生 owner：

```text
Mini App reading room
  -> TG BFF (owner session)
  -> Agent Together Service Binding
  -> one BookRoom SQLite DO per owner/book
  -> R2 private object for imported EPUB and derived images
  -> bounded parser Queue job
```

安全适配要求：

- 上游 HTTP/MCP 当前没有应用认证、允许 `Access-Control-Allow-Origin: *`，且暴露 import/delete/write；
  不能直接暴露公网、登记为 Operia Provider 或放进 Mini App browser；
- 上游 `COREAD_NOTIFY_CMD` 可执行任意 shell command；Operia 不移植该路径，批注事件只进入 durable
  intent/outbox，不向 tmux、webhook 或 Opus prompt 旁路注入；
- EPUB/ZIP 有压缩包大小、解压后大小、文件数、嵌套深度、路径穿越、MIME、图片像素和 CPU 限额；
- 原书、图片和完整段落不进入 Memory、timeline、日志或通用 HTML artifact；
- AI 默认只有 `list_books/read_page/list_comments`；`add_comment` 仅在 Owner 主动开启的 reading
  session lease 内可用，绑定 book/page/author/expiry/长度；import、delete、export 需要精确 UI 确认；
- 阅读进度由 UI/BookRoom owner 写入，不让模型自行推进；删除批注使用 revision/CAS 与 tombstone；
- 首版不做自动“新批注唤醒 Opus”；Owner 打开房间或点“叫他来看”才形成一次显式 companion intent。

### 13.2 Watch session

- title、provider reference、start/pause/end；
- `markMoment(timestamp, note?)`；
- 不读取 DRM stream、账号 cookie 或播放历史；
- 不控制第三方播放、购买或订阅；
- 散场聊天可生成一张安全 HTML 纪念卡并 Pin。

从 `KI-CO` 观影室保留的交互模式：本地视频、SRT/VTT/ASS/SSA 字幕、续看记录、字幕偏移、当前
时间点、前后字幕窗口、可选截图、陪看密度、手动/提示/自然触发点、片单和散场聊天。以下部分不
进入 Operia：其本地 persona/memory/diary/vector pages、浏览器内 Provider/API key、独立主模型与
prompt cache 真源。

Operia 适配边界：

- 媒体文件默认只留在 WebView/device；服务端只保存 title、duration、progress、mode、plan locator
  等 bounded metadata，不能把 `blob:` URL 或本机文件句柄当跨设备真源；
- 字幕默认本地解析；只在 Owner 明确发言、点“问 Opus”或授权生成 companion plan 时，发送当前
  cue 加前后 bounded window，不整份上传字幕；
- 截图默认关闭，每次附图必须有可见开关；发送前缩放、去元数据、执行隐私提示，不能后台连续截帧；
- local video 可以获得可靠 `currentTime`；第三方 embed/web page 只在平台允许时展示，不承诺读取
  时间点、字幕或截图，不绕 CORS、DRM、登录、付费墙或 iframe 限制；
- `manual` 不主动调用模型，`hint` 只显示本地触发提示，`natural` 只消费已生成 plan；播放中的每个
  time tick 不调用 Opus；
- 生成整片 companion plan 属于一次显式付费操作，展示字幕范围、模型、预算与预计调用；失败时
  回退本地 deterministic cue markers，而不是静默重试；
- WatchRoom DO 是跨设备 metadata 真源，本地存储仅作缓存；观影对话仍走 Operia Memory/Opus，
  watch record、subtitle 和截图不自动成为长期记忆。

### 13.3 Focus session

定时与状态由确定性 DO/alarms 管理；Opus 不按秒参与。结束时可以生成一次总结或 noop。通知走
TG durable outbox，不新建旁路推送真源。

## 14. 游戏架构

### 14.1 Riddle 首发

现有 Riddle 保持：

- `riddle-worker` 是 Riddle backend/UI owner；
- `riddle.example.com` 与 Cloudflare Access 独立 PWA 保留；
- Operia Riddle profile、vision route、server-side provider secret 保留；
- IndexedDB 历史仍是现有 PWA 的本机历史，不能冒充跨设备真源。

Mini App 接入方式：

```text
Telegram WebView
  -> tgbot.example.com/app/games/riddle/*
  -> Mini App BFF (validated owner session)
  -> RIDDLE_SERVICE Service Binding + dedicated bearer
  -> riddle-worker /service/miniapp/*
  -> existing Operia Riddle profile
```

要求：

- 不 iframe 当前 Access 页面，不伪造 `Cf-Access-Authenticated-User-Email`；
- Riddle 增加 base-path aware Mini App surface 或由 BFF 精确代理相对资源；
- `/service/miniapp/*` 只接受 Service Binding principal、dedicated bearer 和 owner scope；
- 浏览器永远看不到 `RIDDLE_OPERIA_API_KEY`；
- standalone PWA 与 Mini App 使用同一 Oracle contract；
- 共享历史若需要上线，必须先定义 Riddle server owner 和迁移，不读取/复制 PWA IndexedDB；
- deployment 顺序为 Riddle backward-compatible owner endpoint，然后 TG consumer；
- rollback 只移除 Mini App route/binding，独立 PWA 不受影响。

### 14.2 后续游戏门

Sudoku 与其他游戏当前只保留目录入口能力，不预设单人/合作/对战、Opus 参与方式、数据模型或
上线顺序。Owner 决定继续时再根据实际参考项目写独立 game spec；本轮不创建 engine、DO、route、
schema、asset 或 QA fixture。

### 14.3 Arcade DO

Arcade 是 Agent domain 内的独立 DO class，不是 TG 数据库。建议：

- parent 只管理 game/session locator；
- 每个 match/session 一个 child DO；
- SQLite 持久化重要状态，不能只依赖内存；
- WebSocket 使用 hibernation；
- 高频消息批量/节流，不为每个 UI tap 调 Opus；
- 部署和 DO migration additive，保留 PITR/rollback 计划。

## 15. HTML Artifact Renderer

HTML 分为三类，不能用一个“允许脚本”开关混合处理。详细合同见
`2026-07-17-operia-miniapp-artifacts-calendar-health-requirements.md`。

### 15.1 Safe HTML Card（首版）

用于 Opus 即时生成报告、时间表、对比卡、健康趋势解释、散场卡和任务总结：

- 输入只允许 bounded UTF-8 HTML/CSS；
- server-side sanitizer 移除 script、event handler、form、iframe、object、embed、base、meta refresh、
  external URL、SVG script、download、navigation 和危险 CSS；
- 使用 `iframe sandbox`，不授予 `allow-scripts`、`allow-same-origin`、`allow-forms`、popup、download、
  top navigation、camera、microphone、geolocation、payment 或 clipboard；
- CSP 至少为 `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none';
  connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox`；
- artifact frame 不持有 Mini App Cookie、Telegram initData、CSRF、bearer 或 Health raw data；
- 生成前后做 secret/result sanitizer；
- artifact 带 content hash、schema version、creator、createdAt、retention 和 source locators；
- 可以 Pin；Pin 不自动把 HTML 复制进 Memory prompt。

### 15.2 Interactive Capsule

用于 Opus 生成的本地计算器、筛选器、交互图表、轻量小游戏和 HTML 小作品：

- 使用 `iframe sandbox="allow-scripts"`，绝不授予 `allow-same-origin`；
- frame 是 opaque origin，不持有 Mini App Cookie、Telegram initData、CSRF、bearer 或 parent DOM；
- bundle 自包含，CSP 禁止 fetch/WebSocket/EventSource/sendBeacon、form、navigation、popup、download、
  camera、microphone、geolocation、payment 和 clipboard；
- 只允许固定 schema 的 resize、bounded state、ask_opus、pin、export parent bridge；
- frame 请求只形成原生确认 UI，不能直接调用工具或 owner API；
- Safe Document 先上线，Interactive Capsule 只有在 adversarial/mobile QA 通过后才开启独立 flag。

### 15.3 Trusted Interactive Module（延期）

Riddle 与未来游戏等交互应用不使用任意 HTML renderer，而是经过 review、版本化、签名并随正式
release 部署的 first-party module。未来若支持第三方 bundle，必须另写 sandbox/package spec，
使用隔离 origin 或 opaque-origin frame、capability-scoped MessageChannel、固定资源清单、无 ambient
session 权限和可撤销 module version。禁止同时给同源 frame `allow-scripts + allow-same-origin`。

## 16. 内部零钱包（延期）

内部零钱只服务陪伴和游戏：

- Agent Arcade DO 是 ledger owner；
- balance、transfer、gift、spend、reversal 都是 append-only entries；
- Opus 可以 propose reason，确定性规则决定实际金额；
- 不兑换法币/稳定币/链上资产，不购买真实 API 或 Provider credit；
- 与 usage/cost/x402 UI 视觉上分区并使用不同单位；
- daily allowance、per-action cap、negative-balance denial、idempotency 和 audit；
- 第一版不上链，不保存 mnemonic/private key，不启用 Agents SDK x402。

若未来接真实支付或链上钱包，必须独立 spec、step-up、hard budget、exact approval 和平台规则审查。

## 17. Mini App 认证与会话

### 17.1 Telegram bootstrap

1. 浏览器只把 `Telegram.WebApp.initData` 原串提交给 BFF；
2. BFF 使用 Bot token 派生密钥验证 HMAC，拒绝 `initDataUnsafe` 作为认证依据；
3. 校验 `auth_date` freshness、query/user JSON schema、bot ID、environment 和 replay nonce；
4. 精确匹配 configured Telegram owner user ID；chat context 存在时再匹配允许的 private owner chat；
5. `start_param` 只作为不敏感 locator，服务端重新授权；
6. 验证成功后换取短 TTL、HttpOnly、Secure、same-origin Mini App session；
7. mutation 继续要求 Origin、CSRF、Idempotency-Key、revision/CAS；
8. logout/expiry/owner binding 变化立即失效。

Mini App session 不写入 URL、localStorage、DeviceStorage 或 HTML artifact。SecureStorage 也不保存
bot token、service bearer、wallet key 或 Health data。

### 17.2 Cloudflare Access

Telegram WebView 不能依赖 Owner 每次完成 Google Access 交互。实施计划必须建立最窄路径例外：

- 只覆盖 Mini App 静态 shell 与 `/api/miniapp/*`；
- 静态 shell 不含私有数据；
- 所有 API 均由应用层 Telegram owner session 保护；
- `/admin`、canonical control pages 和其他域名继续 Access；
- WAF/rate limit/body limit 保留；
- 不创建整域 Bypass，不开放 `workers.dev`；
- 例外必须有 owner、用途、过期/回滚条件和逐 path 匿名 smoke。

高风险配置、secret、HA write、真实 payment 和 permanent trust 仍跳转 Access-protected step-up。TG chat
与 Mini App 由同一 Telegram 账号控制，不视为独立第二因素。

## 18. BFF 与跨域 API

建议新增：

```text
GET  /app
GET  /app/*
POST /api/miniapp/session
DELETE /api/miniapp/session
GET  /api/miniapp/bootstrap
GET  /api/miniapp/today
GET  /api/miniapp/timeline
POST /api/miniapp/pins
PUT  /api/miniapp/pins/:id
DELETE /api/miniapp/pins/:id
GET  /api/miniapp/workbench
POST /api/miniapp/approvals/:id/decision
POST /api/miniapp/tasks/:id/control
GET  /api/miniapp/games
GET  /app/games/riddle/*
GET  /app/games/sudoku/*
POST /api/miniapp/html-artifacts
GET  /api/miniapp/html-artifacts/:id
```

规则：

- BFF 只调用 Service Binding，不通过 public custom domain 或 workers.dev 回环；
- 每个 downstream 使用独立 service bearer 和 principal scope；
- read fan-out 有总 subrequest budget、timeout 和 partial unavailable；
- body、timeline count、HTML bytes、Pin note 和 query range 有硬上限；
- URL 只允许 opaque locator；
- response 统一 no-store，健康和 Calendar 私密数据禁止 CDN cache；
- correlation envelope 保留 trace/request/task/approval/message IDs；
- downstream mutation 由最终 owner 校验，BFF 不替 owner作授权决定。

## 19. 数据最小化与隐私

- 不接第三方行为分析、广告 SDK、session replay 或跨站 tracker；
- 前端错误只上传固定 error category、route ID、build version 和 trace ID；
- Telegram name/photo 不是授权依据，显示时可关闭；
- Calendar title、Health metric、Memory snippet、Riddle image 分别按 sensitivity redaction；
- Mini App 后台/锁屏不可显示 Health 或敏感 Calendar 详情；
- screenshot 无法被完全阻止，UI 必须提供 privacy mode；
- Riddle handwriting image 不进入通用 timeline；timeline 只显示安全标题和 session locator；
- HTML artifact 不能引用带 token 的 URL、data exfiltration endpoint 或 owner Cookie；
- 本地缓存只保留非敏感 UI state，退出时可一键清理。

## 20. Control Registry 与 manifest

实施时新增 route templates 和 definitions，至少包括：

| Canonical key / fact | Owner | Rule |
|---|---|---|
| `telegram.miniapp.enabled` | Telegram | default false，Owner deploy 后显式开启 |
| `telegram.miniapp.session_ttl` | Telegram | owner hard max，channel 不可放宽 |
| `telegram.miniapp.presentation.theme` | Telegram | preference |
| `telegram.miniapp.timeline.sources` | Telegram presentation | 只能隐藏来源，不能扩大 owner visibility |
| `memory.curation.pins` | Memory | CAS + owner-only |
| `agent.html_artifacts.policy` | Agent | deny-only，首版 safe card only |
| `agent.arcade.games` | Agent | versioned catalog，默认 Riddle locator only |
| `agent.arcade.internal_currency` | Agent | default disabled |
| Calendar/Health/HA projection | 各最终 owner | Mini App 只消费，不设复制开关 |

`telegram.miniapp.timeline.sources` 只是显示过滤，不决定 downstream 权限。每个共享参数在 UI 显示
owner、effectiveSource、revision、observedAt 和 canonical deep link。

## 21. 失败语义

- owner unavailable：显示该卡 unavailable，其他卡继续；
- stale projection：显示最后时间与 stale badge，不当作当前事实；
- auth expired：清 session，要求重新从 Bot 打开；
- owner mismatch/replay：401/403，固定错误类别，不泄露哪个字段不匹配；
- CAS conflict：返回 409/412 并重新读取，不静默覆盖；
- approval expired/already consumed：只读显示 terminal，不创建新 ticket；
- Riddle Oracle timeout：保留现有可见 fallback 和 abort；
- HTML sanitizer rejection：显示明确 blocked category，不回退执行原 HTML；
- unknown Telegram delivery：attention，不宣称 exactly-once；
- Health/HA not configured：显示 not_configured/not_connected，不伪造空数据为正常。

## 22. 分期计划

### Phase 0：设计、auth 与只读 shell

- 完成 owner matrix、route registry、Access path threat model 和 API contracts；
- 建立 `/app` shell、Telegram initData validation、short session、CSRF；
- 只读 `今日/时间线/工作台`，数据源限现有 Memory/Agent/MCP/TG/Ops；
- source unavailable/stale、deep link 与 privacy mode；
- 不开放 mutation、Riddle、Calendar、Health、HA 或 HTML。

### Phase 1：Pin、低风险控制、Riddle 与安全 HTML

- Memory curation Pin API 与 timeline UI；
- task stop/reject/cancel、精确 approval/Elicitation UI；
- MCP read catalog 与低风险开关 CAS；
- Riddle Service Binding/BFF route，保留 standalone PWA；
- Safe HTML Document 创建、渲染、Pin 与 retention；
- Interactive Capsule opaque sandbox、本地交互、bounded state bridge 与独立 feature flag；
- Owner-only mobile/tablet E2E。

### Phase 2：Calendar 与一起

- Calendar read-only projection；
- `coread` clean-room reading contract、BookRoom DO/R2/Queue 与共读 session lease；
- `KI-CO` cinema interaction subset、WatchRoom DO 与 local-first media/subtitle boundary；
- reading/watch/focus sessions；
- reminder 与 Calendar write 另行审批；
- 共读/观影先分别完成 license、copyright、privacy、mobile WebView 与 paid-call QA；
- Sudoku 留作后续单独设计，不阻塞 Phase 2。

### Phase 3：HA 与 Health

- HA P0 provider 完成后接 read-only projection；
- Health 独立 Spec 完成后接摘要与 timeline；
- sensitive reveal、retention、export/delete 和 health-specific QA；
- 不在本阶段开放 HA control。

### Phase 4：Arcade 与内部零钱

- 内部 ledger、礼物、游戏资产与愿望单；
- 不接链、不接 x402、不购买真实资源；
- 观察实际使用后再决定 trusted third-party module 或链上身份。

## 23. 自动验收矩阵

### 23.1 Auth/security

- valid initData + fresh auth_date + exact owner succeeds；
- tampered hash、expired auth_date、wrong user/chat、replay fail；
- `initDataUnsafe` 和 `start_param` 单独不能授权；
- session cookie 不出现在 URL/storage/log；
- mutation 缺 Origin/CSRF/idempotency/revision fail；
- anonymous Mini App static shell 无私有数据，API 全部 401；
- admin/control routes 继续 Access 302，未出现整域 Bypass。

### 23.2 Owner consistency

- timeline 每个 event 恰好一个 owner；
- projection 包含 ownerVersion/observedAt/staleAfter；
- owner unavailable 不回退到 TG copy；
- MCP toggle 使用 Gateway revision/CAS；
- task/approval mutation 由 Agent canonical ledger 消费；
- Pin 不复制 source payload，不自动写 long-term memory。

### 23.3 Timeline/Pin

- 多 owner 事件稳定排序与 cursor pagination；
- duplicate eventId 去重；
- source delete 变 tombstone；
- Pin create retry returns same pin；
- stale revision conflict refreshes safely；
- Health/Calendar sensitive summary redaction。

### 23.4 Riddle

- standalone PWA 保持工作；
- Mini App owner session 通过 Service Binding 调同一 Oracle；
- 浏览器无 provider secret；
- Access header 不被 BFF 伪造；
- clear/new stroke abort 旧请求；
- image、model、timing 与 session locator 不泄露到通用 timeline；
- Riddle owner rollback 后 Mini App 明确 unavailable。

### 23.5 HTML

- script/event/form/iframe/object/external URL/dangerous CSS 被移除或拒绝；
- no network、no storage、no cookie、no parent DOM、no top navigation；
- CSP/sandbox headers 生效；
- secret-bearing fixture 无法渲染或保存；
- content hash、retention、Pin 和 delete 正常；
- sanitizer fail 不回退 raw HTML。

### 23.6 Together

- 未澄清 license 时构建物不包含上游代码、CSS、图片或音效；
- `coread` HTTP/MCP 无公网直连，任意 shell notifier 不存在；
- EPUB archive bomb、路径穿越、超限图片和超预算解析 fail closed；
- AI 批注仅在 active reading lease 的指定 book/page 范围内成功；
- 本地影片、完整字幕和文件句柄不上传；发给 Opus 的字幕窗口保持 bounded；
- screenshot 未显式开启时无截图 payload；
- playback time tick 不触发模型调用，paid plan 每次都有显式确认与 usage；
- third-party embed 不可观察时诚实降级，不绕 CORS/DRM/login/paywall。

### 23.7 Non-regression

- Heartbeat armed/active/dry-run 不被 Mini App view 激活；
- opening/refreshing Mini App 不创建 paid inference；
- TG chat、reaction、reply、8-second trailing edge 保持；
- Browser、MCP Elicitation、Fiber、continuation、outbox 全绿；
- HA 保持 disabled/not_connected，Voice 保持当前状态；
- no provider enable、paid media、wallet、x402 or external send smoke。

## 24. 生产验收

每次只指导 Owner 一个动作，并以 locator/telemetry 为证据。

1. Bot 按钮打开 `/app`，回读 build/version、owner session 和 no-private-data-before-auth；
2. `今日` 与 canonical owner 页面同 revision/observedAt；
3. `时间线` 一个 Agent task、一个 TG event 和一个 Ops deploy 能双向 deep link；
4. 创建一个 Pin，刷新/重开仍存在，source 未被复制到 TG D1；
5. reject/stop 一个专用无副作用 QA task，ticket 只消费一次；
6. 打开 Riddle，完成一次 Owner 手写回合，standalone PWA 无回归；
7. 渲染一个安全 HTML fixture，验证脚本与网络被阻断；
8. Calendar/Health/HA 在未接入时诚实显示 not_configured/not_connected；
9. 检查 D1/DO/outbox：无意外 heartbeat activity、paid inference、tool task 或 delivery。

生产验收不以自动测试替代 Owner 可见证据，也不为了制造 timeline 数据调用付费服务。

## 25. Rollout 与回滚

### Rollout

1. owner API/additive schema 向后兼容部署；
2. target Workers（Memory/Agent/Riddle）先部署兼容 service endpoints；
3. TG BFF 和 static shell 后部署；
4. 只读环境验证后才设置精确 Access path 例外；
5. BotFather Main Mini App/menu button 最后启用；
6. 从 owner-only/read-only 开始，逐 phase 打开 feature flag；
7. 每个 phase 保留独立 disable flag，不依赖删除路由回滚。

### Rollback

- 先将 `telegram.miniapp.enabled=false` 并恢复 menu button；
- 移除精确 Access path 例外，回到原 Access catch-all；
- TG route 回滚不影响 webhook、admin、outbox 或 chat；
- Riddle Mini App route 关闭不影响 standalone PWA；
- additive tables/DO state 保留只读，不做破坏性删除；
- owner APIs 保持兼容观察期后再通过普通 commit 清理。

## 26. Observability

保留以下 bounded telemetry：

- auth success/failure category、session issue/expiry；
- route、status、latency、owner fan-out availability；
- timeline source freshness、Pin mutation、CAS conflict；
- approval/task locator 与 terminal state；
- Riddle/Together session locator、duration、error category；
- HTML sanitizer rule counts、artifact size/hash；
- build/registry/owner revisions。

禁止记录 initData 原文、Cookie、CSRF、Calendar 正文、Health raw samples、Riddle handwriting image、
HTML 原文、prompt、tool result、secret 或 wallet material。

## 27. 实施前仍需 Owner 提供

以下输入不会阻塞 Spec 审查，但会阻塞对应 phase：

1. Calendar 实际数据源与希望开放的读/写范围；
2. Health 数据源、字段、采样频率、保留与敏感展示偏好；
3. 共读/观影希望保留的具体交互；参考仓库已收到，license clarification 仍会阻塞代码复用；
4. Mini App 视觉参考、主题偏好与是否保留人格化导航别名；
5. 内部零钱的名称、获得/花费规则和是否需要跨设备；
6. 是否在 Phase 1 同时开放低风险 MCP enable，或先保持 deny-only。

## 28. Definition of Done

Mini App 只有同时满足以下条件才算完成：

- Telegram initData server validation、exact owner、short session、CSRF 和 path-scoped Access 例外通过；
- 所有事实只有一个 owner，timeline 与 workbench 无可写副本；
- Today/Timeline/Together/Workbench/Games 在 390px、iPad 和 desktop WebView 可用；
- Pin、approval、task control、Riddle 和 HTML artifact 有精确审计与回滚；
- Health/Calendar/HA 的未配置和 stale 状态诚实；
- Browser、Elicitation、Fiber、MCP lifecycle、Heartbeat 和 TG durable delivery 无回归；
- 没有启用真实 payment、x402、wallet、HA control、paid media 或危险 Provider；
- 自动测试、Wrangler dry-run、secret scan、owner-visible production QA 和回滚演练完成；
- spec、Control Registry、manifest、运维主线与部署版本记录同步。

## 29. 参考

- [Telegram Mini Apps](https://core.telegram.org/bots/webapps)
- [Telegram Mini App deep links](https://core.telegram.org/api/links)
- [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Cloudflare Durable Objects best practices](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Content Security Policy Level 3](https://www.w3.org/TR/CSP/)
- [WHATWG iframe sandbox](https://html.spec.whatwg.org/multipage/iframe-embed-object.html)
- [meowmana/coread](https://github.com/meowmana/coread)
- [Kisera001/KI-CO](https://github.com/Kisera001/KI-CO)
