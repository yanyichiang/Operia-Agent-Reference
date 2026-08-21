---
title: Operia Telegram 原生结果卡 V2 设计
date: 2026-07-30
status: proposed_for_owner_review
scope: Result Capsule compatible projection, Telegram native messages, inline keyboard, Mini App deep links, Calendar, Health, NCM
supersedes:
  - 2026-07-29-operia-result-capsule-and-telegram-rich-results-design.md#telegram-transport
depends_on:
  - 2026-07-14-operia-federated-control-plane-design.md
  - 2026-07-17-operia-telegram-mini-app-life-console-design.md
  - 2026-07-29-operia-result-capsule-and-telegram-rich-results-design.md
implementation_authorized: false
production_authorized: false
provider_call_authorized: false
telegram_canary_authorized: false
---

# Operia Telegram 原生结果卡 V2 Spec

> 本文件仅供 Owner 审阅。确认本 Spec 不自动授权实现、部署、真实 Provider 调用或 Telegram
> canary。后续若 Owner 说“按 Spec 开干”，默认只授权本地代码、fixture 与测试；部署和自然消息
> field QA 仍分别确认。

## 0. 一句话结论

Operia 不再尝试发送不存在的 Telegram `sendRichMessage`，而是把同一份 Result Capsule
确定性投影成 Telegram Bot API 真实支持的原生消息：

```text
地图       -> sendLocation + sendMessage + inline keyboard
有封面结果 -> sendPhoto + caption + inline keyboard
普通结果   -> sendMessage + inline keyboard
完整交互   -> 点击按钮进入受保护 Mini App 或 Provider 官方页面
```

Calendar、Health 和网易云音乐共用一个 Telegram 原生投影底座。它们的差异只存在于薄 recipe、
按钮目标和隐私/版权规则中，不各自维护一套 sender。

## 1. 为什么需要 V2

### 1.1 已确认的错误前提

旧 Spec 把内部抽象 `sendRichMessage` 当成 Telegram Bot API 正式方法，并据此设计 heading、table、
map、details 等 rich blocks。当前生产代码实际上没有、也不能调用这个方法；兼容层只做了：

```text
若 Capsule 有 map -> sendLocation
始终             -> fallbackText via sendMessage
```

因此出现三个用户可见结果：

1. Google Maps 看起来较丰富，因为它恰好能投影为 Telegram 原生定位消息；
2. Calendar 虽有专用 `calendar.agenda` recipe，最终仍像普通文本；
3. Health 没有专用 recipe，NCM 虽有 recipe 但没有 action，二者都没有底部跳转按钮。

### 1.2 V2 保留什么

以下 V1 设计仍然正确并继续保留：

- `operia.tool-result/v1` 规范化层；
- `operia.presentation/v1` Result Capsule；
- Agent-owned deterministic recipe；
- `fallbackText`、attribution、sensitivity、cache policy；
- capsule hash 与 presentation revision；
- Telegram-owned outbox、FIFO、unknown-send 和 no-blind-replay；
- presentation failure 不重跑工具、不调用模型补救。

### 1.3 V2 删除什么

以下对象不得再出现在生产 sender 或生产可达 runtime：

- `sendRichMessage`；
- `sendRichMessageDraft`；
- 假想的 Telegram table/map/details rich block payload；
- “Telegram rich primary 失败后再发 fallback”的虚假两阶段 transport。

内部语义 block 仍可存在于 Result Capsule，但只能作为跨渠道信息结构；Telegram renderer 必须把
它们降维到真实 Bot API 方法，而不是把 block 原样透传。

## 2. 产品目标

1. 用户在聊天里先看懂结果，不必只看到“已完成”或原始工具回执；
2. 每张卡至少有标题、核心事实、状态/来源，以及在有安全目标时出现的底部按钮；
3. Calendar 和 Health 点击后直接进入现有 Mini App 对应详情页；
4. NCM 点击后进入网易云官方歌曲、歌单或歌手页面；
5. Google Maps 保留定位针与 Google Maps 跳转；
6. 未特化 MCP 也得到稳定的 generic card，而不是 raw JSON；
7. 卡片与 Operia 的 canonical final 都能送达，互不冒充、互不覆盖；
8. 全链路由确定性脚本完成，不新增模型调用和隐性费用。

