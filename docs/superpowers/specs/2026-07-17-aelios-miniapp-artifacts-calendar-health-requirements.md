---
title: Operia Mini App HTML Artifacts, Google Calendar and Health Requirements
status: proposed-for-owner-review
date: 2026-07-17
depends_on:
  - 2026-07-17-operia-telegram-mini-app-life-console-design.md
  - 2026-07-17-operia-heartbeat-studio-implementation.md
related:
  - 2026-07-16-operia-home-assistant-integration-design.md
scope: interactive HTML artifacts, direct Google Calendar projection, Health Auto Export ingestion, health domain and Mini App views
---

# Operia Mini App：HTML Artifacts、Google Calendar 与 Health 详细需求

## 1. 本轮产品决定

本文件把 Owner 在 Mini App Phase 0 体验后提出的三个能力收敛为可实施需求：

1. **HTML Artifacts**：Opus 生成网页后，经过 Agent Artifact Runtime 的构建与安全门，自动出现在
   Mini App 的 Artifact 画布中；在手机上可以滚动、点击和运行本地交互逻辑。
2. **Google Calendar**：直接连接 Owner 的 Google Calendar。首期仅只读，显示今日、近期、空闲块与
   时间线事件；所有 OAuth 与 token 由独立 Calendar owner 管理。
3. **Health**：以 Health Auto Export 为 Apple Health 数据入口，新建 Health canonical owner；
   `health.example.com` 提供完整私有健康视图，Mini App 提供最小化摘要与趋势。

三项能力不能改变现有 owner 边界：

| 事实 / 能力 | Canonical owner | Mini App 的职责 |
|---|---|---|
| HTML artifact bundle、版本、状态、sandbox policy | Agent Artifact Runtime | 显示、自动打开、发送受限交互事件 |
| Google Calendar event、calendar list | Google Calendar | 读取 Calendar adapter 的受限 projection |
| OAuth credential、sync cursor、watch channel | Calendar adapter | 只显示 configured / stale / revoked |
| Apple Health raw export | Health owner private R2 | 不复制；只读摘要 |
| Health normalized metric、derived trend | Health owner D1/DO | 今日卡、趋势图、敏感 reveal |
| Opus 人格、解释、对话与长期记忆 | Operia Memory | 使用显式授权的 bounded context |

本 Spec 不授权立即连接 Google 账号、创建 OAuth client、配置 Auto Export、上传健康数据、创建域名、
应用 migration、部署 Worker 或修改 BotFather。

## 2. 跨模块体验合同

### 2.1 同一套手机导航

- `今日`：显示下一个 Calendar 事件、今日 Health 摘要、最近 Artifact 与数据 freshness；
- `时间线`：Calendar / Health / Artifact 只提供安全摘要与 owner locator；
- `一起`：共读、观影与共同 Artifact；
- `工作台`：Calendar / Health connector configured 状态、Artifact blocked queue；
- `游戏`：Riddle 与其他 first-party interactive module。

Artifact 全屏页不新增第六个主导航；它作为可返回的 detail route。Calendar 与 Health 完整页分别从
今日卡、时间线 event 和头像菜单进入。

### 2.2 Freshness 优先于“看起来正常”

所有外部数据卡必须显示：

```ts
type ProjectionFreshness = {
  ownerDomain: string;
  sourceVersion: string;
  observedAt: string;
  staleAfter: string;
  status: "ready" | "stale" | "unavailable" | "not_configured" | "revoked";
};
```

如果 Calendar 或 Health 没有新数据，UI 显示最后同步时间和 stale 原因，不能把旧值画成当前状态。

### 2.3 Opus 的权限

Opus 可以：

- 解释 Calendar / Health owner 已提供的摘要；
- 提议创建 Artifact；
- 基于 Owner 当前请求生成 Artifact bundle；
- 为当前页面生成一句有 TTL 的叙事摘要；
- 请求 Owner 明确授权更详细的 Calendar / Health reveal。

Opus 不可以：

