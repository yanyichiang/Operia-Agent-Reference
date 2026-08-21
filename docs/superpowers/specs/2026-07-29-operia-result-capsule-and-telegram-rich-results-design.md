---
title: Operia Result Capsule 与 Telegram Rich Results 设计
date: 2026-07-29
status: gate_a_c_local_recipe_matrix_implemented
transport_superseded_by: 2026-07-30-operia-telegram-native-result-cards-v2-design.md
scope: MCP tool results, Agent result normalization, channel-neutral presentation capsules, Telegram RichMessage rendering, media artifacts, Mini App escalation, fallback and durable delivery
depends_on:
  - 2026-07-14-operia-federated-control-plane-design.md
  - 2026-07-14-operia-p1-tool-loop-reasoning-owner-transfer-design.md
  - 2026-07-27-operia-think-codemode-tool-orchestration-v2-design.md
  - 2026-07-28-operia-cloudflare-sdk-first-slimming-design.md
implementation_authorized: gate_a_c_local_only
production_authorized: false
provider_call_authorized: false
telegram_canary_authorized: false
owner_decisions_confirmed:
  - formal_name
  - p0_recipe_set
  - explicit_blocks_only
  - google_pin_and_nearby_map_only
  - gate_a_c_local_only
  - mini_app_and_mcp_apps_deferred
engineering_principles_confirmed:
  - deterministic_script_before_model
  - cost_effective_model_before_claude_family
  - bounded_observable_cost_without_over_optimization
---

# Operia Result Capsule 与 Telegram Rich Results Spec

> **2026-07-30 纠错：**本文关于 Telegram Bot API 存在 `sendRichMessage`、`sendRichMessageDraft`、
> rich table/map/details blocks 的描述不成立。对应 transport、renderer、fallback、Gate B/E 与 method
> allowlist 设计已由 `2026-07-30-operia-telegram-native-result-cards-v2-design.md` 取代。本文仍可作为
> Result Capsule、normalizer、recipe、attribution、幂等与历史实施记录参考，但不得再作为 Telegram
> sender 的实现依据，也不得把内部 `sendRichMessage` 测试对象解释为真实 Telegram 能力。

> 本文件现已获得 Gate A-C 纯本地实现授权，并记录对应合同实现；它仍然不是上线授权。当前授权不包括
> 修改生产 flag、部署 Worker、调用真实 MCP/Provider、发送 Telegram canary、启用付费 API、增加 Secret、
> 修改 Gateway 工具开关或扩大 Owner/QA cohort。Gate D/E 仍需分别重新授权。

## 0. 先用一句话理解它

当前工具调用的用户体验大致是：

```text
工具返回 JSON
  -> Operia 用自然语言总结
  -> Telegram 显示“已经完成”
```

目标体验是：

```text
工具返回事实
  -> Agent 把事实整理成一份跨渠道的 Result Capsule
  -> Telegram 把 Capsule 渲染成原生 RichMessage
  -> 用户看到地图、表格、图片、折叠详情和按钮
  -> 同一份 Capsule 在其它渠道仍可降级为图片或纯文本
```

`Result Capsule` 不是图片文件，也不是一段任意 HTML。它是一份受限、可验证的结构化 JSON，
描述“这次工具结果里有哪些事实、应该按什么语义呈现、可以提供哪些安全操作、纯文本兜底是什么”。

最重要的分工是：

- MCP 工具负责返回真实数据；
- Agent 负责把不一致的工具结果规范化、清洗并生成 Capsule；
- Telegram 负责把 Capsule 翻译成 Telegram 支持的消息；
- Memory/Opus 负责自然语言最终回答，但不直接拼 Telegram HTML；
- durable outbox 继续负责“到底有没有可靠送达”。

### 0.1 名称消歧：这里没有复活旧 Gateway

本文出现的“MCP Gateway”只指当前 Operia V1 的外部 MCP capability/registry/relay Worker，也就是
为 Agent 提供 tool catalog、provider route 和 auth reference 的那一层。它不指已经废止、masked 并归档的
旧 `operia-gateway` unified backend。Result Capsule 不依赖旧 Gateway 的模型路由、Memory 路由、VPS
service 或任何已废止控制面，也不构成恢复它们的提案。

## 1. 为什么现在值得做

Telegram Bot API 10.1/10.2 已提供原生 Rich Messages。官方能力包括：

- heading、paragraph、list、table；
- map；
- photo、video、audio、voice note、animation；
- collage、slideshow；
- details 折叠块、引用、脚注、公式；
- `sendRichMessageDraft` 的短暂流式预览；
- `sendRichMessage` 的最终持久消息；
- 与消息绑定的 inline keyboard。

这意味着 Operia 不必再把所有“卡片”预先画成一张扁平图片。地图、表格、折叠详情和媒体可以
优先使用 Telegram 原生块；只有折线图、复杂时间轴、路线示意和品牌化视觉才需要生成 PNG/WebP，
真正需要筛选、缩放、拖拽或表单时才进入 Mini App。

官方依据：