## 3. 非目标

P0 不做：

- 不在 Telegram 气泡里实现任意 HTML/CSS 卡片；
- 不为 Calendar 或 Health 新建 PWA；
- 不为 NCM 新建播放器、播放队列或账号态 Mini App；
- 不把 NCM 临时音频 URL 转发为 `sendAudio`；
- 不补抓 Street View、Static Map、Place Photo 或额外地图 API；
- 不让模型选择布局、按钮、URL、callback 或强调项；
- 不把 MCP Apps iframe 自动嵌入 Telegram；
- 不修改 MCP enablement、Provider credential、risk 或 approval；
- 不修改 Memory tools、instructions、tool choice、cache breakpoints 或 final barrier；
- 不改写 Telegram canonical append-only conversation history；
- 不新增 D1 migration，除非实现阶段证明现有 outbox 无法表达必要 intent。

## 4. 用户体验模型

一轮有工具调用的自然对话包含两个不同对象：

```text
MCP 事实 -> Result Capsule -> Telegram 结果卡
Memory final             -> Operia 自然语言回复
```

结果卡不是 Operia 的思考过程，也不是 final 的替代品。默认顺序为：

```text
1. 关闭或替换非 canonical draft preview
2. 投递一个或多个 Result Capsule 原生 intent
3. 投递仍未作为 durable paragraph 送出的 canonical final bubbles
4. 媒体 intent 按现有规则排在相应逻辑位置
```

若 durable paragraph 已经发送 canonical final 的前缀，最终 batch 只发送剩余 bubbles，不复制前缀。
任何 internal reasoning、provider reasoning 或 draft-only 内容都不得进入卡片或 final。

## 5. Owner 与职责

| 事实/行为 | 唯一 Owner | V2 职责 |
| --- | --- | --- |
| MCP provider、tool schema、canonical URL、媒体引用 | MCP | 返回权威 result，不决定 Telegram UI |
| normalize、recipe、Capsule、sensitivity、attribution | Agent | 生成渠道无关语义结果 |
| 对话、persona、canonical final、cache | Memory | 生成自然语言 final，不画 Telegram 卡 |
| Bot API method、文字格式、按钮、Mini App URL、outbox | Telegram | 将 Capsule 投影成真实原生 intent |
| Calendar/Health 详情视图 | 各 canonical owner + TG Mini App projection | 提供受限只读 projection |
| NCM 官方落地页 | NCM Provider | 提供 canonical HTTPS URL |

Telegram 不保存第二份 MCP catalog；Agent 不写死 `tgbot.example.com` 页面路径；MCP 不返回
Telegram-specific `reply_markup`。

## 6. 通用原生投影合同

### 6.1 输出类型

```ts
type TelegramNativeResultIntent =
  | {
      method: "sendLocation";
      latitude: number;
      longitude: number;
    }
  | {
      method: "sendPhoto";
      photo: SafeTelegramMediaRef;
      caption: string;
      parse_mode?: "HTML";
      reply_markup?: InlineKeyboardMarkup;
    }
  | {
      method: "sendMessage";
      text: string;
      parse_mode?: "HTML";
      link_preview_options?: { is_disabled: true };
      reply_markup?: InlineKeyboardMarkup;
    };
```

P0 sender allowlist只增加字段校验，不增加新的 Bot API method。`sendMessage`、`sendPhoto`、
`sendLocation` 已属于现有 sender 能力。

### 6.2 选择算法

确定性优先级：

```text
有合法 map
  -> 先发一个 sendLocation

有可发送 hero image 且 caption 在内部上限内
  -> sendPhoto(caption + buttons)

否则
  -> sendMessage(text + buttons)
```

约束：