- 直接读取 Google refresh token、Auto Export bearer 或 raw Health object；
- 把完整 Calendar / Health 数据写入 stable prefix、普通日志或长期记忆；
- 让 Artifact 内 JavaScript 直接调用工具、Memory、Calendar、Health、MCP、HA 或外网；
- 根据健康趋势给出诊断、替代医生意见或自动触发医疗动作；
- 在 Calendar P0 创建、移动、删除事件或邀请参与者。

## 3. HTML Artifacts

### 3.1 Owner 体验

#### 从 Telegram 对话创建

1. Owner 要求 Opus 做一个网页、报告、互动卡、小游戏或可视化；
2. Opus 组织 HTML/CSS/JavaScript，并通过现有 `delegate_action` 请求
   `html_artifact.create`，不把未处理的 HTML 直接塞进 TG 消息；
3. Agent 创建 immutable draft，运行体积、secret、URL、DOM、CSP 和 sandbox 检查；
4. 通过后状态变为 `ready`，TG durable continuation 收到 `artifactId/version/contentHash`；
5. TG 对话发送一个“一键打开作品” Mini App button；Telegram 不允许 Bot 强制替 Owner 打开页面，
   因而从聊天切换到 Mini App 仍需要一次用户手势；
6. 若 Mini App 已在前台且 artifact 与当前 owner/task/session 匹配，页面自动切到 Artifact 画布；
7. 若 Mini App 在后台，只显示未读 Artifact 数量，Owner 再打开时恢复，不抢占当前操作。

#### 在 Mini App 内创建

如果未来 Mini App 增加对话框或“让 Opus 做一个”入口，ready event 可以直接打开全屏画布。自动打开
只允许同一 owner、同一 Mini App session、同一 correlation task；不能因为后台 Heartbeat 或未知
任务产物抢占页面。

#### 修改与历史

- Owner 对 Artifact 说“把背景换成纸色”“加一个按钮”时，Opus 创建 `version + 1`；
- 旧版本不可原地覆盖，可在版本抽屉回看；
- Pin 可以固定某个版本或跟随 latest，两者必须显式区分；
- 删除 latest 不会静默删除历史 Pin；源状态变为 tombstone。

### 3.2 两类 Artifact，不能混用

#### A. Safe Document

适合报告、表格、时间表、健康解释、电影纪念卡和图文总结：

- HTML + CSS；
- 禁止 JavaScript；
- 禁止 form、iframe、external URL、navigation、download；
- 允许语义化表格、details/summary、CSS responsive layout；
- sanitizer 后在 `iframe sandbox` 中渲染。

#### B. Interactive Capsule

适合本地计算器、筛选器、交互图表、轻量小游戏和 HTML 小作品：

- 允许 bundle 内联 JavaScript；
- frame 使用 `sandbox="allow-scripts"`，**绝不同时授予 `allow-same-origin`**；
- frame 是 opaque origin，看不到 Mini App Cookie、Telegram initData、CSRF、bearer、parent DOM 或缓存；
- CSP 禁止所有网络、表单、导航、popup、download、摄像头、麦克风、定位、支付与剪贴板；
- JavaScript 只能操作自己的 DOM 和本地内存；刷新后状态是否恢复由显式 bridge contract 决定；
- 不把任意 npm/CDN script 当运行时依赖，首期只接受单文件、自包含 bundle。

Interactive Capsule 不是“sanitize JavaScript”。任意 JavaScript 无法靠字符串清洗变可信；安全性来自
opaque-origin sandbox、零网络、零 ambient credential 和严格 parent bridge。

### 3.3 Renderer 与 CSP

Mini App parent 先从 owner-authenticated BFF 获取已批准 bundle 并核对不可变 SHA-256，再把同一条私有
bundle URL 交给受控 frame。frame 的初始 GET 可以携带 HttpOnly Mini App session，但由于没有
`allow-same-origin`，加载后的文档仍是 opaque origin，不能读取 Cookie、parent DOM 或任何 ambient
credential；Artifact 自身 CSP 继续将网络和导航全部封死。bundle 响应只允许 `frame-ancestors 'self'`，
不承载 CSRF、Telegram initData 或 bearer。关闭或切换作品时必须立即移除 frame URL。