- [Telegram Bot API 10.2 Rich Messages](https://core.telegram.org/bots/api#rich-messages)
- [sendRichMessage](https://core.telegram.org/bots/api#sendrichmessage)
- [sendRichMessageDraft](https://core.telegram.org/bots/api#sendrichmessagedraft)
- [MCP tool result content](https://modelcontextprotocol.io/specification/2025-11-25/schema#calltoolresult)
- [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)

## 2. 一次真实调用会怎样变成卡片

以下用“帮我找静安寺附近适合聊天的咖啡店”为例。

### 2.1 用户发出请求

Telegram Worker 继续只负责接收消息、建立 `request_id`、进入现有 Memory/Think/Agent 工具链。
本 Spec 不改变 webhook、debounce、chat leader、工具选择或 MCP 执行 owner。

### 2.2 Operia 选择现有 MCP 工具

Think/Agent 可能调用：

```text
google-maps/google_maps_places_search
```

MCP 返回的是事实，例如地点 ID、名称、地址、坐标、评分、评价数和 Google Maps URL。MCP 不需要
知道 Telegram 怎样画卡片，也不需要返回 Telegram HTML。

### 2.3 Agent 规范化事实

Agent 先把 provider-specific JSON 变成 `NormalizedToolResult`：

```json
{
  "toolKey": "google-maps/google_maps_places_search",
  "status": "success",
  "items": [
    {
      "id": "place-1",
      "title": "示例咖啡店",
      "subtitle": "静安区示例路 1 号",
      "location": { "latitude": 31.223, "longitude": 121.445 },
      "facts": {
        "rating": 4.7,
        "userRatingCount": 328,
        "businessStatus": "OPERATIONAL"
      },
      "links": [
        { "rel": "canonical", "url": "https://www.google.com/maps/..." }
      ]
    }
  ]
}
```

这一步负责 schema 校验、字段长度、URL/媒体安全、敏感字段、结果数量和 attribution，不负责视觉。

### 2.4 Recipe 把事实编译成 Capsule

工具注册表把该结果映射到 `place.search` recipe。recipe 不重新请求 Provider，只决定信息层级：

```text
标题：静安寺附近
摘要：找到 5 个地点
主块：地图
次块：前三个地点的评分/距离表格
详情：折叠其余结果
操作：打开地图、查看下一批
兜底：可独立阅读的纯文本
```

### 2.5 Telegram renderer 翻译成 RichMessage

Telegram renderer 将语义块确定性映射为 `InputRichMessage.blocks`，把操作映射为
`reply_markup.inline_keyboard`。它不会把 MCP 原始字符串当 HTML 运行。

### 2.6 最终消息走 durable outbox

RichMessage 和普通文本一样进入现有 Telegram outbox：

```text
Capsule compiled
  -> TelegramIntent persisted
  -> leased
  -> sending
  -> Telegram accepted
  -> sent + telegram_message_id
```

网络超时后的未知发送结果仍然不能盲目重试。卡片漂亮不能牺牲 delivery truth。

### 2.7 旧客户端或渲染失败时降级

降级顺序固定为：

```text
Telegram RichMessage
  -> 普通媒体消息 + caption + inline keyboard
  -> 普通 HTML/text message
  -> fallback_text
```

只有 Telegram 明确返回“请求未被接受”的确定性 4xx 时，才允许在同一逻辑投递中改发降级版本。
timeout、连接中断、5xx 或无法判断的结果必须进入现有 unknown/attention 路径，不能因为想兜底而
重复发一条普通消息。

## 3. 决策摘要

1. 新增渠道无关的 `operia.presentation/v1` Result Capsule 合同。
2. MCP `CallToolResult` 与 Result Capsule 是两层合同；不要求所有第三方 MCP 理解 Telegram。
3. Agent 拥有 normalize、recipe、artifact 与跨渠道 presentation compilation。
4. Telegram 拥有 RichMessage renderer、渠道开关、draft/final、outbox 与 delivery event。
5. Telegram P0 使用 explicit blocks，不直接信任模型或工具生成的 Rich Markdown/HTML。
6. P0 不引入 MCP Apps iframe，也不把任意 MCP HTML 塞入 Telegram Mini App。
7. 每个 Capsule 必须有可独立阅读的 `fallbackText`。
8. P0 首批覆盖 Google Maps、网易云和 generic execution receipt。
9. P0 使用录制且脱敏的 fixture；真实 Provider call、Telegram canary 和生产 activation 分别审批。
10. HA、设备写、Memory 私密写、购买/下单不作为首批验证对象。
11. 能由确定性脚本完成的 normalize、校验、recipe、渲染和 fallback 不调用模型；确需模型时优先使用满足质量门槛的性价比模型，Claude 系列不作为默认工程依赖，并以可观测预算防止意外账单。

## 4. 目标

### 4.1 产品目标

- 工具完成后给用户一个“可看、可点、可展开”的结果，而不只是完成提示；
- 不同工具有自己的信息结构和视觉重点，同时保持 Operia 一致的语气和可靠性；
- 地点、媒体、指标、列表、文档、执行回执等常见结果都有稳定 recipe；
- 用户不离开聊天即可理解主要结果；复杂交互才打开 Mini App；
- 无论渲染是否成功，用户都能收到准确的文本答案。

### 4.2 工程目标

- MCP、Agent、Telegram 不产生三份相互漂移的卡片业务逻辑；
- schema、recipe、renderer 和渠道能力可以分别版本化；
- presentation failure 不改变工具是否成功的事实；
- presentation 不扩大工具权限，不创造未经授权的新外部动作；
- RichMessage delivery 复用现有 outbox、幂等、unknown outcome 与恢复合同；
- 不在日志、URL、按钮、媒体地址和 fixture 中泄露 secret 或敏感正文。

## 5. 非目标

P0 不做：

- 不让每个 MCP 返回任意 HTML/CSS/JavaScript；
- 不建立一套通用网页设计系统或完整低代码 UI builder；
- 不让模型自由决定 callback、URL、写操作或危险按钮；
- 不接管 Memory 最终回答、Think 工具选择或 Agent policy；
- 不让 Telegram 直接读取 Gateway credential 或 provider raw result；
- 不把图表、地图或媒体二进制长期写入对话 D1；
- 不默认保存 Google Maps/Places/Street View 等受缓存条款约束的内容；
- 不自动开启尚未 connected 的 HA；
- 不自动启用网易云播放 URL、麦当劳订单、设备控制或 Memory mutation；
- 不部署、不迁移、不发真实 Telegram 消息。

## 6. 当前基线

### 6.1 已有可复用能力

- Agent 已有工具目录、风险、审批、幂等、结果清洗与媒体生命周期；
- Telegram 已有 durable outbox、delivery state、final-only 与段落气泡；
- Telegram draft preview 已与 canonical final 分离，preview failure 不影响 final；
- `src/tg/media.ts` 已能从部分工具结果识别 `agent-media:` 和首张 HTTPS 图片；
- `src/tg/telegram.ts` 已有 Telegram intent allowlist，但当前未允许 `sendRichMessage`；
- Gateway 已有 Google Maps、高德、网易云、麦当劳与 custom provider 的 authoritative catalog；
- Google Maps 现有结果包含地址、坐标、评分、路线距离/时长和 canonical map URL。

### 6.2 当前缺口

- 媒体识别是 ad hoc 的 `images[0].url`，不是结构化 presentation contract；
- 同一个工具在不同调用路径可能返回不同 JSON 包装层；
- 没有 `ResultCapsuleV1`、recipe registry、renderer capability 或 snapshot tests；
- Telegram sender allowlist 不含 RichMessage；
- 没有把 presentation artifact 与 canonical final/outbox 关联的稳定 ID；
- Google Maps 当前 provider 不返回 Place Photo、Static Map 或 Street View；
- 生产 MCP execution projection 的最新现场状态与 Gateway catalog 状态曾不一致，不能把 fixture PASS
  写成 Operia live connected。

## 7. 唯一 Owner 与职责

| 事实或能力 | Canonical owner | 本 Spec 中负责 | 明确禁止 |
| --- | --- | --- | --- |
| MCP provider、tool enable、schema、auth ref | MCP Gateway | 提供 authoritative tool descriptor/output | TG/Agent 复制 enable 真源 |
| Tool execution、risk、approval、idempotency、sanitizer | Agent | 规范化结果、recipe、artifact、Capsule | Capsule 绕过 policy 或重做工具 |
| Persona、对话、最终自然语言回答、模型 usage | Memory | 生成 canonical final text，消费工具结果 | Telegram 自行总结事实 |
| Telegram formatting、draft/final、buttons、outbox、delivery | Telegram | 把 Capsule 渲染并可靠投递 | Telegram 保存 MCP registry/credential |
| Operia 客户端视觉偏好 | Operia client | 将来消费同一 Capsule | 成为工具数据或 policy owner |
| 第三方 attribution/cache policy | 数据 Provider + Agent enforcement | 随 Capsule 保留并执行 | renderer 静默删除署名/期限 |

### 7.1 Presentation metadata 放在哪里

Gateway tool descriptor 可以声明非权威的 presentation hint，例如：

```json
{
  "presentation": {
    "recipe": "place.search",
    "outputSchemaVersion": "google-maps.places-search/v1"
  }
}
```

它只帮助 Agent 选择 adapter，不授予 MCP 直接控制 Telegram。Agent 的 recipe registry 才是
executable presentation contract；Telegram renderer 只接受已经通过 Agent 编译的 Capsule。

## 8. 合同分层

### 8.1 Layer A：原始 MCP 结果

遵守 MCP `CallToolResult`：

```ts
type CallToolResult = {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
```

优先级：

1. 若 `structuredContent` 存在且通过对应 output schema，作为结构化事实；
2. `content` 中的 image/audio/resource link 作为候选资产；
3. text 用作摘要或 legacy parser 输入；
4. `_meta.ui.resourceUri` 只表示该 MCP 可能支持 MCP Apps，不自动成为 Telegram UI。

### 8.2 Layer B：NormalizedToolResult

```ts
type NormalizedToolResultV1 = {
  schema: "operia.tool-result/v1";
  toolKey: string;
  providerId: string;
  taskId: string;
  toolCallId: string;
  status: "success" | "partial" | "empty" | "failed";
  title?: string;
  summary?: string;
  items: NormalizedItem[];
  assets: PresentationAsset[];
  sources: PresentationSource[];
  warnings: string[];
  sensitivity: Array<"public" | "owner_private" | "account" | "health" | "location" | "device">;
  attribution: Attribution[];
  cachePolicy: CachePolicy;
  rawResultHash: string;
  normalizedAt: string;
};
```

Normalizer 必须确定性运行，不调用模型。无法识别 provider-specific schema 时进入 generic normalizer，
不得猜测字段含义。

### 8.3 Layer C：Result Capsule

```ts
type ResultCapsuleV1 = {
  schema: "operia.presentation/v1";
  capsuleId: string;
  capsuleHash: string;
  taskId: string;
  toolCallIds: string[];
  recipe: PresentationRecipeKey;
  status: "success" | "partial" | "empty" | "failed" | "attention_required";
  title: string;
  summary?: string;
  blocks: PresentationBlock[];
  actions: PresentationAction[];
  assets: PresentationAsset[];
  sources: PresentationSource[];
  attribution: Attribution[];
  sensitivity: string[];
  cachePolicy: CachePolicy;
  fallbackText: string;
  presentationRevision: string;
  createdAt: string;
  expiresAt?: string;
};
```

`capsuleHash` 对 canonical JSON 计算。相同 task/tool results/recipe revision 必须生成同一 hash，
便于 replay、snapshot 和 delivery reconciliation。

### 8.4 Presentation blocks

P0 只允许：

```ts
type PresentationBlock =
  | HeadingBlock
  | ParagraphBlock
  | FactListBlock
  | MetricBlock
  | TableBlock
  | MapBlock
  | MediaBlock
  | GalleryBlock
  | DetailsBlock
  | DividerBlock
  | SourceListBlock
  | NoticeBlock;
```

共同约束：

- 所有字符串在编译前转为纯文本值；
- block 数量、嵌套深度、表格行列、媒体数量和总字符均有低于 Telegram 官方上限的内部 hard limit；
- `DetailsBlock` 最多嵌套一层；
- `TableBlock` P0 最多 4 列、10 个可见行，其余进入 details 或文本附件；
- `GalleryBlock` P0 最多 10 个媒体；
- `MapBlock` 只接受校验后的有限经纬度和 zoom；
- 未知 block type 在 schema validation 阶段拒绝，不静默运行。

### 8.5 Actions

```ts
type PresentationAction = {
  id: string;
  label: string;
  kind: "open_url" | "callback" | "open_mini_app" | "copy_text";
  style?: "primary" | "secondary" | "danger";
  urlRef?: string;
  callbackRef?: string;
  requiresApproval: boolean;
  expiresAt?: string;
};
```

约束：

- Capsule 只保存 bounded reference，不把原始 args、token、任意 URL 或完整结果塞入 `callback_data`；
- callback 仍经过 Telegram exact clicker/chat/thread/bot/env/nonce 校验；
- `danger` 只改变展示，不构成授权；
- 任何写、购买、设备或删除动作都必须重新进入 Agent canonical policy/approval；
- P0 recipe 只允许 read-only callback 与 canonical HTTPS URL。

## 9. Recipe Registry

### 9.1 为什么不让每个工具随便画

如果每个 MCP 自己输出 HTML：

- Telegram、Codex、PWA 会出现三套实现；
- 第三方字符串可能形成 HTML、URL、callback 或媒体注入；
- provider schema 变化会直接破坏渠道；
- attribution、缓存和敏感字段无法统一执行；
- delivery replay 难以判断“同一结果”还是“新卡片”。

因此使用有限 recipe：工具拥有自己的信息结构，但不拥有任意渲染代码。

### 9.2 Recipe definition

```ts
type PresentationRecipe = {
  key: PresentationRecipeKey;
  version: string;
  supportedToolKeys: string[];
  inputSchema: JsonSchema;
  allowedBlocks: PresentationBlock["type"][];
  maxItems: number;
  compile(result: NormalizedToolResultV1): ResultCapsuleV1;
};
```

P0 registry：

| Recipe | 首批工具 | 主要块 |
| --- | --- | --- |
| `place.search` | Google `places_search` | map、table、details、sources |
| `place.details` | Google `place_details` | facts、map、notice、actions |
| `route.summary` | Google `directions` / `distance_matrix` | table、details、sources；上游无坐标时不虚构 map |
| `music.search` | NCM `search` / `artist` | media、table、details |
| `music.playlist` | NCM `playlist` | media、table、source |
| `music.lyric` | NCM `lyric` | heading、paragraph、details |
| `execution.receipt` | 所有工具 | notice、facts、details、sources |
| `generic.result` | 未注册只读结果 | paragraph、table 或 preformatted fallback |

### 9.3 Tool-specific personality

每个 recipe 可以定义：

- 信息顺序；
- icon key；
- hero media role；
- metric label；
- empty/partial/error 文案；
- 是否优先地图、媒体、表格或 details；
- 允许哪些 read-only action。

Telegram 原生 RichMessage 不允许任意品牌色、字体、阴影和圆角，因此“个性”主要来自内容层级、
媒体、图标和措辞。需要完整品牌视觉时使用受控生成图片；需要交互时使用 Mini App。

## 10. Telegram Renderer

### 10.1 映射

| Capsule block | Telegram RichMessage |
| --- | --- |
| heading | section heading |
| paragraph | paragraph |
| fact list | list 或两列表格 |
| metric | heading + marked value / small table |
| table | rich table |
| map | `InputRichBlockMap` / `<tg-map>` |
| media | photo/video/audio/voice block |
| gallery | collage 或 slideshow |
| details | details block |
| divider | divider |
| sources | footer/list/reference |
| notice | block quote / marked paragraph |

P0 renderer 使用 explicit block objects。Rich Markdown/HTML 只用于 renderer 自己产生的已转义 fallback，
不接受工具或模型的 raw markup。

### 10.2 Rich draft 与 final

```text
best-effort preview:
  sendRichMessageDraft

canonical durable final:
  compile complete Capsule
  -> persist outbox
  -> sendRichMessage
```

规则：

- draft 最长 30 秒，只用于 private chat 可见预览；
- draft 不写 canonical delivery success；
- draft 不上传新文件，媒体只使用已可引用的安全 asset；
- final 必须重新从完整 Capsule 编译，不把 draft 当最终消息复制；
- final 失败不因 draft 曾出现而标记成功；
- preview failure 永不触发工具、模型或 final retry。

### 10.3 Method allowlist

Telegram sender 必须显式允许且逐方法校验：

```text
sendRichMessage
sendRichMessageDraft（只走 preview sender）
editMessageText（仅已知 message ownership）
sendPhoto/sendVideo/sendAudio/sendVoice
sendMessage
setMessageReaction
```

不能因为 payload 带 `method` 就把任意 Bot API 方法透传出去。

### 10.4 降级判定

```ts
type TelegramRenderPlan = {
  primary: TelegramIntent;
  deterministicFallbacks: TelegramIntent[];
  reason: string;
  capsuleHash: string;
};
```

- schema/size/asset 不支持：发送前选择 fallback；
- Telegram 明确 400 且响应证明 primary 未接受：允许尝试下一 fallback；
- 401/403：权限或 token 故障，进入 attention，不 fallback；
- 429：遵守 retry-after 和 outbox policy，不改发另一种消息；
- timeout/connection reset/5xx：outcome unknown，不发送 fallback；
- 发送成功但本地落状态失败：按既有 message ID/unknown reconciliation，不再发一份。

## 11. 媒体、图表与 Mini App

### 11.1 PresentationAsset

```ts
type PresentationAsset = {
  id: string;
  kind: "image" | "video" | "audio" | "voice" | "document";
  source: "agent_media" | "provider_url" | "generated_artifact";
  mediaRef?: string;
  url?: string;
  mimeType: string;
  width?: number;
  height?: number;
  bytes?: number;
  sha256?: string;
  attributionIds: string[];
  expiresAt?: string;
  cachePolicy: CachePolicy;
};
```

### 11.2 远程媒体

- 只允许 HTTPS；
- URL 中不得有 userinfo、token、secret-like query；
- host、redirect、DNS 解析、private/link-local/metadata IP 按 egress policy 校验；
- provider URL 若会过期，必须设置 `expiresAt`；
- Telegram 是否抓取远程 URL不应暴露长期 provider key；
- secret-bearing signed URL 优先由 Agent 安全取回，再生成短生命周期 `agent-media:` reference；
- attribution 必须与媒体同屏或紧邻展示。

### 11.3 图表

Telegram 没有通用 chart block。P1 才增加 deterministic chart renderer：

```text
Metric/series data
  -> allowlisted chart spec
  -> server-side renderer
  -> PNG/WebP artifact
  -> Agent media lifecycle
  -> Telegram photo block
```

禁止模型直接生成 SVG/HTML 后未经清洗发送。图表数据仍保留文本/表格 fallback。

### 11.4 Mini App escalation

只有以下情况升级 Mini App：

- 需要筛选、排序、缩放、地图拖动；
- 需要多步骤表单；
- 需要实时刷新 dashboard；
- 结果远超 RichMessage 的舒适阅读范围；
- 需要 MCP App 类交互。

P0 不自动把 MCP App `ui://` iframe 转成 Telegram Web App。未来桥接必须：

- 由 Agent/Telegram host 重新托管或安全代理；
- 使用 Telegram initData HMAC、Owner scope、Origin 和短会话；
- CSP/egress allowlist；
- 不让第三方 MCP App 直接继承 Operia cookie、credential 或 tool authority；
- UI 发起的每个工具调用重新经过 Agent policy。

## 12. Attribution、缓存与隐私

```ts
type CachePolicy = {
  mode: "no_store" | "transient" | "provider_allowed";
  maxAgeSeconds?: number;
  refreshRequired?: boolean;
};

type Attribution = {
  id: string;
  label: string;
  url?: string;
  required: boolean;
  placement: "inline" | "caption" | "footer";
};
```

规则：

- Provider 返回的 attribution 不得由 recipe 或 renderer 删除；
- `no_store` 资产只能在本次投递生命周期中短暂处理；
- provider 允许缓存的标识符与不允许缓存的图片内容分开处理；
- 位置、健康、账号、设备等 Capsule 默认 `owner_private`；
- 日志只保存 recipe、hash、block count、asset count、状态和时延，不保存完整 Capsule 正文；
- fixture 必须人工脱敏，不包含真实住址、账号、token、cookie、设备标识或私人 Memory；
- Telegram 按钮 URL 不携带完整 result、prompt 或敏感 locator。

## 13. Generic execution receipt

即使工具没有专属 recipe，也自动生成最小回执：

```text
✓ Google Maps · places_search
找到 5 个结果 · 842 ms

关键结果
  第一项：示例咖啡店
  状态：可用

▸ 查看执行详情
来源：Google Maps
```

回执事实来源：

- tool key 与 provider；
- Agent canonical status；
- sanitized bounded summary；
- elapsed time；
- result item count；
- warning/partial/attention；
- Agent run deep link locator。

不显示：

- task/token/secret 的原始值；
- 完整 args 或结果；
- hidden reasoning；
- 内部 bearer、provider request header；
- 不应暴露的 Owner/account 标识。

若专属卡片已包含 execution footer，默认不额外再发一张回执，避免每个工具产生消息洪水。

## 14. 首批 Recipe 详细范围

### 14.1 Google Maps P0

工具：

- `google_maps_places_search`；
- `google_maps_place_details`；
- `google_maps_directions`；
- `google_maps_distance_matrix`。

首版只使用现有返回值：

- 名称、地址、坐标；
- 评分与评价数；
- 营业状态；
- Google Maps URL；
- 路线距离、时间、起终点；
- provider warnings/copyrights。

P0 不增加 API：

- 不调用 Street View Static；
- 不调用 Maps Static；
- 不增加 Place Photos field mask；
- 不修改 GCP key API restrictions；
- 不新增付费或缓存责任。

未来 P1 media enrichment 单独审批，并要求 metadata availability check、attribution、no-store 和预算。

### 14.2 网易云 P0

P0 从当前 NCM read-only catalog 中先选择：

- `search`、`artist`、`playlist`、`lyric`。

`song`、`album`、`pic` 虽在 Gateway catalog 中，但不进入首轮 recipe；这不会改变它们原有的
enable/disable 状态。

首版：

- 搜索列表；
- 歌手/专辑/歌单摘要；
- 若现有安全结果包含公开封面 URL则显示，否则不补抓；
- 歌词默认只显示短摘要与折叠结果，遵守版权和输出长度限制；
- 不开放播放 URL、cookie、账号 mutation 或平台选择参数。

### 14.3 Generic receipt P0

覆盖所有成功、partial、empty、failed、attention 工具结果。它是协议 fallback，不是第二次工具调用。

### 14.4 后续但不进入 P0

- 高德天气、路线和周边；
- 麦当劳只读菜单、营养、优惠券和附近门店；
- <HOME_DEVICE_A>/<HOME_DEVICE_B> 只读状态；
- Health/Calendar；
- Memory 读写；
- 购买、设备控制、消息发送和删除。

## 15. 与模型的关系

### 15.1 P0：模型不编译卡片

P0 完全确定性：

```text
raw result -> normalizer -> recipe -> Capsule -> renderer
```

Opus 仍生成最终自然语言回答，但不能：

- 生成 raw Telegram blocks/HTML；
- 创造工具没有返回的评分、距离、状态或 URL；
- 增加 callback；
- 选择危险 action；
- 删除 attribution；
- 把 failure 改写为 success。

### 15.2 P1：允许 bounded emphasis hint

未来模型可以建议“哪三项最值得展示”，但只能返回 item ID 和有限枚举：

```json
{
  "featuredItemIds": ["place-1", "place-3"],
  "emphasis": "distance",
  "summaryStyle": "concise"
}
```

Agent 重新验证 ID、数量和事实；hint 无效时忽略。模型永远不直接产生 executable action 或 markup。

### 15.3 Operia 的脚本、模型与成本选择原则

后续 Operia Agent 开发默认按以下顺序决策：

1. **脚本优先**：确定性转换、schema 校验、policy、幂等、hash、fallback、renderer、路由与预算检查由代码完成；
2. **轻量模型优先**：只有语义理解、开放式总结、歧义消解等确实需要模型的环节才使用模型，并优先选择满足质量门槛的性价比模型；
3. **Claude 非默认依赖**：Claude 系列可以在明确需要其质量且预算允许时单独选择，但不得成为每次工具调用、卡片编译或工程控制面的隐式默认；
4. **成本可观测且有上限**：按 provider/model/功能记录 usage，保留单次与周期预算、超限 fail-closed 或显式降级；
5. **不过度压价**：不为省极少费用引入难维护的多层路由、重复摘要或明显降低结果质量；工程简约、正确性和可维护性与合理成本共同优化；
6. **不得并发烧钱**：同一逻辑步骤默认不并发调用多个付费模型“赛马”，除非有单独实验授权、预算和可归因指标。

Result Capsule P0 因此是零模型编译链路。自然语言 final 仍由 Memory 的 canonical 模型路径负责，但 presentation failure
不得额外触发模型补救或重写。

## 16. 可靠性与幂等

### 16.1 Identity

```text
task_id
  + tool_call_ids
  + normalized_result_hash
  + recipe_key/version
  + renderer_key/version
  + channel
  = presentation identity
```

建议字段：

- `capsule_id`；
- `capsule_hash`；
- `presentation_revision`；
- `delivery_batch_key`；
- `telegram_intent_key`；
- `telegram_message_id`。

### 16.2 原则

- 工具成功与 presentation 成功是两个事实；
- recipe 编译失败不重跑工具；
- renderer 失败不调用模型补救；
- exact replay 复用同一 Capsule hash；
- 同一 Capsule 的 primary/fallback 属于一个逻辑 delivery，必须有确定性 intent key；
- 多个气泡/媒体按现有 delivery batch FIFO，不能让后续结果越过前一个 unknown；
- 卡片已被 Telegram 接受后，不因本地 cleanup 失败重复发送；
- 媒体 cleanup 是 best effort，R2/Artifact lifecycle 继续作为兜底。

## 17. 控制面 Key

### 17.1 Agent owner

| Key | 初始值 | 策略 |
| --- | --- | --- |
| `agent.presentation.capsule.enabled` | false | deny-only |
| `agent.presentation.capsule.schema_version` | `v1` | replace within envelope |
| `agent.presentation.recipe_registry_revision` | build-derived | read-only |
| `agent.presentation.generated_artifacts.enabled` | false | deny-only |
| `agent.presentation.mcp_apps_bridge.enabled` | false | deny-only |

### 17.2 Telegram owner

| Key | 初始值 | 策略 |
| --- | --- | --- |
| `telegram.presentation.rich_results.enabled` | false | deny-only |
| `telegram.presentation.rich_results.mode` | `native_with_fallback` | replace within envelope |
| `telegram.presentation.rich_draft.enabled` | false | deny-only |
| `telegram.presentation.rich_results.max_media` | 10 | numeric-min |
| `telegram.presentation.rich_results.max_blocks` | internal safe limit | numeric-min |

Agent 不拥有 Telegram 是否展示 RichMessage；Telegram 不拥有 recipe 或 MCP output adapter。

## 18. 数据与事件

P0 优先复用现有 task/tool/outbox 表，不立即建立完整 Capsule 内容库。建议只增加 bounded projection：

```text
presentation_capsules
  capsule_id
  task_id
  capsule_hash
  recipe_key
  recipe_version
  status
  block_count
  asset_count
  sensitivity_json
  expires_at
  created_at

presentation_events
  capsule_id
  stage
  status
  renderer
  duration_ms
  error_class
  created_at
```

是否真的需要新表由 Gate A fixture 实现决定。若现有 Agent task artifact 已能保存同等 projection，
优先复用，避免第二真源。完整 Capsule 正文默认不写长期日志。

事件阶段：

```text
tool_result_received
normalized
capsule_compiled
asset_prepared
rendered
outbox_persisted
telegram_accepted
fallback_selected
attention_required
```

所有事件继承现有 `trace_id/request_id/task_id/tool_call_id`。

## 19. 安全威胁模型

### 19.1 Tool output injection

攻击：工具返回 `<tg-map>`、`javascript:`、伪 callback 或巨量 Markdown。

防护：

- 所有 provider 字符串按 text；
- explicit blocks；
- URL scheme/host/length allowlist；
- unknown field 拒绝或丢到 bounded generic text；
- 内部 block/字符/媒体上限低于 Telegram hard limit。

### 19.2 Media SSRF / credential leak

攻击：图片 URL 指向内网、metadata、redirect 或含 token。

防护：

- egress policy；
- DNS/redirect recheck；
- secret-like query/header rejection；
- 需要时由 Agent 抓取并转换为短期 media reference；
- 不让 Telegram 直接抓取含长期 credential 的 URL。

### 19.3 Action authority confusion

攻击：只读卡片伪造“确认删除”按钮，或旧按钮在新 task 中复用。

防护：

- actions 来自 recipe allowlist；
- callback 仅保存 opaque scoped ref；
- exact Owner/chat/thread/task/capsule/expiry/nonce；
- 写操作重新进入 canonical approval；
- presentation 本身不授予 capability。

### 19.4 Sensitive result exposure

攻击：账号、地址、健康、设备信息进入群聊卡片、日志或 link preview。

防护：

- Capsule sensitivity 与 channel scope 交叉检查；
- P0 只允许 Owner private 和固定 QA fixture；
- account/health/location/device 默认不允许公开 URL preview；
- logs/hash/projection 不保存正文；
- room route 继续严格使用注册的 chat/thread triple。

## 20. 分阶段实施 Gate

### Gate 0：接受 Spec

产物只有本文件。无代码、依赖、migration、Provider、Telegram 或部署。

### Gate A：合同与 fixture

范围：

- `ResultCapsuleV1` schema；
- normalizer/recipe interfaces；
- Google、NCM、generic receipt 的脱敏 contract fixture；首次纯本地实现允许使用与当前 wrapper 源码精确对齐的合成数据，进入 Gate E 前再用单独授权的现场结果补充录制 fixture；
- canonical hash 与 snapshot tests；
- attribution/cache/sensitivity tests。

限制：本地、零网络、零模型、零 Telegram、零外部写。

### Gate B：Telegram renderer local

范围：

- explicit RichMessage blocks；
- method allowlist；
- fallback plan；
- fake Telegram API acceptance/400/429/timeout/5xx；
- draft/final independence；
- outbox identity/replay tests。

限制：不真实发送 Telegram，不部署。

### Gate C：现有 MCP result integration local

范围：

- 将 source-conformant recorded/synthetic `CallToolResult` 贯通到 Capsule；
- 验证现有 Google/NCM 包装层；
- 不调用真实 Provider；
- 不修改 Gateway tool enable 或 credential。

### Gate D：flags-off rollout

需 Owner 单独授权。只部署 schema/renderer/registry，所有新 key=false；不发 Telegram、不调用 MCP。

### Gate E：Owner-only field QA

需 Owner 再次单独授权，并且必须先确认：

- Agent 当前 Gateway MCP projection 非空且 revision 对齐；
- 没有 live/unknown delivery 或 continuation 阻塞；
- RichMessage Bot API 方法对当前 bot 可达；
- 只选一个现有 read-only 工具；
- 一次自然 Owner 请求；
- 无付费 media enrichment；
- 回读 Agent/Capsule/outbox/Telegram message ID。

首个 field QA 建议使用 `google_maps_places_search` 的原生 map + table，不启用 Street View。

### Gate F：扩展 recipe / artifact / Mini App

只有 P0 观察稳定后再逐项审批。每个新增 provider recipe 只增加展示，不自动增加工具权限。

## 21. 测试矩阵

### 21.1 Contract

- valid/invalid Capsule schema；
- unknown block/action 拒绝；
- canonical hash 稳定；
- recipe version 变化导致新 hash；
- fallbackText 必填且可独立阅读；
- attribution/cache/sensitivity 不可被 renderer 丢失。

### 21.2 Normalizer

- Google 0/1/5/10 results；
- 缺评分、缺地址、ZERO_RESULTS、partial warnings；
- directions 多 route/leg；
- NCM 空搜索、超长标题、歌词长度；
- legacy text-only MCP；
- image/audio/resource link content blocks；
- secret-like key/value/URL 被拒绝或脱敏。

### 21.3 Renderer

- map/table/details/collage；
- Unicode、中文、emoji、RTL；
- escape `<>&` 和 link text；
- block/media/character/table limits；
- external media unavailable；
- native -> media caption -> text fallback；
- inline keyboard callback/url validation。

### 21.4 Delivery

- Telegram 200 accepted；
- definitive 400 before acceptance -> fallback once；
- 401/403 -> attention；
- 429 -> bounded retry policy；
- timeout/5xx -> unknown, no fallback send；
- success then local state failure -> no duplicate；
- multi-intent FIFO；
- outbox replay exact capsule hash；
- draft failure does not alter final。

### 21.5 Security

- raw rich HTML/Markdown injection；
- `javascript:` / `tg://` unapproved link；
- private IP / metadata / redirect media；
- token in URL/query；
- callback task/scope/nonce drift；
- account/location result routed to unauthorized room；
- attribution removal attempt；
- oversized/deeply nested payload。

### 21.6 Regression

- ordinary text chat；
- paragraph bubbles；
- existing photo/voice delivery；
- tool approval card；
- final-only and known-final recovery；
- no-message/empty result；
- Telegram room/private isolation；
- feature flags false reproduces current behavior。

## 22. 建议文件级改造

Gate A 候选：

```text
src/agent/presentation/types.ts
src/agent/presentation/normalize.ts
src/agent/presentation/compile.ts
src/agent/presentation/recipes/genericReceipt.ts
src/agent/presentation/recipes/googleMaps.ts
src/agent/presentation/recipes/ncm.ts
src/agent/presentation/artifacts.ts
```

Gate B 候选：

```text
src/tg/richResults.ts
src/tg/richResultRenderer.ts
src/tg/richResultFallback.ts
src/tg/draftPreview.ts
src/tg/telegram.ts
src/tg/outbox.ts
```

共享类型应由 Agent owner 定义，Telegram 只依赖稳定 transport DTO；不能把 Agent 内部 raw result 类型
直接暴露成 TG D1 schema。

建议 verifier：

```text
scripts/verify-result-capsule.mjs
scripts/verify-result-recipes.mjs
scripts/verify-telegram-rich-results.mjs
scripts/verify-rich-result-delivery.mjs
```

## 23. 可观测性与成功指标

记录：

- Capsule compile success/fallback/error；
- recipe key/version；
- blocks/assets/actions count；
- compile/render/persist/send latency；
- native/fallback renderer；
- Telegram definitive reject/unknown；
- attribution present；
- outbox replay/duplicate prevented。

不记录完整结果正文。

P0 通过门槛：

- fixture contract 100% PASS；
- raw markup injection 0；
- secret URL leak 0；
- presentation 导致工具重复执行 0；
- unknown outcome 后 fallback duplicate 0；
- feature flags off 时现有行为完全一致；
- 首个 Owner field QA 只产生一次 MCP call、一个 Capsule、一个逻辑 delivery；
- 用户不展开 details 也能在首屏理解主要结果。

## 24. Rollback

回滚优先使用 feature flags：

1. `telegram.presentation.rich_results.enabled=false`；
2. `agent.presentation.capsule.enabled=false`；
3. 恢复现有 final text + media intents；
4. 保留 Capsule projection、outbox 和 delivery evidence；
5. unknown delivery 不重发；
6. 不删除 additive schema，不 force-push、不 amend；
7. recipe/renderer 版本回滚不能改变工具执行 receipt。

## 25. 完成定义

P0 只有同时满足以下条件才完成：

- MCP raw result 与 Capsule 分层清楚；
- Agent 是唯一 normalize/recipe/artifact owner；
- Telegram 是唯一 RichMessage/draft/final/delivery owner；
- 三类首批 recipe 与 generic fallback 完成；
- 每个 Capsule 都有准确 fallbackText；
- raw HTML、危险 URL、callback 和 media 不能越过 schema/sanitizer；
- definitive rejection 与 unknown outcome 的 fallback 语义不制造重复消息；
- attribution/cache/sensitivity 贯穿；
- 完整 unit/contract/integration/security/regression 测试通过；
- 本地和 flags-off 证据不被误报为 live Provider/Telegram PASS；
- 任何 production field QA 都有独立 Owner 授权、精确回读和回滚点。

## 26. Owner 决策账本

2026-07-29 已确认：

1. 正式技术名称使用 `Operia Result Capsule`，用户界面称“结果卡片”；
2. P0 首批为 Google Maps、网易云和 generic execution receipt；
3. P0 Telegram 使用 explicit blocks，不接受 MCP/模型 raw Rich Markdown/HTML；
4. Google P0 首次只显示一个定位大头针和周边地图/结果，不增加 Street View、Place Photos 或 Static Maps API；
5. Gate A-C 仅本地 fixture 与 fake Telegram，不真实调用 Provider、不发 Telegram；
6. Mini App 与 MCP Apps bridge 延后到 P1/P2；
7. 后续 Operia 工程遵循“能用脚本不用模型；确需模型时优先性价比模型、Claude 系列非默认；成本合理且可观测，但不以牺牲工程质量为目标”的原则。
8. 2026-07-29 Owner 单独授权 Gate D flags-off rollout；授权仅覆盖 Agent/TG schema、renderer、registry 与双重 false 开关的部署，不延伸到 Gate E、真实 MCP/Provider、模型调用、Telegram canary、sender allowlist、D1 migration 或卡片启用。

Owner 同时明确授权 Gate A-C 纯本地实现。该授权不延伸到 Gate D/E、production flag、部署、真实 Provider、
Telegram canary、Secret 或 Gateway tool enable 变更。

## 27. Gate A-C 本地纵向切片实现记录（2026-07-29）

当前实现已增加：

- Agent-owned `NormalizedToolResultV1` / `ResultCapsuleV1` 类型、strict runtime validation、canonical hash；
- Google Maps `places_search` / `place_details` / `directions` / `distance_matrix`、NCM `search` / `artist` / `playlist` / `lyric`、generic execution receipt 的确定性 normalizer 与首批 recipe；
- Google P0 的单定位针、周边表格和纯文本 fallback，不含任何 media enrichment；
- 地点详情使用单对象 relay envelope 编译为 map + fact list + 安全 Google Maps action；路线与距离矩阵只展示上游已有的地址、距离、时间和状态，上游没有路线坐标时不虚构地图或折线；
- 歌手、歌单和歌词使用 Meting-Agent 现有 envelope 编译；长歌词进入有界 paragraph + details，不额外调用模型摘要；
- Telegram-owned explicit block renderer、draft/final 独立 intent 和 delivery decision helper；
- 与当前 Google relay 文本 JSON envelope、Meting-Agent 1.6.11 `{ok, operation, platform, data}` envelope 对齐的脱敏合成 fixture；
- fake Telegram 200/400/401/403/429/5xx/timeout 验证；只有确定性 400 可选择 fallback，unknown outcome 不补发；
- raw markup、unknown block/field、secret-like key/query、attribution/cache/sensitivity、stable replay hash 验证。

本地验证命令：

```text
npm run typecheck
npm run verify:result-capsule
```

本地 recipe matrix 已补齐对应的脱敏合成 contract fixture 与 deterministic replay 验证。严格未完成：尚未在单独授权下录制真实
Google/NCM Provider 结果 fixture；未发送 Telegram，未修改生产 sender allowlist、outbox schema、feature flag、D1 或 Worker，
也没有部署或形成任何 live delivery 证据。Street View、Place Photos、额外媒体 enrichment 与 Mini App 继续延后。Gate D 已获单独授权并进入 flags-off rollout；Gate E 继续 HOLD。

## 28. Gate D flags-off rollout 记录（2026-07-29）

Owner 已单独授权 Gate D。候选基于当前生产源码合并，新增：

- Agent `AGENT_RESULT_CAPSULE_ENABLED=false` 与内部 deny-by-default registry endpoint；
- Telegram `TG_RICH_RESULTS_ENABLED=false` 与内部 deny-by-default renderer registry endpoint；
- production entry/type/config 接线及 flags-off 路由回归；
- 生产 Telegram sender allowlist 保持不含 `sendRichMessage`，未增加 outbox/D1 schema。

候选 commit <COMMIT> 已推送私有 SSH 分支。`npm run verify` 完整通过；Result Capsule 专测与
Agent/TG Wrangler dry-run 均通过，且两个构建包内分别可见 normalizer/compiler 与 renderer/delivery helper，
两个新变量均为显式 false。验证没有调用 MCP、Provider model 或 Telegram，也没有进行 D1 migration。

发布前通过临时跨脚本 Durable Object binding 读取生产 `runtimeSnapshot().freezeState`。第一次精确结果
`2026-07-29T10:35:22.976Z` 为 `liveTasks=3`、`liveApprovalTickets=0`、`unknownSideEffects=0`；
约两分钟后的复核 `2026-07-29T10:37:16.823Z` 仍为 `liveTasks=3`，且状态聚合明确为
`executing=3`。因此 Gate D 在任何 Agent/TG production mutation 前按本 Spec fail-closed 停止。

随后对三条记录做了只读任务级诊断，纠正“正在真实执行/等待自然结束”的初始表述：它们分别创建于
2026-07-27/28，之后从未更新；全部 `fiber_id=null`，按 idempotency key 也查不到 Fiber，progress revision=0、
checkpoint round/callCount=0、pending tool=null，且 side effect、Provider attempt、elicitation、Browser execution
均为 0。这三条是“创建后未进入执行器”的 orphan `executing` 状态行，不会自然结束，也没有可重放的外部结果。

Owner 随后明确授权 exact-ID 清理并继续 Gate D。临时维护端点在任何写入前再次验证三条记录仍满足上述全部
orphan 条件，并且先验证全部三条、再调用现有 `cancelDelegatedTask()` 终态路径；没有启动 Fiber、resume 或 replay。
本次只处理以下 task ID：

- `think-code-thinkcall:1:tool:tg:6109a59ffa9a04ecda6e614aad31de123b85a371f32b0deb1175639671da1386`
- `think-tg:100c9a81736e419a9cb5746ae05405646773725ce5ad55c405c5becd50d906ab:system-status:1`
- `think-tg:e27147b0d821f6f48796359bf72fd5485386fbdff5908ce7a0cbd75ed9ef5371:system-status:1`

清理返回 `verified=3`、`cancelled=3`；`2026-07-29T10:59:00.551Z` 的即时快照和
`2026-07-29T10:59:03.461Z` 的独立 fresh read 均为 `liveTasks=0`、`liveApprovalTickets=0`、
`unknownSideEffects=0`，后者同时确认 `activeTasks=0`。因此按既定 Agent → TG 顺序继续部署。

Agent deployment/version 更新为 `<UUID>` /
`<UUID>` 100%；版本回读确认原 66 个绑定全部保留，只新增
`AGENT_RESULT_CAPSULE_ENABLED="false"`。Agent root 继续由 Access 返回 302；部署后 freeze read 仍为三项全 0。
TG deployment/version 更新为 `<UUID>` /
`<UUID>` 100%；原 73 个绑定全部保留，只新增
`TG_RICH_RESULTS_ENABLED="false"`。只读 smoke 为 `/app=200`、unsigned webhook `401`、`/admin=302`。
最终 `2026-07-29T11:02:28.829Z` freeze read 仍为三项全 0、`activeTasks=0`。

临时诊断 Worker 每次都通过 trap 恢复 inert version `<UUID>` 100%，最终根路径
为 410。精确回滚点保留为 TG `<UUID>` → Agent
`<UUID>`；本次验证全部通过，未触发回滚。

严格状态：**Gate D flags-off rollout COMPLETE / both flags false / no rich-result sender enabled / freeze state zero /
Gate E HOLD**。本轮没有真实 MCP/Provider/model 调用，没有 Telegram message、D1 migration、Secret、route、Access、
cohort 或 sender allowlist 变更；这不是 live card delivery 证据。下一门仍需 Owner 单独授权 Gate E field QA。