- 一个 Capsule 最多投影一个定位针；
- 一个 Capsule P0 最多一张 hero photo；
- caption 使用低于 Telegram 上限的内部预算，超出部分进入后续 `sendMessage`；
- text 使用低于 Telegram 上限的内部预算，按语义行截断而不是切断 URL/标签；
- `fallbackText` 始终是最终兜底，但 native text formatter 优先从 blocks 生成更清晰的摘要；
- renderer 失败只降级同一份 Capsule，不重新执行 MCP 或模型。

### 6.3 语义 block 到原生文本

| Capsule block | Telegram P0 |
| --- | --- |
| `heading` | 加粗首行 |
| `paragraph` | 普通段落 |
| `fact_list` | 每行 `标签：值` |
| `metric` | `图标/标签  值 · note` |
| `table` | 有界等宽/逐行列表，不伪造表格控件 |
| `map` | `sendLocation`，label 保留在文字卡 |
| `media` | 仅一个安全 image 可成为 `sendPhoto` |
| `gallery` | P0 只取第一个安全 image，其余文字说明 |
| `details` | 标题 + 有界摘要，不存在聊天内折叠控件 |
| `sources` | 尾部来源 |
| `notice` | `ℹ️/⚠️` 前缀 |

所有 HTML 由 renderer 从纯文本生成并逐字段转义。MCP、模型或 Capsule 的 raw markup 不得成为
`parse_mode=HTML` 输入。

## 7. Action 与按钮

### 7.1 Discriminated union

V2 将现有宽松 action 收紧为：

```ts
type PresentationActionV2 =
  | {
      id: string;
      label: string;
      kind: "open_url";
      urlRef: string;
      requiresApproval: false;
    }
  | {
      id: string;
      label: string;
      kind: "open_mini_app";
      miniAppTarget: "calendar" | "health_7d" | "health_30d";
      requiresApproval: false;
    }
  | {
      id: string;
      label: string;
      kind: "callback";
      callbackRef: string;
      requiresApproval: boolean;
    };
```

P0 三个特化 recipe 只使用 `open_url` 和 `open_mini_app`，不新增 callback。

### 7.2 URL 按钮

- 只接受已经经过 normalizer 的 canonical HTTPS URL；
- 拒绝 userinfo、非默认端口、fragment、secret-like query、private/link-local host；
- renderer 不根据 provider item ID 猜 URL；
- NCM 没有 canonical URL 时省略按钮，并记录 bounded omission reason；
- URL 按钮关闭 link preview，避免敏感信息被 Telegram 额外抓取或展开。

### 7.3 Mini App 按钮

Telegram owner 将 `miniAppTarget` 解析为自己的受保护入口，不由 Agent 写完整 URL：

```text
calendar   -> Operia Mini App / Calendar view
health_7d  -> Operia Mini App / Health view, range=7
health_30d -> Operia Mini App / Health view, range=30
```

Owner private chat优先使用 `InlineKeyboardButton.web_app`。不支持该上下文时可退化成 Telegram
Mini App direct link；仍不允许把健康数据、日程正文或完整 tool result 放入 URL/start parameter。

官方能力边界：