如果目标 WebView 无法稳定使用这个直接私有 URL，才允许依次回退到已核验 bundle 的内存 `Blob URL`
或有 256 KiB 硬上限的 `data:text/html` URL；Blob 模式必须 `URL.revokeObjectURL`。所有承载方式都必须
保留下面的 opaque-origin sandbox，且不能为了让脚本运行而给 parent CSP 增加 `'unsafe-inline'`：

```html
<iframe
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
  allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'">
</iframe>
```

Artifact 文档内嵌 CSP：

```text
default-src 'none';
script-src 'unsafe-inline';
style-src 'unsafe-inline';
img-src data: blob:;
media-src data: blob:;
connect-src 'none';
font-src 'none';
frame-src 'none';
worker-src 'none';
form-action 'none';
base-uri 'none';
navigate-to 'none';
```

Safe Document 额外使用 `script-src 'none'`。Artifact bundle 本身不包含 owner token，因而即使被截图、
保存或复制，也不能获得 Operia 权限。

### 3.4 Parent bridge

Parent 只接受固定 schema 的 `postMessage`：

```ts
type ArtifactToParentMessage =
  | { type: "artifact.ready"; artifactId: string; version: number }
  | { type: "artifact.resize"; height: number }
  | { type: "artifact.state.save"; revision: number; value: JsonValue }
  | { type: "artifact.request"; requestType: "ask_opus" | "pin" | "export"; payload: JsonValue };
```

限制：

- 验证 iframe `event.source`，不信任 frame 自报 owner / artifactId；
- 单条 state 最大 16 KiB，总状态最大 64 KiB；
- `resize` 限 240–4096 px，并节流；
- `ask_opus/pin/export` 只显示 parent 原生确认 UI，frame 不能直接执行；
- 不提供通用 `fetch`、tool call、open URL、clipboard、payment、filesystem bridge；
- state 归 Artifact Runtime，不进入普通聊天或长期 Memory。

### 3.5 移动端要求

- 以 390 px 宽为首要 viewport，320–1024 px 必须可用；
- Artifact 默认全屏，可退出回到创建它的 TG task / timeline event；
- 支持 portrait / landscape，旋转不丢失已保存 state；
- 所有点击目标至少 44×44 CSS px；
- 不允许横向页面溢出，代码/大表格使用局部滚动；
- 遵守 `prefers-reduced-motion`；
- 首屏显示 title、creator、version、createdAt、sensitivity 和 sandbox badge；
- blocked artifact 显示固定原因，不回退运行原始 bundle；
- 离线时只允许打开已显式缓存且不含 Health/Calendar 敏感数据的 artifact。

### 3.6 数据合同

```ts
type HtmlArtifact = {
  artifactId: string;
  ownerId: string;
  title: string;
  kind: "safe_document" | "interactive_capsule";
  status: "draft" | "scanning" | "ready" | "blocked" | "expired" | "deleted";
  version: number;
  parentVersion?: number;
  contentHash: string;
  bundleObjectKey: string;
  stateRevision: number;
  sensitivity: "private" | "sensitive" | "health";
  correlation: { taskId?: string; messageId?: string; sessionId?: string };
  creator: { type: "opus" | "owner"; model?: string };
  createdAt: string;
  expiresAt: string;
};
```

- metadata / state 归 Agent Artifact DO/D1；
- ready bundle 放 private R2；
- 原始 rejected bundle 不进入可渲染 bucket，默认只保留 hash 与 blocked category；
- 默认保留 30 天；Pin 可延长，删除必须删除 bundle、state 和所有临时缓存；
- Health Artifact 默认只允许 derived summary，不内嵌 raw sequence、ECG、route 或 medication history。

### 3.7 Artifact 验收

- TG 对话创建后有一次明确 button；不能强制打开 Telegram Mini App；
- Mini App 前台同 session ready event 可以自动打开；其他 event 只进入 inbox；
- Safe Document 中 script 不执行；
- Interactive Capsule 本地按钮/筛选/小游戏可工作；
- `fetch/WebSocket/EventSource/sendBeacon` 均失败；
- `document.cookie/localStorage/indexedDB/serviceWorker/opener/parent DOM` 不可用或不可读；
- parent bridge 对未知 message、超限 payload、错误 source、重放 revision 全部拒绝；
- 缺少 sandbox/CSP/scan result 的 artifact 不能进入 ready；
- 390×844 和 844×390 均无关键操作裁切；
- version 2 失败时 version 1 仍可打开；
- blocked / expired / deleted 不回退到旧 URL 或不安全 HTML。

## 4. Google Calendar

### 4.1 可以直接连接吗

可以。使用 Google Calendar API 的 web-server OAuth 2.0 flow，而不是读取浏览器 cookie、导入 ICS
作为长期真源或用 Browser 自动登录。

Google 不允许开发者把 OAuth 请求导向其控制的 embedded user-agent，因此 Mini App 的“连接 Google
Calendar”按钮必须打开系统浏览器中的独立 OAuth 页面。授权完成后由一次性 state 恢复 Mini App，
不能在 Artifact iframe 或 Telegram WebView 内注入账号密码。

### 4.2 P0 scope

首期只申请最窄的只读权限：

```text
openid
email
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.events.readonly
```

- `openid email` 用于把授权结果绑定到 Owner 明确选择的 Google 账号；
- `calendarlist.readonly` 用于选择要展示的 calendar、颜色和时区；
- `events.readonly` 用于读取事件；
- 不申请 `calendar.events`、ACL、settings write 或 Drive；
- 如果 Owner 最终只要 primary calendar，可删除 `calendarlist.readonly`，进一步缩 scope。

P1 写权限必须重新做 incremental authorization，不能在首次连接时预取。

### 4.3 OAuth 与 credential

```text
Mini App / health-independent control page
  -> external system browser
  -> calendar.example.com/oauth/start
  -> Google OAuth consent
  -> calendar.example.com/oauth/callback
  -> Calendar adapter encrypted credential store
  -> one-time resume state
  -> Mini App configured projection
```

要求：

- OAuth state 单次、短 TTL、绑定 TG owner session、PKCE verifier 和 return route；
- callback 精确匹配 redirect URI；
- refresh token 由 Calendar adapter 用独立 KEK 加密后保存，KEK 只在 Worker Secret / Secrets Store；
- access / refresh token 不进入 TG D1、URL、日志、Artifact、Memory 或前端；
- OAuth error 只记录固定 category；
- UI 提供 revoke / disconnect；断开后停止 sync、watch 并删除 token；
- OAuth consent screen、主页、隐私政策和域名验证在生产接入前完成；
- 连接页与 callback 继续用应用层 state 校验，不能只依赖 Cloudflare Access email。

### 4.4 Read projection

Mini App 首期展示：

- 当前进行中的事件；
- 接下来 3 项；
- 今日 / 明日 / 本周；
- all-day、start/end、timezone；
- calendar label / color；
- busy / free；
- meeting link 只作为受控 deep link，不自动加入；
- event location 默认折叠；
- private event 可按 Owner preference 只显示“忙碌”；
- declined / cancelled 明确标记；
- recurring instance 显示 recurrence status，不允许在 P0 编辑。

时间线只保存安全标题、时间、calendar locator 和 status，不复制 description、attendees、meeting
notes 或附件正文。通用搜索默认不索引 event description。

### 4.5 同步模型

Calendar adapter 是唯一 sync owner：

1. 初次连接执行有界 full sync；
2. 保存 Google `nextSyncToken`；
3. 后续使用 incremental sync，包含 deleted event tombstone；
4. `410 Gone` 时清 projection store 并重做 full sync；
5. sync 参数保持一致，分页完成后才原子替换 token；
6. Mini App 只读 adapter projection，不直接请求 Google API。

P0 使用“打开时 freshness check + 定时增量同步”。Google push notification 可作为 P1 优化，但不能
作为唯一可靠来源：channel 需要续期，通知本身不含 event body，且官方明确提示可能丢失少量通知。

### 4.6 Calendar projection schema

```ts
type CalendarEventProjection = {
  eventId: string;
  calendarId: string;
  calendarLabel: string;
  title: string | "忙碌";
  start: string;
  end: string;
  timezone: string;
  allDay: boolean;
  transparency: "busy" | "free";
  responseStatus?: "accepted" | "tentative" | "declined" | "needsAction";
  recurrence?: { recurringEventId: string; originalStartTime: string };
  status: "confirmed" | "tentative" | "cancelled";
  htmlLinkLocator?: string;
  observedAt: string;
  staleAfter: string;
};
```