- [InlineKeyboardButton](https://core.telegram.org/bots/api#inlinekeyboardbutton)
- [Telegram Mini Apps](https://core.telegram.org/bots/webapps)
- [Direct Link Mini Apps](https://core.telegram.org/bots/webapps#direct-link-mini-apps)

## 8. Mini App 深链

现有 Mini App 已有 `calendar` 与 `health` 视图，但启动后固定落在 `today`。V2 增加白名单启动参数：

```ts
type MiniAppStartTarget =
  | { view: "today" }
  | { view: "calendar" }
  | { view: "health"; range: 7 | 30 };
```

解析来源按 Telegram 官方字段：

1. `tgWebAppStartParam`；
2. `Telegram.WebApp.initDataUnsafe.start_param`；
3. 无合法参数时为 `today`。

规则：

- 只接受固定枚举，例如 `calendar`、`health_7d`、`health_30d`；
- 参数只决定初始视图，不构成授权；
- session、initData HMAC、Owner scope、CSRF/Origin 与 Service Binding 不变；
- Health/Calendar owner 不可用时显示 typed unavailable，不显示旧值为当前值；
- browser direct hit 没有 Telegram initData 时继续只显示无私有数据外壳。

## 9. Calendar 特化

### 9.1 Recipe

`calendar.agenda@2`：

- 标题：查询窗口，例如“今日日程”“接下来 7 天”；
- 摘要：项目数、空结果或 freshness；
- visible rows：最多 5 项；
- 每项：时间、标题、状态；
- 尾部：日历来源、最近同步时间；
- action：`open_mini_app(calendar)`。

### 9.2 Telegram 样式

```text
📅 <b>今日日程</b>
3 项安排 · Google Calendar

09:30  课程讨论
14:00  Operia QA
19:30  阅读

最近同步：15:42
[ 打开完整日历 ]
```

### 9.3 隐私

- Calendar 卡只允许 Owner private scope；
- private/busy event 继续遵循 owner projection，不由 renderer反查正文；
- URL/start parameter 不包含 event title、calendar ID 或 account label；
- P0 只读，不增加创建、修改、删除或同步按钮。

## 10. Health 特化

### 10.1 Recipe

新增 `health.summary@1`，识别 Health provider/tool key 与 `health` sensitivity。只消费既有 bounded
projection，不读取 raw samples：

- 核心指标：最多 4 个；
- 每项：label、value、unit、可选 change/freshness；
- 数据覆盖时间、最近上传时间；
- missing/stale 状态；
- informational-not-medical-diagnosis notice；
- actions：`health_7d` 和可选 `health_30d`。

### 10.2 Telegram 样式

```text
❤️ <b>今日健康</b>

步数：8,234
睡眠：6 小时 44 分
静息心率：61 bpm

数据覆盖至：今天 14:28
仅供个人记录，不构成医疗诊断
[ 查看 7 日趋势 ] [ 查看 30 日趋势 ]
```

### 10.3 隐私

- 仅 Owner private chat；
- 禁止群聊、room 或公开链接展示健康值；
- 日志只记录 recipe、指标数量、freshness state 与 hash，不记录指标值；
- 卡片内容不进入 Mini App URL、outbox intent key 或 correlation locator；
- 健康 owner unavailable 时不回退到旧缓存或 0；
- 不增加医疗判断、建议或模型总结。

## 11. NCM 特化

### 11.1 Recipe revision

升级：

- `music.search@2`；
- `music.playlist@2`；
- `music.lyric@2`。

搜索/歌手/歌单卡显示：

- 第一张安全封面（若 Provider 明确返回）；
- 最多 5 首歌曲；
- 曲名、歌手、专辑；
- attribution；
- 一个主要官方跳转按钮，必要时最多再加两个 item 按钮。

### 11.2 Provider 输出合同

当前 fixture 只有 `url_id`、`pic_id`、`lyric_id`，它们是 Provider 内部解析线索，不是可直接
展示的 HTTPS 资源。P0 要求 MCP owner在已有 `CallToolResult` 中提供标准字段：

```ts
type MusicItemProjection = {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  canonicalUrl?: string;
  cover?: {
    url: string;
    mimeType: "image/jpeg" | "image/png" | "image/webp";
    expiresAt?: string;
    cachePolicy: "no_store" | "transient" | "provider_allowed";
  };
};
```

可通过 MCP `resource_link` 表达 cover。Renderer 不直接调用 NCM、不拼接内部 ID、不接触 cookie。
若上游暂时没有 canonical URL/cover，NCM 卡仍以纯文字显示，但不得伪造按钮或封面。

### 11.3 Owner 确认的视觉方向

2026-07-30 Owner 提供了网易云音乐三款现有分享卡截图，并明确偏好 P2 与 P1；没有深色/浅色
模式之分。截图只作为设计参考，不进入仓库、fixture、生产 asset 或测试快照。

P0 视觉优先级：

1. **P2 风格为默认**：深色海报底、大幅方形封面、封面下方一条紧凑歌曲信息带、下方一行短文案
   与来源；适合搜索首项、歌单首项和普通单曲结果；
2. **P1 风格为单曲氛围备选**：深色海报底、黑胶唱片与圆形封面、短而克制的情绪文案、底部歌曲
   元数据；只在已经明确选中单曲时使用，不由模型自由选择；
3. **P3 不作为 P0 变体**：大面积壁纸与仿播放器控件的信息密度较低，且更容易暗示真实播放能力。

共同约束：

- 使用一套固定主题，不做 light/dark 切换；允许从封面提取有界背景色或模糊光晕，但必须有固定
  对比度兜底；
- 海报由确定性模板渲染为 PNG/WebP，不调用模型或图片生成服务；
- 不复制网易云原始分享卡 asset、二维码、账号头像、昵称或用户私密文案；
- 不生成二维码：Telegram 原生底部 URL 按钮承担跳转，避免不可审计或过期二维码；
- 不画可点击外观的暂停、上一首、下一首、进度条或播放列表按钮，因为 P0 没有播放 capability；
- 可以保留静态歌曲信息带、唱片/唱臂等装饰，但不得暗示用户能在图片内控制播放；
- 平台 attribution 使用普通文字“网易云音乐”，不把来源标识伪装成 Operia 自有内容；
- 卡片文案来自固定 recipe 或用户明确提供的文本，不生成歌词，不为氛围句新增模型调用。

P2 默认海报的建议结构：

```text
┌──────────────────────────┐
│                          │
│      大幅方形专辑封面      │
│ ┌──────────────────────┐ │
│ │ 小封面  曲名 · 歌手   ♪ │ │
│ └──────────────────────┘ │
│                          │
│ 一句固定、克制的分享文案    │
│ 来源：网易云音乐            │
└──────────────────────────┘
```

P1 备选海报的建议结构：

```text
┌──────────────────────────┐
│       唱臂 / 黑胶装饰       │
│      圆形裁切的专辑封面      │
│                          │
│       单曲分享 · ♪          │
│                          │
│ 曲名 · 歌手                 │
│ 来源：网易云音乐            │
└──────────────────────────┘
```

海报 renderer 属于 NCM recipe 的 deterministic artifact step，不改变通用 Telegram sender：生成成功
时仍是 `sendPhoto + caption + inline keyboard`；生成前失败则退回原始安全封面；封面也不可用时退回
`sendMessage`。artifact failure 不重跑 NCM、不调用模型、不阻断 canonical final。

### 11.4 Telegram 文字与按钮

```text
🎵 <b>网易云音乐 · 搜索结果</b>

1. 歌曲名称
   歌手 · 专辑
2. 另一首歌曲
   歌手 · 专辑

来源：网易云音乐
[ 打开第一首 ] [ 在网易云查看更多 ]
```

有安全 cover 时使用 `sendPhoto`；否则使用 `sendMessage`。

### 11.5 歌词与音频

- P0 不发送完整歌词；
- 卡片只显示极短、可独立理解的摘要或不超过内部版权上限的短预览；
- 无法确定版权边界时只显示“已找到歌词”与官方跳转；
- P0 不发送 `sendAudio`，不持久化试听 URL，不代理平台 cookie；
- P1 播放器必须另写 Spec，处理授权、过期、版权、缓存、地区限制、账号态和 unknown-send。

### 11.6 为什么 P0 不做音乐 PWA

当前目标是把链路跑通并提供漂亮可点击结果。官方页面已经是最简洁的落点。只有需要 Operia 内
播放队列、收藏、跨设备续播或 Operia 共同听歌时，才值得新增音乐 Mini App；它不能作为本轮
底部按钮的前置条件。

## 12. Generic MCP 卡

没有专用 recipe 的结果使用 `generic.result@2`：

- provider/tool 的人类可读标题；
- sanitized summary；
- 0–5 项关键结果；
- 0–6 个事实；
- attribution/freshness/partial warning；
- 若 normalizer 已得到一个 canonical HTTPS URL，则显示“打开结果”；
- 若得到一个安全 image asset，则可使用 `sendPhoto`；
- 不识别的数据只进入 bounded fallback，不渲染 raw JSON/HTML。

通用适配器不调用模型。新增 MCP 默认先获得 generic card；只有信息层级明显不同、需要特殊隐私或
action 规则时才增加薄 recipe。

## 13. 可靠性与 outbox

### 13.1 Intent identity

每个原生 intent 的 key 确定性生成：

```text
tg-agent:{batchKey}:result:{capsuleIndex}:{intentIndex}:{capsuleHashPrefix}
tg-agent:{batchKey}:final:{bubbleIndex}
tg-agent:{batchKey}:media:{mediaIndex}
```

完整 hash 存在 payload/correlation projection 的非正文位置；prefix 只用于调试，不作为唯一身份。

### 13.2 多 intent 状态

一个地图 Capsule 可能产生两个 intent：

```text
sendLocation -> sendMessage(card + button)
```

两者进入同一 ordered delivery batch：

- 第一条确定失败：允许该条按现有确定性失败规则处理；
- 第一条成功、第二条 unknown：hold batch，不盲目补发第二张卡；
- Worker 重启：从 durable cursor 继续，不重发已确认 intent；
- cleanup 失败：不改变 accepted truth；
- presentation compile 失败：发送一个纯文本 fallback，不重跑 MCP。

### 13.3 Card 与 final

当前 `richPayloads.length > 0 ? richPayloads : bubbles` 的互斥逻辑必须取消。V2 明确：

- card payloads 和 remaining final bubbles 可以同时存在；
- card 的工具事实不替代 Memory canonical final；
- final 不得读取 renderer-only state；
- 已发送 paragraph prefix 不得重复；
- final 为空仍按现有 final guarantee 处理，不能把“有卡片”当成合法空 final。

## 14. Draft 与首屏延迟

保留现有 `sendMessageDraft` at-most-once preview 和 0.5/2 秒 debounce，不把结果卡接入 draft：

- draft 只展示可信可见文本预览；
- Result Capsule 只在完整 tool result 与 canonical final package 就绪后编译；
- card final 不复用 draft ID；
- 关闭 preview 的失败不阻断 durable card/final；
- 不引入第二次模型调用或“卡片生成中”模型文案。

## 15. 安全要求

### 15.1 Markup

- 所有字段先作为纯文本；
- renderer 统一 HTML escape；
- 禁止工具或模型提供 `parse_mode`；
- 禁止未知 Telegram method、field 和 nested reply markup。

### 15.2 URL 与媒体

- HTTPS only；
- 拒绝 userinfo、fragment、secret query、private/link-local/metadata target；
- redirect 和 DNS 在 Agent media fetch 路径复核；
- Provider signed URL 不写日志；
- `no_store` 媒体只在当前 delivery 生命周期短暂使用；
- 不能证明安全或稳定的 cover 直接省略。

### 15.3 Scope

- Health、Calendar、location Capsule 默认 Owner private；
- room/group 必须通过 sensitivity × audience policy，不能因为 Bot 在群里就展示；
- button target 不构成 capability；任何未来 mutation 必须重新进入 canonical owner policy。

## 16. 成本原则

本功能的单轮新增模型费用必须为零：

```text
normalize  -> TypeScript
recipe     -> TypeScript
format     -> TypeScript
deep link  -> allowlisted lookup
QA fixture -> local deterministic data
```

禁止：

- 用模型决定卡片布局；
- 用 Claude/其它模型补摘要以弥补 recipe；
- presentation 失败后再次推理；
- 为 NCM cover 或 Health 图表并发调用付费模型；
- 为追求视觉效果引入生成式图片模型、Browser Rendering 或按次付费截图服务；NCM P2/P1 海报只允许
  本地确定性模板栅格化，并必须有原封面/纯文字零额外调用 fallback。

未来若确需语义精选，必须单独给出质量收益、轻量模型候选、预算上限和 script fallback；Claude 系列
不是默认依赖。

## 17. 可观测性

只记录 bounded metadata：

```ts
type NativeCardEvent = {
  capsuleId: string;
  capsuleHash: string;
  recipe: string;
  rendererRevision: string;
  variant: "location_text" | "photo_caption" | "music_poster_p2" | "music_poster_p1" |
    "text_web_app" | "text_url" | "text_only";
  blockCount: number;
  actionCount: number;
  intentCount: number;
  omissionReasons: string[];
  status: "compiled" | "fallback" | "accepted" | "failed" | "unknown";
  durationMs?: number;
};
```

不得记录：

- Health 指标值；
- 日程标题或账号；
- 歌词正文；
- 完整 tool result/final；
- URL query、cookie、token、provider header；
- hidden reasoning 或 draft text。

## 18. 文件级实施计划

### 18.1 Agent presentation

```text
src/agent/presentation/types.ts
src/agent/presentation/normalize.ts
src/agent/presentation/compile.ts
src/agent/presentation/recipes/calendarAgenda.ts
src/agent/presentation/recipes/healthSummary.ts        # new
src/agent/presentation/recipes/ncm.ts
src/agent/presentation/recipes/genericResult.ts
src/agent/presentation/artifacts/musicSharePoster.ts    # new, deterministic P2/P1 poster
```

### 18.2 Telegram projection

```text
src/tg/richResultRuntime.ts       # rename semantics or replace fake methods
src/tg/richResultRenderer.ts      # native formatter, no fake Bot API
src/tg/process.ts                 # card + final composition
src/tg/telegram.ts                # validate web_app button shape
src/tg/miniAppPage.ts             # start target routing
```

实现阶段可选择更清楚的文件名，例如 `nativeResultCards.ts` 和 `nativeResultRenderer.ts`。若重命名，
必须是有界机械迁移，不顺手重构 outbox、process 或 Mini App。

### 18.3 Tests

```text
scripts/verify-result-capsule.mjs
scripts/verify-native-result-cards.mjs                 # new
scripts/verify-tg-miniapp.mjs
scripts/verify-tg-inference-recovery.mjs
scripts/verify-tg-experience-latency.mjs
scripts/verify-tg-media.mjs
```

## 19. 验证矩阵

### 19.1 Contract

- fake `sendRichMessage*` 不可达且 verifier 不再把它当成功；
- action discriminated union 严格拒绝混合字段；
- recipe revision 改变 capsule hash；
- unknown block 只能安全 fallback；
- attribution/sensitivity/cache policy 不丢失；
- same input replay 得到相同 native intent sequence。

### 19.2 Calendar

- 0/1/5/10 个事件；
- all-day、跨时区、cancelled、private/busy；
- stale/unavailable；
- card 有 Calendar `web_app` button；
- 点击后初始 view 为 calendar；
- URL/start parameter 无事件正文。

### 19.3 Health

- fresh、stale、missing、unavailable；
- 0/1/4/超额指标；
- 7/30 日按钮；
- group/room audience fail-closed；
- 日志、URL、intent key 不含健康值；
- Mini App 打开正确 range。

### 19.4 NCM

- search、artist、playlist、lyric；
- 有/无 cover；
- 有/无 canonical URL；
- P2 默认 poster 与 P1 单曲 poster snapshot；
- poster renderer 失败后只降级原封面/文字，不触发任何外部调用；
- unsafe/expired media 被省略；
- 没有 URL 时不生成假按钮；
- 无完整歌词、无 `sendAudio`、无 cookie；
- attribution 始终可见。

### 19.5 Delivery

- card + final 都进入同一 batch；
- paragraph prefix 不重复；
- sendLocation 成功 + card unknown 不盲重发；
- definitive 4xx、401/403、429、5xx、timeout 继续遵守现有分类；
- success 后本地状态失败不重复；
- feature flag false 回到普通 final，不影响工具执行；
- draft producer、canonical final/outbox 与 unknown-send 契约无回归。

### 19.6 Cache/history regression

- `MEMORY_THINK_CACHE_V3_MODE=anchored_v3`；
- stable provider tools/instructions/toolChoice 不变；
- final-render execution barrier 不变；
- `pendingTgConversationArchiveRows`、`conversationArchiveWatermark` 不变；
- append-only canonical history 不变；
- 不重新引入 ISO 字符串与 SQLite `datetime()` 直接比较。

## 20. 分阶段 Gate

### Gate A：Owner 审 Spec

产物只有本文件和旧 Spec 的纠错标记。零代码、零网络副作用、零部署。

### Gate B：本地合同与 renderer

Owner 批准“开干”后：

- 实现原生 intent projector；
- 删除 fake transport 期待；
- 添加 Health recipe 与三类 action；
- synthetic/recorded fixture；
- typecheck 与 targeted verifier。

不调用真实 MCP/Provider，不发送 Telegram，不部署。

### Gate C：Mini App 深链与完整回归

- Calendar/Health start target；
- card + final composition；
- full `npm run verify`；
- TG/Agent dry-run；
- `npm run predeploy:tgbot` 只作为候选门禁，不部署。

### Gate D：生产发布

需 Owner 当前明确说“发布/上线”。发布前：

- fast-forward 到当前 canonical；
- 保留 Cache V3 与 history 不变量；
- `npm run predeploy:tgbot` 必须通过；
- 若 Agent 也修改，则运行对应完整 Agent gate/dry-run；
- 回读真实版本、flags、bindings；
- 不生成自动 Telegram 或 Provider canary。

### Gate E：Owner 自然消息 QA

按顺序测试：

1. Calendar 只读查询；
2. Health 只读 summary；
3. NCM search；
4. NCM playlist 或 lyric；
5. Google Maps 回归。

每次回读同一 correlation 的 MCP call、Capsule recipe/hash、outbox intents、Telegram message IDs 与
delivery outcome。不得因上一项失败自动重跑工具。

## 21. Rollback

优先关闭现有 presentation flag：

```text
TG_RICH_RESULTS_ENABLED=false
AGENT_RESULT_CAPSULE_ENABLED=false（仅在 Agent compilation 本身异常时）
```

回滚要求：

- TG 先回滚 presentation consumer；Agent 后回滚 producer；
- 不删除 additive schema；
- unknown outbox 不 replay；
- 保留 capsule/outbox/delivery metadata 供诊断；
- 不恢复 fake `sendRichMessage` 路径；
- 回滚后普通 canonical final 必须仍可见。

## 22. 完成定义

只有同时满足以下条件，V2 才能声称完成：

1. 生产可达代码不含 fake Telegram method；
2. Calendar、Health、NCM 与 Google Maps 都投影为真实 Bot API intent；
3. Calendar/Health 底部按钮能进入正确 Mini App view；
4. NCM 有 canonical URL 时能打开官方结果，无 URL 时诚实省略；
5. 卡片与 canonical final 均可见，且无 reasoning/draft 泄漏；
6. presentation 不新增模型调用、工具调用、Provider enrichment 或费用；
7. attribution、privacy、copyright、cache policy 与 audience 全部保留；
8. unknown-send、outbox FIFO、idempotency 和 paragraph prefix 无回归；
9. Cache V3 anchored final barrier 与 Telegram append-only history 不变；
10. 本地、dry-run、部署回读和 Owner natural-message QA 被清楚区分。

## 23. Owner 待审决策

建议默认接受以下方案：

1. **统一原生底座**：Calendar、Health、NCM、Maps 共用一个 projector；
2. **Calendar/Health 不新建 PWA**：复用现有 Mini App 并增加深链；
3. **NCM P0 不建播放器**：优先官方 URL，缺 URL 则无按钮；
4. **NCM P0 不发音频/完整歌词**：播放器与账号态另开 Spec；
5. **结果卡与 Operia final 并存**：卡片呈现事实，final 保留陪伴式自然回复；
6. **零模型渲染**：全部由确定性脚本完成；
7. **批准 Spec 后先做 Gate B-C**：发布与真实 QA 再单独确认。
8. **NCM 视觉采用 P2 主、P1 辅**：单一主题、确定性海报；不使用 P3，不放二维码或假播放控件。

若 Owner 对其中某项提出修改，其余已接受项可继续保留，不需要整份 Spec 重新讨论。