adapter 可以缓存只读 projection 以降低 API 调用，但不宣称成为 Calendar 真源。默认只保留产品需要的
时间窗口；旧 event 退出窗口后删除 projection，Pin 只留下 locator / title snapshot。

### 4.7 Calendar UI

#### 今日卡

- `现在`；
- `下一项`；
- `今天还有 N 项`；
- 最近 2 个空闲块；
- 最后同步时间；
- 一键进入 Calendar 详情。

#### Calendar 详情

- 日 / 三日 / 周三种触控视图；
- calendar filter；
- privacy mode；
- 点 event 展示只读详情和“在 Google Calendar 打开”；
- Pin / 与 Opus 讨论是 Operia action，不修改 Google event；
- create / edit / move / delete / invite 全部显示 `P1 / 尚未授权`。

### 4.8 Calendar 验收

- 未连接显示 `not_configured`；token revoked 显示 `revoked`；API 失败显示 `unavailable`；
- OAuth state / PKCE / owner / account mismatch 均 fail closed；
- P0 token 无法创建、修改、删除 event；
- primary + secondary calendar 可分别隐藏；
- all-day、跨时区、DST、recurring、cancelled、private event 正确；
- incremental sync、分页、deleted tombstone 和 410 full resync 正确；
- refresh token 不出现在 D1 明文、日志、client、TG update、Artifact 或 error；
- Mini App cache stale 时显示时间，不回退成“日程为空”；
- disconnect 后下一次 sync 无法继续，projection 按 policy 删除。

## 5. Health

### 5.1 关于 Auto Export 与 S3

截至 2026-07-17，Health Auto Export 官方列出的自动化目的地包括 REST API、Home Assistant、MQTT、
Dropbox、Google Drive、iCloud Drive 和 Calendar，没有列出直接 AWS S3 / S3-compatible destination。

Cloudflare R2 确实提供 S3-compatible API 和 presigned PUT URL，但 Auto Export 的原生 REST automation
发送 HTTP POST JSON/CSV，并使用它自己的 headers / batching contract；它不会替我们生成 S3 SigV4。
因此首选路线不是把 R2 credential 填进 iPhone，而是：

```text
Apple Health / HealthKit
  -> Health Auto Export REST API automation (JSON v2, batched)
  -> https://health.example.com/ingest/auto-export
  -> Health Ingest Worker (auth, size, schema, idempotency)
  -> Queue
  -> private R2 raw object + D1 normalized metrics
  -> Health owner projection API
  -> health.example.com + Mini App BFF Service Binding
```

这样仍然使用 R2 作为 S3-compatible object storage，但 iPhone 不持有 R2 account credential，也不暴露
presigned URL。未来如 Auto Export 官方新增 S3 destination，再单独评估直传。

### 5.2 Health canonical owner

建议新增 `<HEALTH_SERVICE>` Worker：

- `health.example.com`：完整 owner-only 健康视图和 connector 管理；
- `HEALTH_RAW` private R2：原始 Auto Export JSON / CSV；
- Health D1：ingest ledger、metric definition、normalized samples / daily rollups、retention tombstone；
- Queue：解析、去重、单位规范化和 daily aggregation；
- 可选 Health DO：current snapshot / ingest lease，不作为海量原始序列仓库；
- `HEALTH_SERVICE` Service Binding：只向 TG Mini App 返回 bounded projection。

Health 不放入 Operia Memory D1，也不把 R2 bucket 暴露为 public/custom domain。

### 5.3 Ingest authentication

Health Auto Export REST automation 支持自定义 headers，首期使用独立高熵 bearer：

```text
Authorization: Bearer <AUTO_EXPORT_INGEST_TOKEN>
X-Operia-Health-Schema: auto-export-v2
```

Auto Export 自带的 headers 作为幂等和审计输入：

- `automation-id`；
- `automation-name`；
- `automation-aggregation`；
- `automation-period`；
- `session-id`。

要求：

- token 只存在 Health Worker secret 与 iPhone automation credential；
- endpoint 不接受 query token；
- `session-id + automation-id + body hash` 形成 idempotency key；
- 同一 key 重试返回同一 receipt；同 session 不同 hash 进入 attention；
- 固定 application body max 8 MiB，超过返回 413，Auto Export 必须启用 JSON Batch Requests；
- Content-Type、JSON depth、metric count、data point count、date range 和 future timestamp 有硬上限；
- raw body、bearer、精确 GPS、ECG waveform 不进入 Worker logs / Tail / analytics；
- WAF / rate limit 只作为附加层，不能代替 bearer 和 schema 校验；
- token rotation 支持 current + next 短重叠，撤销 current 后旧 token 立即失效。

Auto Export 的 automation backup 可能包含加密 credential；手动 share/export 可能产生明文设置文件。配置
页面必须提示不要把 automation export 上传到聊天、Artifact 或公共仓库。

### 5.4 Ingest 流程

```ts
type HealthIngestReceipt = {
  receiptId: string;
  automationId: string;
  sessionId: string;
  payloadHash: string;
  status: "accepted" | "duplicate" | "processing" | "ready" | "rejected";
  receivedAt: string;
  coveredFrom?: string;
  coveredTo?: string;
};
```

1. Worker streaming / bounded 读取 body，验证 auth 与 envelope；
2. 创建 ingest receipt；
3. 原始 payload 写 private R2 immutable object；
4. Queue 解析 snake_case metric、units、source 和 timestamps；
5. 单位规范化但保留原始 unit；
6. 用 metric/source/date/quantity/source-id 指纹去重；
7. 写 normalized sample 或 daily/hourly rollup；
8. 更新 current snapshot 与 freshness；
9. 只产生 bounded timeline summary，例如“昨夜睡眠已同步”，不带 raw values，除非 Owner reveal；
10. rejected payload 保留固定错误类别和 hash，不把原始数据写 error log。

### 5.5 P0 字段 allowlist

先接日常状态，而不是一次导入所有 150+ metrics。

#### 默认允许

- `step_count`；
- `active_energy`；
- `apple_exercise_time` / exercise minutes；
- `apple_stand_hour` / stand hours；
- `walking_running_distance`；
- `resting_heart_rate`；
- `heart_rate_variability`；
- aggregated `heart_rate` min / avg / max；
- aggregated `sleep_analysis` total / core / deep / REM / awake；
- workout summary：type、start/end、duration、energy、distance；
- weight 仅在 Owner 明确勾选后加入。

#### P0 默认禁止

- workout route / GPS；
- ECG waveform；
- AFib / high-low heart rate notification detail；
- symptoms / conditions；
- medications；
- State of Mind；
- cycle / reproductive / sexual health；
- blood glucose、blood pressure 等医疗相关值，除非 Owner 单独确认场景；
- clinical records；
- device serial、precise source metadata 和可定位 identifier。

不同敏感组必须拆成不同 Auto Export automation 与不同 server allowlist，不能用一个“导出所有数据”
开关。新增字段先有 schema fixture、单位策略、UI、retention 和删除验证。

### 5.6 Health 数据层

| 层 | 内容 | 默认 retention |
|---|---|---|
| Raw R2 | 原始 JSON batch，private、immutable | 30 天 |
| Normalized samples | P0 allowlist 的标准化时间序列 | 180 天 |
| Daily rollups | daily totals / avg / min / max / sleep stage | 2 年 |
| Current snapshot | 今日与最近一次值、freshness | 覆盖更新 + 审计 |
| Timeline event | 安全摘要与 Health locator | 90 天 |
| Opus explanation | 仅当前请求的 bounded context | ephemeral |

以上是建议默认值，实施前由 Owner确认。每层都必须支持 owner export、按日期删除、全部删除和
tombstone；R2 与 D1 删除要有一致的 durable job 和完成证明。

### 5.7 health.example.com 完整视图

完整健康页由 Cloudflare Access + Health 应用层 owner session 双层保护，包含：

#### 今日

- 昨夜睡眠：总时长与阶段；
- 今日活动：步数、距离、活动能量、运动分钟、站立；
- 心脏日常趋势：静息心率、HRV、聚合心率，不显示诊断色；
- 最近 workout；
- last sync、covered period、source 和 stale 状态；
- 一句 Opus 可选解释，明确标注“解释，不是医疗诊断”。

#### 趋势

- 7 / 30 / 90 天；
- 每张图只画一个语义明确的 metric group；
- 显示 missing day，不做直线补值；
- 单位与来源变化有 marker；
- 支持查看 daily rollup，raw sample 需要额外 reveal；
- 不用红/绿直接判定健康好坏，除非有 Owner 配置且来源明确的规则。

#### 数据与隐私

- 当前 Auto Export automations；
- 最近 ingest receipts 与错误类别；
- 字段 allowlist；
- retention、export、delete；
- rotate token；
- Opus access policy；
- privacy mode；
- 审计中只显示谁在何时读取了哪个 metric group，不记录 raw value。

### 5.8 Mini App Health 视图

Mini App 默认只显示：

- last sync / freshness；
- 睡眠总时长和近 7 日方向；
- 今日步数 / 活动 / 运动；
- 静息心率 / HRV 的近 7 日趋势摘要；
- 最近 workout；
- `查看完整健康页` deep link。

默认不显示 raw graph、GPS、ECG、medication、symptoms、cycle、mental state 或 clinical records。
Mini App 进入后台或 Telegram privacy mode 开启时，健康值被模糊；重新 reveal 需要 owner session 仍有效。

### 5.9 Opus 与健康数据

Opus 默认获得结构化摘要：

```ts
type HealthSummaryForOpus = {
  period: { from: string; to: string };
  freshness: ProjectionFreshness;
  metrics: Array<{
    key: string;
    current?: number;
    unit: string;
    baseline?: { kind: "7d" | "30d"; value: number };
    direction?: "up" | "down" | "flat" | "insufficient_data";
    missingDays: number;
  }>;
  disclaimer: "informational_not_medical_diagnosis";
};
```

- 默认不传 raw sample array；
- 每次调用记录 metric group / period / purpose，不记录 value；
- 解释默认 ephemeral；
- “记住我最近睡眠不好”需要 Owner 明确 promotion，只能保存用户表达和 bounded conclusion，不保存 raw；
- Heartbeat 不能自动读取 Health raw data；未来主动健康提醒必须另写 rule、quiet hours、threshold source
  和 false-positive policy，并先 dry-run；
- 紧急症状与医疗问题始终建议寻求专业帮助，不能由模型作确定诊断。

### 5.10 历史导入

首次不要一次性导出所有历史与所有 metric：

1. 建立 P0 allowlist；
2. 每个 metric group 一个 automation；
3. 先手动发送 1 天 fixture；
4. 验证 receipt、R2 object、normalized row、daily rollup 和 UI；
5. 再按 7 天、30 天分段回填；
6. 开启 `Since Last Sync` 与 Batch Requests；
7. 检查 iPhone Auto Export Activity Logs 与 Health ingest ledger；
8. 全程不导入 workout route、ECG、medication 等 blocked group。

iOS 不保证后台精确调度，且锁屏时 app 不能读取 Health data，所以 UI 不能承诺实时。默认文案是“最近
同步”，不是“实时健康监控”。

### 5.11 Health 验收

- 无 token、错误 token、query token、超限 body、未知 schema、blocked metric 全部拒绝；
- 同一 session/body 重试幂等；同 session 不同 body 进入 attention；
- Batch Requests 乱序 / 重复不重复累计；
- timezone / DST / source priority / unit conversion 有 fixture；
- raw payload 不出现在 log、Tail、D1 error、TG、Artifact 或 Memory；
- R2 private，匿名/custom domain 不能读取；
- domain 详版与 Mini App 摘要来自同一 Health owner；
- missing day 显示缺失，不插值；stale sync 不显示“今日正常”；
- delete job 同时清理 raw、normalized、rollup、cache，并有 tombstone / completion proof；
- Opus 只收到 allowlisted summary；
- Mini App 后台 privacy mode 正确模糊；
- 断开 Auto Export / rotate token 后旧 token 失败；
- 1 天 → 7 天 → 30 天渐进回填均有 receipt 和数值对账。

## 6. 实施顺序

这三项不要并行一次上线。

### Phase A：Artifact

1. Agent Artifact owner / schema；
2. Safe Document；
3. Interactive Capsule opaque sandbox；
4. Mini App auto-open / inbox / full-screen route；
5. version / Pin / delete；
6. mobile 与 adversarial QA。

Artifact 先做，因为它不需要外部账号或健康数据，并且会成为 Calendar 报告、Health 解释和共同作品的
通用展示能力。

### Phase B：Google Calendar read-only

1. OAuth threat model 与 exact scopes；
2. external-browser connect / callback；
3. encrypted token store；
4. Calendar adapter full + incremental sync；
5. 今日卡、详情、时间线、Pin；
6. revoke / disconnect / 410 / DST / recurrence QA。

### Phase C：Health ingest foundation

1. Health owner Worker、private R2、D1、Queue；
2. dedicated REST ingest token；
3. 单字段 1 天 fixture；
4. P0 allowlist 与 daily rollups；
5. `health.example.com` 完整视图；
6. Mini App summary；
7. 7 / 30 天回填与 delete/export drill。

### Phase D：Opus explanation

Artifact、Calendar 和 Health 的 deterministic data path 都通过后，才让 Opus消费 bounded summary。
先 on-demand，后续是否每日自动总结或 Heartbeat 提醒另行决定；不能用模型掩盖数据管线未完成。

## 7. Rollout 与回滚

每个模块单独 feature flag：

```text
AGENT_HTML_ARTIFACTS_ENABLED=false
AGENT_INTERACTIVE_ARTIFACTS_ENABLED=false
CALENDAR_GOOGLE_ENABLED=false
HEALTH_INGEST_ENABLED=false
HEALTH_MINIAPP_ENABLED=false
```

- Artifact：先 local fixture，后 owner-only；失败关闭 route/catalog，不影响 TG 对话；
- Calendar：先 OAuth test user + primary read-only；失败 revoke token、关闭 adapter，不影响 Google Calendar；
- Health：先专用测试 token + synthetic fixture；真实数据前备份 schema、验证 delete；失败 revoke ingest token、
  停 Queue consumer，raw object 保持私有等待 Owner 决定删除；
- Mini App 卡片在任何模块关闭时显示 `not_configured/disabled`，不回退匿名 endpoint。

## 8. 仍需 Owner 在实施前确认的偏好

以下不是当前 Spec 阻塞，只在各 Phase 开始前确认：

1. Calendar 是只接 primary，还是选择多个 calendar；
2. private event 在 Mini App 显示标题还是统一显示“忙碌”；
3. Artifact ready 时，Mini App 前台是否总是自动打开，还是只对 Owner 明确说“做成网页”的任务自动打开；
4. Health P0 是否包含 weight；
5. Health raw / normalized / daily rollup 的最终 retention；
6. Health 完整页是否允许查看 raw sample，还是首版只到 daily rollup。

## 9. 来源校准（2026-07-17）

- Google Calendar OAuth scopes：
  `https://developers.google.com/workspace/calendar/api/auth`
- Google OAuth web-server flow、offline access 与 token handling：
  `https://developers.google.com/identity/protocols/oauth2/web-server`
- Google OAuth embedded user-agent policy：
  `https://developers.google.com/identity/protocols/oauth2/policies`
- Google Calendar incremental sync：
  `https://developers.google.com/workspace/calendar/api/guides/sync`
- Google Calendar push notifications：
  `https://developers.google.com/workspace/calendar/api/guides/push`
- Health Auto Export automation destinations 与 iOS limitations：
  `https://help.healthyapps.dev/en/health-auto-export/automations/`
- Health Auto Export REST API、custom headers、JSON v2 与 Batch Requests：
  `https://help.healthyapps.dev/en/health-auto-export/automations/rest-api/`
- Health Auto Export health metric JSON format：
  `https://help.healthyapps.dev/en/health-auto-export/export-format/health-metrics/`
- Cloudflare R2 S3-compatible presigned URLs：
  `https://developers.cloudflare.com/r2/api/s3/presigned-urls/`
