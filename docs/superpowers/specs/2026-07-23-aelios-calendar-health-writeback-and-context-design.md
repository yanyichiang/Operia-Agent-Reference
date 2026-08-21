---
title: Operia Calendar / Health 可写面板与动态上下文设计
date: 2026-07-23
status: owner-review-draft
scope: Google primary Calendar 全事件管理、Health 纠错叠加层、双基线、小时级小模型措辞、Mini App 与主对话动态上下文
coordinator_thread: <UUID>
baseline_commit: 8054e6d
implementation_authorized: false
production_authorized: false
---

# Operia Calendar / Health 可写面板与动态上下文设计

## 0. 审批摘要

本 Spec 将 Owner 的四项决定冻结为后续实现合同：

1. **Health 只写 Operia 纠错叠加层。** 原始 Apple Health / Health Auto Export 数据和既有
   `health_sample_index`、raw R2 object 不原地改写。手工操作表达的是“我根据 Apple 健康里的
   正确记录纠正 Operia 的展示”，而不是在 Operia 中创造另一份健康事实。每次纠错保留
   `source`、`corrects`、`supersedes`、`reason`、`revision`、审计和可逆的 `undo`。
2. **Calendar 管理 Google `primary` Calendar 的全部事件。** OAuth 从当前只读权限重新授权为
   最小可写 `calendar.events`；只管理 `primary`，不申请 Calendar ACL、Calendar list write、
   Settings write 或 Drive。创建、编辑、移动和删除均使用幂等键、Google `etag` / `If-Match`、
   Operia revision、逐动作审计和明确冲突回退，绝不静默 last-write-wins。
3. **Health 同时显示个人历史基线和有来源的通用参考。** 两者分栏、分标签、分 provenance；
   个人基线回答“我平时怎样”，通用参考回答“公开资料在什么适用人群和条件下给出怎样的范围”。
   通用参考不是诊断，不能覆盖个人基线，也不能在适用条件未知时自动判定正常或异常。
4. **每小时做 deterministic check，只有变化才调用小模型。** 新 Health 数据和手工纠错分别
   debounce；代码负责数值、趋势、缺失、基线和参考比较，小模型只把已经计算好的结构化事实改写为
   短中文。`projection_hash` 不变时零模型调用；模型不可用或预算耗尽时直接展示 deterministic 摘要。

Owner 审批本 Spec 不等于授权实现、OAuth 重新授权、migration、Provider、模型调用、生产写入或部署。

## 1. 目标与成功定义

### 1.1 产品目标

- Owner 在 Telegram Mini App 内查看并管理 Google `primary` Calendar 的全部可写事件；
- Owner 在 Google Calendar 修改后，Operia 在 push invalidation 后增量同步，并由小时级 reconciliation
  兜底；下一次对话可在缓存断点之后看到当前、下一项和当日剩余日程；
- Owner 在 Health 面板根据 Apple Health 纠正 Operia 的日聚合值或标记缺失，并随时撤销；
- Health 面板显示清晰的日概览、趋势、个人基线、通用参考、来源和 freshness；
- 新数据、纠错或参考版本改变时，生成短而保守的趋势摘要；没有变化时不调用模型；
- Calendar、Health、Mini App、Agent、Memory 各自保持唯一 owner，不产生第二份权限或健康真源。

### 1.2 P0 成功标准

1. Calendar 创建、读取、更新、移动、删除在本地 synthetic Google transport 上通过；所有更新和删除
   均以最新 `etag` 为前置条件，412 不覆盖对端修改。
2. Google 端变更经 body-less watch 通知触发增量同步；漏通知时由现有 10 分钟 scheduled sync 兜底。
3. Health 原始表和 raw object 在纠错、替代纠错、撤销期间保持 byte/hash 不变；effective projection
   只通过 append-only overlay 改变。
4. Health 个人基线和通用参考分别带计算窗口、覆盖率、来源、版本、适用条件和更新时间。
5. `projection_hash` 未变化的 24 个连续小时产生 24 次 deterministic check、0 次模型调用。
6. 主对话动态上下文仍位于最后一个 cache breakpoint 之后；stable prefix、
   `client_system_hash` 和 breakpoint 数量、位置均不变。
7. 360–430 px 手机竖屏与 844×390 横屏无横向溢出、遮挡或不可达操作；写入、冲突、撤销和失败状态
   都能在不依赖颜色的情况下识别。

## 2. 非目标与硬边界

本阶段不做：

- 不修改或回写 Apple Health / HealthKit；
- 不把 Health raw sample、raw export、自由文本纠错备注或 Google credential 写入 Memory；
- 不让 Mini App、Telegram D1、Agent 或模型 Provider 成为 Calendar / Health 真源；
- 不从 TG WebView 直接调用 Google API，不向浏览器下发 refresh token、Service bearer 或 Provider key；
- 不开放 secondary calendar、ACL、共享权限、Calendar 设置或 Drive 附件管理；
- 不提供医学诊断、风险评分、治疗建议、紧急告警或自动健康动作；
- 不让模型计算平均数、百分比、参考区间、单位换算、缺失天数或冲突结果；
- 不在 prompt stable prefix、persona、precious、digest 或长期记忆中保存当前日程和健康状态；
- 不通过 Heartbeat 主动向 Telegram 发送健康提醒；本 Spec 的“背景消息”仅指一次主对话请求内的
  `client_volatile_context`；
- 不复制 SparkyFitness、Open Wearables、wger 的代码、样式、图标、插画、数据库或品牌资产；
- 不把已经 404 的 HealthNOOP / NOOP 当依赖、设计真源或可验证项目。

## 3. 当前基线与差距

### 3.1 Calendar 当前状态

当前 `src/calendar/index.ts` 只申请：

```text
openid
email
https://www.googleapis.com/auth/calendar.events.readonly
```

当前 Calendar owner 已具备：

- 独立 OAuth handoff、PKCE、加密 refresh token；
- `primary` Calendar 的 full + incremental sync；
- `nextSyncToken`、deleted tombstone、410 full-resync；
- 20 分钟 projection freshness；
- 每 10 分钟 scheduled sync；
- TG Mini App 与 per-turn Calendar ambient projection。

当前缺少：

- 可写 scope 的显式 reauthorization；
- event `etag`、Google `updated`、Operia revision 和 write capability projection；
- create/update/delete/move API、幂等 ledger、未知副作用恢复和逐动作审计；
- Google watch channel 的创建、续期、通知验签/匹配与小时级 repair；
- Calendar 写入 UI、conflict diff、pending/unknown/retry 状态；
- Google 端改动进入动态上下文前的 projection hash 和版本收据。

### 3.2 Health 当前状态

当前 Health owner 已具备：

- Health Auto Export JSON v2 进入 private R2；
- D1 batch/sample index、daily aggregate、幂等 fingerprint 与 ingest audit；
- 7/30/90 天 bounded projection；
- TG Mini App 摘要、Health domain 面板与 Agent `health_summary` / `health_trends` 查询；
- raw 不进入 TG、Agent 或 Memory。

当前缺少：

- 手工纠错/annotation overlay 和 effective resolver；
- `corrects` / `supersedes` / undo / correction revision；
- 个人 28 日基线、通用参考 registry 和双 provenance；
- projection hash、小时级 deterministic check、debounce、summary job / budget / fallback；
- Health 动态上下文；
- 纠错、双基线、参考来源、模型摘要状态和撤销 UI。

### 3.3 Mini App 当前状态

当前 Calendar 详情标记为 `read-only projection`，Health 标记为 `只读趋势`；Health 使用双列指标卡与
7/30 天 sparkline。可访问性合同存在，但仓库没有 committed Playwright screenshot baseline 或
pixel-diff threshold。Source Han Serif 的真实同源 WOFF2 入口只在 Mini App 有保证，且当前 Regular
文件会合成 700。上述视觉债不在本 Spec 中顺手修复，但实现验收必须覆盖。

## 4. 唯一 Owner 与消费关系

| 事实 / 能力 | Canonical owner | 权威存储 / 执行 | 消费者可做 | 消费者不可做 |
| --- | --- | --- | --- | --- |
| Google credential、watch、sync token | Calendar owner | Calendar D1 + encrypted credential | 看 configured/revoked/freshness | 读 token、复制 credential |
| Google primary event | Google Calendar | Google Calendar API | Calendar owner 缓存 bounded projection | 将 projection 当写入真源 |
| Calendar mutation ledger / audit | Calendar owner | Calendar D1 | TG 展示结果、冲突和审计摘要 | TG 自行重放写入 |
| Health raw export / sample | Health owner | private R2 + Health D1 | 读取 bounded aggregate | 复制 raw / sample array |
| Health correction overlay | Health owner | Health D1 append-only ledger | TG 请求 exact correction/undo | 修改 raw 或缓存本地 correction |
| Health personal baseline | Health owner | deterministic projection | TG / Agent 读取带 provenance 的比较 | 模型重新计算 |
| Health general reference | Health owner | versioned curated registry | 显示来源/版本/适用条件 | 模型发明参考值 |
| Health summary facts / hash | Health owner | deterministic builder + D1 | Agent 只消费结构化措辞任务 | Agent 改数值或基线 |
| Health summary wording task / budget | Agent owner | Agent task/usage audit + existing AI binding | Health 接收 schema-valid 短文 | Agent 保存 raw Health |
| 主对话 inference / prompt cache | Memory owner | Memory inference runtime | 接收 per-turn volatile context | 将动态事实写入 stable prefix |
| Mini App presentation / request | Telegram owner | TG session / CSRF / BFF | 渲染、收集明确动作、转发 owner API | 成为 Calendar/Health owner |

### 4.1 Canonical key 预约

后续实现必须先在 Control Registry 登记以下 canonical keys；本 Spec 不修改 registry：

| Key | Owner | Strategy | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `calendar.google.write.enabled` | Calendar | `deny_only` | `false` | Calendar owner 硬写入门 |
| `calendar.google.watch.enabled` | Calendar | `deny_only` | `false` | Google push invalidation 门 |
| `health.corrections.enabled` | Health | `deny_only` | `false` | 纠错/undo 总门 |
| `health.references.enabled` | Health | `deny_only` | `false` | 通用参考展示门 |
| `health.summary.enabled` | Health | `deny_only` | `false` | deterministic summary 流程门 |
| `agent.health_summary.model.enabled` | Agent | `deny_only` | `false` | 小模型措辞门；不扩大 Health 读取范围 |
| `agent.health_summary.daily_call_limit` | Agent | `numeric_min` | `24` | 所有触发合计的每日模型调用硬上限 |
| `telegram.miniapp.calendar_write.enabled` | Telegram | `deny_only` | `false` | TG 展示写入入口；不能突破 Calendar gate |
| `telegram.miniapp.health_corrections.enabled` | Telegram | `deny_only` | `false` | TG 展示纠错入口；不能突破 Health gate |
| `telegram.ambient.health.enabled` | Telegram | `deny_only` | `false` | Health volatile context 门 |

所有开关只允许收紧。TG gate 打开而 owner gate 关闭时，UI 必须显示 `owner_disabled`，不能写入。

## 5. Calendar 写回合同

### 5.1 OAuth reauthorization

Owner 当前 refresh token 只有只读 scope，不能原地假设获得写权限。升级流程固定为：

1. Mini App 显示“需要重新授权”，列出新增能力：查看并编辑 `primary` Calendar 的事件；
2. 通过现有一次性 handoff 在系统浏览器启动 OAuth，不在 Telegram WebView 输入 Google 凭据；
3. 请求最小 scopes：

```text
openid
email
https://www.googleapis.com/auth/calendar.events
```

4. callback 必须验证 state、PKCE、Owner、Google `sub/email` 和实际 token scope；
5. 新 credential 加密成功、一次 bounded sync 成功后，才原子切换 credential generation；
6. 旧只读 credential 在新授权成功前保持可回滚读取；成功后撤销/删除旧 credential；
7. 拒绝授权或 scope 不足时，维持 read-only，不删除可用旧连接；
8. 重新授权、拒绝、失败、切换和 revoke 均记录 content-free audit。

不申请 `calendar`、`calendar.events.owned`、Calendar list write、ACL 或 Drive。选择
`calendar.events` 是因为 Owner 要管理 `primary` 中 API 允许写的全部事件，而不是只管理自己创建的事件；
Google 最终仍按单事件权限决定可写性。

### 5.2 Projection v2

Calendar projection 增加但不暴露 description/attendee 正文：

```ts
type CalendarEventProjectionV2 = {
  schemaVersion: 2;
  eventId: string;
  calendarId: "primary";
  title: string | "忙碌";
  start: string;
  end: string;
  timezone: string;
  allDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  recurrence?: {
    recurringEventId: string;
    originalStartTime: string;
    editableScopes: Array<"instance" | "series">;
  };
  etag: string;
  googleUpdatedAt: string;
  ownerRevision: number;
  writeCapability:
    | "create_update_delete"
    | "update_response_only"
    | "read_only"
    | "unsupported_event_type";
  observedAt: string;
  staleAfter: string;
};
```

`etag` 是 opaque value，只允许作为 `If-Match` 前置条件；不得放进 URL。TG 只持有当前页面内的短期
projection，不在 TG D1 建 event mirror。

### 5.3 Owner API

浏览器永远调用 TG BFF；TG 通过 Calendar Service Binding 调用以下 owner endpoints：

| Method / path | 作用 | 必要条件 |
| --- | --- | --- |
| `GET /service/calendar/projection?v=2` | bounded agenda / freshness | service bearer + owner ID |
| `GET /service/calendar/events/:id` | 打开编辑器时读取最新事件 | service bearer + owner ID |
| `POST /service/calendar/events` | 创建事件 | write flag + idempotency key |
| `PUT /service/calendar/events/:id` | get + merge + full update | `If-Match` Google etag + owner revision |
| `DELETE /service/calendar/events/:id` | 删除 | `If-Match` + owner revision + explicit scope |
| `POST /service/calendar/events/:id/move` | 仅更改 start/end/timezone | `If-Match` + owner revision |
| `POST /service/calendar/sync` | 请求 bounded freshness sync | read scope；限流，不是写入绕路 |
| `GET /service/calendar/audit` | bounded content-free 审计 | owner/admin scope |

TG BFF 对应公开同源路径只接受已认证 Mini App session、精确 Origin 和 session-bound CSRF。所有 mutation
body 上限 16 KiB；未知字段拒绝，不透传任意 Google request body。

### 5.4 Mutation envelope

```ts
type CalendarMutationEnvelope = {
  requestId: string;
  idempotencyKey: string;
  ownerId: string;
  sourceDomain: "tgbot.example.com";
  action: "create" | "update" | "move" | "delete";
  eventId?: string;
  recurrenceScope?: "instance" | "series";
  expected: {
    googleEtag?: string;
    ownerRevision?: number;
  };
  patch: {
    summary?: string;
    start?: { date?: string; dateTime?: string; timeZone?: string };
    end?: { date?: string; dateTime?: string; timeZone?: string };
    description?: string;
    location?: string;
    transparency?: "opaque" | "transparent";
  };
};
```

P0 编辑器不修改 attendees、conferenceData、attachments、ACL 或 event type 专有字段。更新时 Calendar
owner 必须先 `events.get` 最新完整资源，把 allowlisted patch 合并到最新对象，再带 `If-Match` 调用
`events.update`；这样不会因为局部表单删除未展示字段，也避免 `events.patch` 的额外 quota 成本。

### 5.5 幂等、CAS 与未知结果

- **Create**：Operia 先写 `prepared` ledger，并使用由 idempotency key 派生、符合 Google event ID
  规则的稳定 ID；相同 key + 相同 request hash 返回同一结果，相同 key + 不同 hash 返回 409。
- **Update / move / delete**：必须同时匹配 owner revision 和 Google `etag`。Google 412 转为
  `calendar_conflict`，随后读取最新版本并返回 bounded field-level diff；不自动重放、不静默覆盖。
- **网络未知结果**：进入 `outcome_unknown`，先按 event ID read-after-write：
  - create 找到相同 Operia operation marker / request hash，收敛为成功；
  - update/move 只在目标字段与 request hash 一致时收敛为成功；
  - delete 仅在明确 404/410 时收敛为成功；
  - 其余进入 attention，禁止盲重试。
- **409/412 UX**：编辑 sheet 保留 Owner 草稿，展示“Google 上已有更新”以及本地/远端差异；按钮只有
  `使用 Google 最新版本` 和 `基于最新版重新应用我的修改`，后者产生新 idempotency key 与新 etag。

### 5.6 Recurrence 与事件覆盖

- `primary` 中普通单次事件：create/update/move/delete；
- recurring master：支持 `series` 更新/删除；
- recurring instance：支持 `instance` 更新/删除并保留 `originalStartTime`；
- “此项及后续”需要拆分 recurrence rule，P0 不伪装支持，显示 `later_phase`；
- Google 返回 read-only、特殊 event type 或权限不足时仍显示事件，但操作按钮禁用并展示 Google 原因；
- “全部事件”指 primary 中全部事件都进入 projection 与 capability 判定，不是承诺绕过 Google 权限。

### 5.7 Watch 与 reconciliation

Google Calendar push notification 没有 event body，只能作为“数据可能变化”的 invalidation：

1. Calendar owner 为 `primary/events` 建立 watch channel，保存随机 channel ID、resource ID、到期时间和
   token hash；token 不含 secret；
2. 通知入口只接受精确 path，匹配 channel ID、resource ID 和 token hash；
3. 任何有效通知只合并为一个 30 秒 debounce 的 incremental sync；
4. sync 完成后更新 `projection_hash` 和 `calendar_projection_revision`；
5. channel 在到期前 24 小时续期；旧 channel 明确 stop；
6. 保留当前 10 分钟 scheduled sync 作为 reconciliation，即使 watch 正常也检查 sync token；Health 的
   “每小时 deterministic check”是独立摘要策略，不降低 Calendar 现有同步频率；
7. 410 清 projection 并 full resync；失败时保留旧 projection 但标 `stale/unavailable`；
8. watch 入口需要 route / Access 例外设计和生产配置，必须单独授权，不能由本 Spec 自动创建。

### 5.8 Calendar audit

每个动作保存：`event_id_hash`、action、actor、source domain、request/idempotency key hash、old/new etag
hash、old/new canonical field hash、recurrence scope、provider status、owner revision、trace/request ID、
started/completed time、final outcome。不得保存 token、完整 description、attendee、location 或事件正文。

## 6. Health append-only 纠错叠加层

### 6.1 语义

Mini App 的主按钮固定文案为 **“按 Apple 健康更正”**。它不表示向 Apple Health 写入，也不允许把
Operia 当作独立手工健康账本。Owner 先在 Apple Health 中确认值，再对 Operia 当前某日某指标的投影
发起 correction。

允许的 P0 correction：

- `replace_daily_value`：替换 Operia 对某个 `metric + local_date + aggregation + unit` 的 effective 值；
- `mark_missing`：Apple Health 中确认该日没有可用记录时，将 effective 值标为缺失；
- `annotation_only`：附加 owner-only 说明，不改变数值；默认不进入模型或动态上下文。

不允许：

- 修改或删除 raw R2 object；
- UPDATE/DELETE `health_sample_index` 或 `health_daily_aggregates` 以实现“纠正”；
- 创建没有 `corrects` target 的独立健康值；
- 以 correction 绕过 metric allowlist、单位合同或 retention；
- 把自由文本备注交给小模型。

### 6.2 Correction event

```ts
type HealthCorrectionEvent = {
  correctionId: string;
  ownerHash: string;
  target: {
    metric: string;
    localDate: string;
    aggregation: "sum" | "median" | "last";
    unit: string;
    sourceAggregateRevision: number;
    sourceAggregateHash: string;
  };
  operation: "replace_daily_value" | "mark_missing" | "annotation_only" | "undo";
  valueNum?: number;
  source: {
    kind: "owner_verified_apple_health";
    observedIn: "apple_health_app";
    verifiedAt: string;
  };
  corrects: string;
  supersedes?: string;
  revertsCorrectionId?: string;
  reason:
    | "apple_health_value_differs"
    | "late_sync"
    | "duplicate_source"
    | "wrong_source_priority"
    | "timezone_or_day_boundary"
    | "other";
  note?: string;
  revision: number;
  actor: { type: "owner"; sourceDomain: "tgbot.example.com" | "health.example.com" };
  requestId: string;
  idempotencyKeyHash: string;
  createdAt: string;
};
```

`corrects` 固定引用 `health-daily:<metric>:<date>:<sourceAggregateRevision>`，不能引用自由文本。
`note` 仅 Health owner 私密存储，最长 280 字，不进入 timeline、日志、模型、Agent 或 Memory。

### 6.3 Effective resolver

```text
raw samples (immutable)
  -> canonical daily aggregate (existing deterministic calculation)
  -> latest active correction chain by revision
  -> unit/schema validation
  -> effective daily point + correction provenance
  -> personal baseline / reference comparison / projection hash
```

规则：

1. correction 创建时必须 CAS 匹配 `sourceAggregateRevision` 与当前 correction chain revision；
2. 同一 target 的新 correction 必须显式 `supersedes` 当前 active correction；
3. 旧 correction 保留，不更新状态正文；active 状态由 event chain 计算；
4. ingest 新数据重算 source aggregate 后，不自动覆盖 correction；projection 标记
   `source_changed_after_correction`，要求 Owner review；
5. effective value 始终带 `valueOrigin=raw|correction|missing_by_correction`、correction ID 和 revision；
6. raw 纠错前后 hash、sample count、batch link 必须一致。

### 6.4 Undo

Undo 不是 DELETE/UPDATE correction。`POST /service/health/corrections/:id/undo` 创建新的
`operation=undo` event，引用 `revertsCorrectionId`，revision 加一。resolver 回到该 correction 之前最近的
有效状态；如果后续已有 superseding correction，旧 correction 不能直接 undo，返回 409 并要求 Owner
选择最新 chain。Undo 也触发 projection rebuild、summary debounce 和完整审计。

### 6.5 Health owner API

| Method / path | 作用 | 门禁 |
| --- | --- | --- |
| `GET /service/health/projection?v=2` | effective projection + dual baselines | TG / Agent scoped bearer |
| `GET /service/health/corrections?metric=&date=` | bounded correction history | Owner presentation scope |
| `POST /service/health/corrections` | append correction | corrections flag + CSRF upstream + idempotency + CAS |
| `POST /service/health/corrections/:id/undo` | append undo | latest-chain CAS |
| `GET /service/health/references` | curated public reference registry | scoped read |
| `GET /service/health/summary` | deterministic/model wording state | TG / Agent scoped read |
| `POST /service/health/rebuild` | internal debounce/reconciliation | internal service only；浏览器不可调用 |

Health `admin` batch delete 保持独立高风险操作，不与 correction UI 混合。

## 7. 双基线与 provenance

### 7.1 个人历史基线

P0 对每个日指标使用目标日前 28 个本地日的 effective daily points：

- 计算方法：median；
- 最少 14 个 `complete` 日；少于 14 日为 `insufficient_data`；
- 当前日不进入自己的 baseline；
- `missing` 不当 0，不插值；
- correction 生效后的 effective point 可进入以后日期的 baseline，但 provenance 记录 correction 占比；
- 源/单位变化时分段，不跨不兼容单位计算；
- 同时输出绝对差和百分比；prior/baseline 为 0 时百分比为 null；
- 算法版本固定为 `personal_median_28d_v1`。

```ts
type PersonalBaseline = {
  kind: "personal";
  algorithmVersion: "personal_median_28d_v1";
  window: { from: string; to: string; eligibleDays: number; requiredDays: 14 };
  value: number | null;
  unit: string;
  deltaAbsolute: number | null;
  deltaPercent: number | null;
  correctionDays: number;
  status: "available" | "insufficient_data" | "unit_changed";
  computedAt: string;
};
```

### 7.2 通用参考 registry

通用参考不是模型常识，而是 Health owner 中审阅过的 versioned registry：

```ts
type HealthGeneralReference = {
  referenceId: string;
  metric: string;
  version: string;
  value: { kind: "minimum" | "range" | "weekly_range"; min?: number; max?: number; unit: string };
  period: "day" | "week" | "resting_measurement";
  population: string;
  applicability: string[];
  exclusions: string[];
  publisher: string;
  title: string;
  sourceUrl: string;
  publishedAt?: string;
  reviewedAt: string;
  effectiveFrom: string;
  status: "active" | "superseded" | "withdrawn";
  disclaimer: "informational_not_medical_diagnosis";
};
```

P0 初始 registry：

| Metric | 通用参考 | 来源与适用边界 | 自动比较 |
| --- | --- | --- | --- |
| `sleep.total_minutes` | 18–60 岁成人每天 7 小时或以上 | CDC；年龄限定；睡眠质量不能由时长代表 | 只有明确匹配年龄段才比较，否则只展示来源 |
| `cardio.resting_heart_rate` | 多数成人静息 60–100 bpm | American Heart Association；运动水平、药物等可显著影响 | 只显示“相对公开区间”，不标正常/异常 |
| `activity.exercise_minutes` | 成人每周 150–300 分钟中等强度，或 75–150 分钟高强度 | WHO；必须确认 Apple metric 与强度语义可映射 | 映射不确定时 `not_applicable` |
| `activity.steps` | P0 不设通用步数目标 | 没有采用一个对所有人适用的官方日步数阈值 | 仅个人基线 |
| `cardio.hrv_sdnn` | P0 不设通用阈值 | 设备、年龄、算法和个体差异大 | 仅个人基线 |
| `body.weight` | P0 不从单一体重推导通用结论 | 缺少身高/年龄/情境；不在此引入 BMI 诊断 | 仅个人基线 |

任何新增参考必须 content review、来源 URL 可访问、单位与 aggregation 可映射并增加 registry version；
不能让模型或 UI 文案临时补一个“标准值”。

### 7.3 UI 分栏规则

每个 Health metric detail 固定顺序：

1. `当前值`：effective value、来源、freshness、是否有 correction；
2. `与你自己相比`：28 日 personal baseline、窗口、覆盖率、差值；
3. `通用参考`：公开值、适用人群、来源、版本、review date；
4. `说明`：非医疗诊断；不适用/未知时明确显示原因。

个人基线用“你的 28 日中位数”标签；通用参考用“公开参考 · 非诊断”标签。两者不合并成一个
红/黄/绿评分，不用通用参考替换个人 baseline。

## 8. Deterministic summary 与小模型措辞

### 8.1 Trigger 与 debounce

Health owner 维护每个 Owner 的 summary state：

- **小时检查**：每小时第 05 分按 `<YOUR_TIMEZONE>` 建 deterministic projection；
- **新 ingest**：最新 accepted batch 后 5 分钟 debounce，连续 ingest 合并；
- **correction / undo**：成功后 60 秒 debounce，连续手工操作合并；
- **reference version change**：下一小时重建，不自动触发 Provider；
- 同一 `projection_hash` 只允许一个 in-flight 或 completed summary；
- correction UI 的确定性数值立即更新，不等待小模型。

### 8.2 Hash

`projection_hash = SHA-256(stable_json(...))`，输入仅含：

- effective daily points 的 bounded 7/28 日摘要；
- freshness、missing/coverage；
- active correction revision 和 correction reason enum；
- personal baseline value / algorithm version；
- general reference IDs / versions / applicability result；
- deterministic trend labels；
- summary schema / policy version。

不含 raw sample、R2 key、note、Owner ID、自由文本、token 或 presentation timestamp。

### 8.3 代码先算完

Health deterministic builder 输出：

```ts
type HealthSummaryFactsV1 = {
  schema: "operia.health.summary_facts.v1";
  period: { from: string; to: string; timezone: "<YOUR_TIMEZONE>" };
  freshness: "fresh" | "stale" | "missing";
  observations: Array<{
    metric: string;
    current: number | null;
    unit: string;
    direction: "up" | "down" | "flat" | "insufficient_data";
    personalComparison?: { deltaAbsolute: number; deltaPercent: number | null };
    generalReference?: { referenceId: string; relation: "below" | "within" | "above" | "not_evaluated" };
    correctionActive: boolean;
    missingDays: number;
  }>;
  notices: Array<"stale" | "corrected" | "reference_not_applicable" | "insufficient_personal_baseline">;
  disclaimer: "informational_not_medical_diagnosis";
  projectionHash: string;
};
```

所有数值、方向、关系和 notice 均由代码决定。模型只能返回：

```ts
type HealthSummaryWordingV1 = {
  headline: string;        // <= 48 中文字符
  observations: string[]; // 1..3，每项 <= 72 中文字符
  caution?: string;       // <= 72 中文字符，只能复述 facts 中的 notice
};
```

输出禁止诊断、疾病推断、治疗建议、恐吓、补充数值、改变 reference relation 或提及未给出的指标。
schema/长度/引用校验失败时丢弃模型结果，使用 deterministic template。

### 8.4 执行 owner、模型与预算

- Health owner 拥有 facts、hash、summary state 和最终 projection；
- Agent owner 通过专用 Service Binding 接收 `HealthSummaryFactsV1`，执行小模型措辞并记录 usage；
- P0 推荐复用 Agent 已有 Workers AI binding 的 `@cf/zai-org/glm-4.7-flash`，原因是无需新增外部
  Provider secret，并可使用现有 Workers AI 免费额度；
- DeepSeek 仅作为后续可选 adapter，默认 disabled；启用前重新核验当时模型名、价格、数据处理和
  Provider policy，不能把旧 `deepseek-chat` 名称写死为长期合同；
- 每 Owner 每自然日最多 24 次模型调用，小时/ingest/correction 触发共用额度；
- 每 hash 最多 1 次成功调用，失败最多 1 次 bounded retry；未知结果不盲重放；
- 每次输入上限 4 KiB，输出上限 1 KiB，timeout 10 秒；
- 预算耗尽、binding 不可用、模型失败或 feature flag off 时，Health projection 仍立即更新，
  `wordingStatus=deterministic_fallback`；
- 本 Spec 不授权任何真实模型调用、Provider enablement 或预算变更。

## 9. 主对话 volatile context 与 cache 边界

### 9.1 路径

```text
Calendar owner projection ----\
                               -> TG per-turn ambient builder
Health owner summary ---------/       -> [动态上下文]
                                          -> Memory Prompt Assembler
                                          -> client_volatile_context
                                          -> current owner message
```

Memory 继续拥有主对话 inference、transport 和 prompt cache。Calendar/Health/Telegram/Agent 都不把
这些动态事实写入 persona、precious、rolling summary 或长期 Memory。

### 9.2 `operia.ambient.v2`

总上限继续保持 2 KiB UTF-8，字段顺序固定：

1. local exact time / timezone；
2. Calendar owner / status / projection revision / observed / stale；
3. current、next、remaining today；
4. Health owner / status / projection hash prefix / observed / stale；
5. Health deterministic or validated wording headline + 最多 2 observations；
6. disclaimer 与 unavailable sources。

Calendar 预算 850 bytes，Health 预算 850 bytes，其余给 header/freshness。超过上限按固定优先级截断：
Health 第 2 条观察 -> Calendar remaining -> Health 第 1 条观察；owner/status/freshness 永不截断。

禁止注入：event description、attendees、location、raw sample、daily series、correction note、通用参考全文、
Provider/model metadata、tool result 或 URL credential。

### 9.3 Freshness

- stale Calendar 不注入事件正文，只注入 `status=stale`；
- stale Health 不注入数值，只注入 headline `健康数据已过期` 和 freshness；
- Calendar/Health unavailable 不填 0 或“今天没有安排/一切正常”；
- ambient context 在每次主对话 request start 重新读取 bounded owner projection；
- `projection_hash` / owner revision 可变，但只改变 `client_volatile_context`；
- verifier 必须证明 stable `client_system_hash`、1h/5m cache anchor 和 breakpoint 位置 byte-identical。

## 10. Mini App 信息架构与视觉方向

### 10.1 借鉴边界

正式视觉参考为 SparkyFitness 的官方 README hero 和产品文档。可借鉴：

- “今日概览 -> 目标/当前值 -> 紧凑趋势 -> 明细”的信息层级；
- 一屏先给最需要的数字，再进入长周期报告；
- 指标类别色、进度表达、14 日趋势和快速记录入口；
- desktop/card 与 mobile 单列之间的响应式收敛；
- 数据自托管、来源可见、家庭/多 profile 的清晰边界理念。

不可借鉴：

- 代码、CSS、组件、图标、截图、文案和品牌；
- SparkyAI、family access 或 API beta 的实现判断；
- 将营养/减重产品的“目标达成”语义套到全部健康指标；
- 将项目作为依赖。SparkyFitness 使用非商业许可证，只作为设计观察材料。

Operia 保留纸色、细边框、思源宋体和奏折式层级；不改成通用 SaaS 蓝白 dashboard，也不让健康指标
充满红绿告警。

### 10.2 Calendar 页面

#### Calendar Overview

- 顶部：日期、同步状态、Google account masked label、`+ 新建`；
- 主区域：`正在进行`、`下一项`、`今天还有 N 项`；
- 视图切换：日 / 三日 / 周；
- agenda list：时间轴、all-day、recurring、private/忙碌、write capability；
- freshness footer：最近 Google sync、watch 状态、10 分钟 repair 状态；
- 冲突/attention 以独立 banner 显示，不用 toast 代替持久状态。

#### Create / Edit sheet

- bottom sheet 在 360–430 px 宽使用全高可滚动布局；
- 字段：标题、全天、开始、结束、时区、地点、描述、busy/free；
- recurring 事件先选 `此项` / `整个系列`；
- 保存前显示摘要；删除使用单独 danger zone 和二次确认；
- pending 时锁定重复提交但允许关闭后在“待处理”看到 operation；
- 409/412 不丢草稿；未知结果进入 attention。

#### 直接操控

- agenda 中长按后可进入 move sheet；
- P0 不用无确认 drag-and-drop 直接写 Google；
- `今天`、`前一天/后一天` 和“跳到日期”均保持 44 px target；
- 点事件默认先看详情，不把整行点击误当修改。

### 10.3 Health 页面

#### Health Overview

- 顶部：`今日健康`、last sync、source、freshness、summary wording status；
- 头部摘要：deterministic/validated headline，明确 `非医疗诊断`；
- 关键指标：睡眠、步数、运动、静息心率、HRV、体重（有数据才显示）；
- 每个指标只显示当前值、7/14 日 sparkline、个人 baseline delta 和 correction badge；
- category color 只编码类别，不编码好坏；
- `按 Apple 健康更正` 是 detail 内的次级按钮，不放成无上下文全局 FAB。

#### Metric Detail

- 7 / 14 / 30 / 90 日切换；
- 图上不连接 missing days；correction 点使用可见 marker；
- 图下固定三段：当前值、与你自己相比、通用参考；
- 通用参考有来源链接、适用条件、版本、reviewedAt；
- `查看纠错记录` 打开 append-only timeline，可选最新 correction 执行 undo。

#### Correction sheet

- header 固定：`按 Apple 健康更正 Operia`；
- 显示 target metric/date、Operia 当前 source/effective value 和 source revision；
- Owner 输入 Apple Health 中确认的值，或选择“Apple Health 中无此记录”；
- reason 必选，note 可选；
- 保存前明确“不会修改 Apple Health 原始数据”；
- CAS conflict 时重新读取，不自动覆盖；
- 成功后立即显示 effective 值和 `已更正` badge；摘要状态显示 `正在更新措辞` 或 deterministic fallback。

### 10.4 全局状态词汇

| 状态 | Calendar | Health | UI 行为 |
| --- | --- | --- | --- |
| `disabled` | 写入 gate 关闭 | correction/summary gate 关闭 | 保留只读，说明 owner gate |
| `not_configured` | 未连接 Google | 无 Health ingest | 提供连接/配置说明，不显示 0 |
| `reauthorization_required` | 仍是 readonly scope | 不适用 | 明确重新授权，不破坏旧只读连接 |
| `syncing` | 增量同步中 | projection rebuild 中 | 展示旧值 + working badge |
| `fresh` | 当前 projection | 当前 effective projection | 正常展示 freshness |
| `stale` | 旧 event projection | 旧 Health projection | 不当当前事实注入 Agent |
| `write_pending` | mutation prepared/sent | correction append pending | 禁止重复提交，保留 operation ID |
| `conflict` | etag / revision mismatch | source/correction revision mismatch | 保留草稿，给明确解决分支 |
| `outcome_unknown` | Google side effect 不确定 | D1 commit 不确定 | attention；不盲重放 |
| `summary_pending` | 不适用 | hash 已变、等待 wording | 数值先更新，摘要可稍后 |
| `summary_fallback` | 不适用 | flag/预算/模型失败 | 展示 deterministic 文案 |
| `reference_not_applicable` | 不适用 | 适用条件不匹配/未知 | 显示来源但不自动比较 |
| `insufficient_baseline` | 不适用 | 少于 14 complete days | 不用 0 代替 baseline |
| `offline` | 无法确认写入 | 无法确认 correction | 禁止新写，允许看已缓存非敏感 UI shell |

## 11. 移动端与可访问性验收矩阵

### 11.1 Viewports

| Viewport | Calendar 验收 | Health 验收 |
| --- | --- | --- |
| 360×800 | sheet 单列；日期/时区不溢出；保存/取消可达 | 指标单列；双基线不并排压缩；纠错键盘不遮按钮 |
| 390×844 | Telegram 主验收；agenda、bottom nav、safe area 完整 | overview、detail、correction、undo 全链路 |
| 430×932 | 卡片不过宽；三日视图可水平局部滚动而页面不滚 | 两列仅在内容宽度足够时启用；source link 可读 |
| 768×1024 | split view：agenda + detail；sheet 最大宽度受控 | 2–3 列指标；detail 图和双 baseline 不脱节 |
| 844×390 | 横屏 toolbar 不遮 agenda；sheet 内部滚动 | chart 保留最小高度；操作与 nav 不重叠 |

### 11.2 共同要求

- 所有触控目标至少 44×44 CSS px；
- `env(safe-area-inset-*)` 下 bottom nav、sheet footer 和系统手势区不重叠；
- 200% zoom 仍能完成 create/edit/delete/correction/undo；
- focus 顺序与视觉顺序一致；dialog/sheet 有名称、focus trap、Escape/返回行为和焦点恢复；
- 错误、pending、conflict、correction 不只靠颜色，必须有文字/图标名称；
- `prefers-reduced-motion` 下禁用非必要动画；sparkline 不承担唯一信息；
- 思源宋体文件真实加载失败时回退明确，contract 断言 computed font；
- 400/700 合成问题不在本任务修复，但视觉基线记录 computed weight；
- light / Telegram theme 下对比度满足 WCAG AA；
- 无未捕获 console error、横向页面 overflow、重复表单提交或浏览器原生 validation 死角。

### 11.3 最小视觉回归集

| 页面 | 状态 | 390×844 | 844×390 | 768×1024 |
| --- | --- | --- | --- | --- |
| Calendar overview | fresh + current/next/all-day/recurring | 必测 | 必测 | 必测 |
| Calendar editor | create + keyboard | 必测 | 必测 | 抽测 |
| Calendar conflict | 412 field diff | 必测 | 抽测 | 必测 |
| Calendar attention | outcome_unknown | 必测 | 抽测 | 抽测 |
| Health overview | fresh + corrected + missing | 必测 | 必测 | 必测 |
| Health metric | personal + reference + source | 必测 | 必测 | 必测 |
| Health correction | replace / mark missing / CAS conflict | 必测 | 必测 | 抽测 |
| Health history | correction + supersede + undo | 必测 | 抽测 | 必测 |
| Health summary | pending / validated / fallback / stale | 必测 | 抽测 | 抽测 |

实现 Gate D 前必须提交 screenshot baseline 和合理的 pixel-diff threshold；本 Spec 本身不创建图片基线。

## 12. 权限、隐私与审计

### 12.1 Mini App mutation 门禁

每次写入必须同时满足：

1. Telegram `initData` 验证并匹配 configured owner；
2. short-lived HttpOnly, Secure, SameSite=Strict Mini App session；
3. 精确 same-origin / Origin 校验；
4. session-bound CSRF；
5. exact action schema、body bound、idempotency key；
6. TG server-side 专用 Service bearer；
7. canonical owner 重新验证 owner、scope、feature flag、revision/CAS；
8. canonical owner 写逐动作 audit 后才返回成功。

Cloudflare Access 只作为入口身份层，不替代上述应用授权。

### 12.2 隐私

- Calendar projection 默认折叠 description、attendees、meeting notes、attachments；private/confidential
  event 继续显示“忙碌”；
- Health raw、correction note、详细 daily series 不进入 TG D1、Memory、Agent task log 或模型；
- Agent summary usage 记录 metric key 数量、bytes、hash、model/purpose、tokens/cost，不记录 values；
- 审计 UI 默认显示动作、时间、结果、revision 和稳定 locator，不显示敏感正文；
- export / delete / retention 不在 P0 mutation sheet 中混用；
- screenshots、fixtures、logs 只使用 synthetic values 和 placeholder account。

## 13. 数据模型与 migration 预约

后续实现预计使用两个 owner 各自的 additive migration：

### Calendar D1

- `calendar_event_projection` 增加 etag、Google updated、owner revision、write capability；
- `calendar_mutation_operations`：幂等、request hash、state machine、unknown outcome；
- `calendar_mutation_audit`：content-free old/new hashes；
- `calendar_watch_channels`：channel/resource/token hash/expiry/status；
- `calendar_projection_receipts`：projection hash、sync source、revision。

### Health D1

- `health_correction_events`：append-only correction/supersede/undo；
- `health_reference_registry`：versioned curated references；
- `health_projection_receipts`：effective hash、correction/reference/baseline versions；
- `health_summary_jobs`：trigger/hash/lease/status/budget receipt；
- `health_summary_revisions`：facts hash、wording schema、model metadata、fallback state；
- `health_summary_audit`：content-free trigger/result/usage。

**本 Spec 不占 migration 号。** 实现开始时由 coordinator 现场读取 `migrations/`、
`migrations-calendar/`、`migrations-health/` 并预约各目录下一个可用号。当前 baseline 的编号只作为
历史事实，不能预先写死未来 migration 名称。

所有 schema additive；rollback 关闭 flags 并保留 ledger，不通过 drop table 回滚。

## 14. Feature flags 与默认配置

建议 runtime flags（名字在 Gate A 由 coordinator 审批后冻结）：

```text
CALENDAR_WRITE_ENABLED=false
CALENDAR_PUSH_SYNC_ENABLED=false
TG_MINIAPP_CALENDAR_WRITE_ENABLED=false

HEALTH_CORRECTIONS_ENABLED=false
HEALTH_REFERENCES_ENABLED=false
HEALTH_SUMMARY_ENABLED=false
AGENT_HEALTH_SUMMARY_MODEL_ENABLED=false
AGENT_HEALTH_SUMMARY_DAILY_CALL_LIMIT=24
TG_MINIAPP_HEALTH_CORRECTIONS_ENABLED=false
TG_AMBIENT_HEALTH_CONTEXT_ENABLED=false
```

已有 `CALENDAR_GOOGLE_ENABLED`、`HEALTH_INGEST_ENABLED`、`HEALTH_MINIAPP_ENABLED`、`HEALTH_ENABLED`、
`TG_AMBIENT_CONTEXT_ENABLED` 保持原语义。新增 gate 不能复用旧 flag 偷偷扩大写权限。

## 15. Gate A–F 实施与上线计划

### Gate A：合同、schema 与 owner registry（local only）

- Owner 批准本 Spec；
- coordinator 预约独立实现 worktree、共享文件和 migration 号；
- 新增 types、additive migrations、owner registry keys 和全部 default-false flags；
- synthetic fixtures 覆盖 event / correction / reference / summary；
- migration replay、D1 quick check、foreign key check、secret scan 通过；
- 零 OAuth、Google、Provider、Workers AI、DeepSeek、生产 D1/R2 调用。

**回滚：** 删除未应用的本地 migration/code commit 或关闭 flags；无数据状态。

### Gate B：Health correction + dual baseline（local synthetic）

- append / supersede / undo / source changed after correction；
- raw R2 hash、sample/index/aggregate 在 correction 链中不变；
- 28 日 baseline、missing、unit change、reference applicability；
- Health owner API contract 与 local UI states；
- 不调用模型。

**回滚：** flags off；overlay ledger 保留；effective projection 回到 raw aggregate。

### Gate C：Calendar write contract（mock transport + OAuth test only）

- reauthorization contract、scope verification；
- create/update/move/delete、recurrence instance/series、idempotency、412、unknown outcome；
- watch invalidation + 10 分钟 scheduled reconciliation 使用完全 mock transport；Health 每小时
  deterministic summary check 保持独立；
- TG BFF session/CSRF/Origin 与 owner API contract；
- 未经单独授权不发真实 OAuth、不写真实 Google event。

**回滚：** write/watch flags off；保留只读 scope 和旧 projection。

### Gate D：Mini App UI 与 cache regression（local synthetic）

- Calendar / Health 全状态 UI；
- 本 Spec 第 11 节 viewport、a11y、font、overflow、console 验收；
- committed screenshot baseline + pixel diff；
- ambient v2 2 KiB bound、stable prefix/cache hash/breakpoint byte identity；
- `npm run typecheck`、`verify:calendar`、`verify:health`、`verify:miniapp`、assembler/wire-cache/
  tool continuation 和 full `npm run verify`；
- Worker dry-runs；零 Provider/Google/生产调用。

**回滚：** TG/ambient flags off；旧只读页面和 ambient v1 保留兼容期。

### Gate E：provider-neutral summary canary（单独预算授权）

- 先 deploy schema/flags false，读取 bindings 和 zero-state；
- 以 synthetic facts 验证 deterministic no-change = 0 model；
- Owner 单独批准后，开启 Agent summary model hard gate 和明确 budget；
- 先 1 次 synthetic GLM call，验证 schema、usage、redaction、timeout/fallback；
- 再做一个无 raw 值的 content-free production projection receipt；
- DeepSeek 保持 disabled，除非 Owner 另行批准。

**回滚：** Agent model flag off；Health summary 立即使用 deterministic template，不影响数据投影。

### Gate F：Owner-controlled rollout（每个写面分开批准）

顺序固定：

1. 私有 D1 export / Time Travel、Worker version/binding/flag snapshot；
2. apply additive Calendar/Health migrations；
3. deploy all new flags false；
4. Health references read-only；
5. Health correction 单 metric 单日 canary + undo；
6. Calendar external-browser reauthorization；
7. Calendar 创建一个明确标记的 canary event、更新、删除并核对 Google UI；
8. 开启 watch，保留小时 repair；
9. 开启 Mini App write surfaces；
10. 最后开启 Health volatile context；Owner 发一条自然消息验证 cache-safe context。

每一步都需要 coordinator 记录 deployed version、flag readback、D1/Google/usage receipt 和 rollback point。
Calendar 与 Health 不在同一个批准动作中一起开启。

**回滚顺序：**

1. 先关 TG write / ambient flags，阻止新请求；
2. 关 Calendar write/watch、Health correction/summary model flags；
3. 保留 schema、audit、correction 和 mutation ledger；
4. Calendar credential 可回退到仍有效的只读 generation；必要时 revoke 新 token；
5. Health effective resolver 忽略 overlay，raw 不变；
6. 若需 Worker rollback，先回滚消费者 TG/Agent，再回滚 Calendar/Health owner；
7. 不 drop additive tables，不删除 audit，不盲重放 outcome_unknown。

## 16. 合同与测试矩阵

### 16.1 Calendar

- OAuth scope exact match；readonly -> writable 失败不破坏旧读；
- primary only；secondary/ACL endpoints 不可达；
- create same key/same hash exactly one event；same key/different hash 409；
- get + merge + update 保留未编辑字段；
- stale etag 返回 conflict；remote edit 不丢；
- event create/update/delete 的 before/after unknown transport；
- all-day、timezone、DST、private、cancelled、recurring master/instance；
- watch header/channel/resource/token mismatch 全拒绝；
- notification burst 只产生一次 debounce sync；
- watch 丢失后 10 分钟 scheduled repair 找到变更；
- 410 full resync；projection stale 不冒充“无事件”；
- audit/log/client 不含 token 或事件正文。

### 16.2 Health

- correction 只接受现有 target 和 allowlisted unit；
- source revision stale 409；
- replace、mark missing、annotation、supersede、undo；
- 非 latest correction 不能直接 undo；
- correction 期间 raw object/hash、sample index、daily aggregate 不变；
- ingest after correction 标记 review，不静默覆盖；
- 28 日 baseline 14-day floor、missing、0 denominator、unit/source change；
- reference withdrawn/superseded/applicability mismatch；
- steps/HRV/weight 不发明通用阈值；
- no-change hash = zero model；trigger burst 合并；daily cap/fallback；
- model schema/length/extra number/diagnosis rejection；
- raw/note/value 不进入 model usage logs 或 ambient context。

### 16.3 Context 与 UI

- ambient v2 deterministic ordering / 2 KiB；
- stale owner facts不注入数字或 event title；
- Health/Calendar change 只改变 volatile block；
- stable prefix、client hash、breakpoint count/position 不变；
- 360/390/430/768/844 viewports；200% zoom；keyboard/safe area；
- pending/conflict/unknown/undo 无 toast-only 状态；
- screenshot baselines、font computed value、no overflow、no console error。

## 17. 参考项目与许可证边界

| 来源 | 截至 2026-07-23 可验证状态 | 本项目借鉴 | 不借鉴 / 风险 |
| --- | --- | --- | --- |
| Apple HealthKit 官方文档 | Apple 官方；HealthKit 写入需要 on-device app 和用户授权 | 只用于确认 Apple Health 是设备端健康数据源 | 本 P0 无 iOS app，不声称能回写 HealthKit |
| SparkyFitness | 活跃开发；v0.x；AI、Family & Friends、API docs 标 beta；非商业许可证 | dashboard 信息层级、紧凑趋势、快速记录、移动端/桌面收敛 | 不复制代码/样式/素材，不作为依赖，不据 beta 功能设计权限 |
| Open Wearables | MIT；官方 README 明示 early-stage、API 可能在 1.0 前变化，多项 AI/widget 为 coming soon | 多来源 normalization、source provenance、self-hosted boundary | 不引入其栈，不把 roadmap 当已完成能力 |
| wger | 成熟的自托管运动/营养项目；应用代码 AGPL-3.0-or-later | 运动/体重记录的信息架构、历史报告观念 | 不复制 AGPL 代码/组件，不把营养目标等同医疗参考 |
| HealthNOOP / NOOP | 2026-07-23 仓库/组织请求返回 404，无法验证活跃代码、许可证或维护状态 | 只保留“指标块 + 趋势 + 短摘要”的历史抽象概念 | 从依赖、正式参考和技术选型撤下 |

“参考”不等于“抄代码”。实现 PR 必须能在没有上述仓库依赖、代码或资产的情况下完成。

## 18. 规范来源

### Google Calendar

- OAuth scopes：<https://developers.google.com/workspace/calendar/api/auth>
- Incremental sync：<https://developers.google.com/workspace/calendar/api/guides/sync>
- Push notifications：<https://developers.google.com/workspace/calendar/api/guides/push>
- Resource version / ETag / `If-Match`：
  <https://developers.google.com/workspace/calendar/api/guides/version-resources>
- Events update：<https://developers.google.com/workspace/calendar/api/v3/reference/events/update>
- Events patch：<https://developers.google.com/workspace/calendar/api/v3/reference/events/patch>

### Health 与通用参考

- Apple HealthKit：<https://developer.apple.com/documentation/healthkit>
- CDC sleep reference：<https://www.cdc.gov/sleep/about/index.html>
- American Heart Association resting heart rate：
  <https://www.heart.org/en/healthy-living/exercise-and-physical-activity/fitness-basics/target-heart-rates>
- WHO physical activity guideline：
  <https://www.who.int/europe/publications/i/item/9789240014886>

### 参考项目与模型候选

- SparkyFitness：<https://github.com/CodeWithCJ/SparkyFitness>
- SparkyFitness official README hero：
  <IMAGE_ATTACHMENT_REDACTED>
- Open Wearables：<https://github.com/the-momentum/open-wearables>
- wger：<https://github.com/wger-project/wger>
- Workers AI pricing：<https://developers.cloudflare.com/workers-ai/platform/pricing/>
- DeepSeek pricing / active model names：<https://api-docs.deepseek.com/quick_start/pricing>

实现时必须重新核验外部 API、scope、model 名称、价格和许可证；本节是 2026-07-23 的设计依据，不是
永久锁定的供应商合同。

## 19. 严格未完成与审批点

本 Spec 完成后仍然严格未完成：

1. Owner 尚未批准本设计；
2. 未分配 Calendar/Health/Agent/TG 的实现 lead 与共享文件时序；
3. 未预约任何 migration 号；
4. 未修改 runtime code、Control Registry、types、tests、Mini App、Health page 或 Calendar page；
5. 未创建/应用 migration，未触碰 D1/R2；
6. 未重新授权 Google OAuth，未创建 watch channel，未写任何 Calendar event；
7. 未新增/读取 secret、route、Access policy 或 Provider credential；
8. 未启用 GLM/DeepSeek summary，未触发任何模型或付费调用；
9. 未建立 committed screenshot/pixel-diff baseline；
10. 未部署、未 push、未做 owner canary，生产状态完全不变；
11. 通用 reference registry 仍需在 Gate A 做一次内容/适用性复核并冻结版本；
12. “此项及后续” recurring edit、attendee/invite、conference/attachment 和 secondary calendar
    明确不在 P0；
13. Health raw writeback、医疗诊断、主动提醒和 Memory promotion 明确不在本路线。

Owner 审批时只需确认：

- 是否批准以上四项冻结决定；
- 是否接受 Calendar P0 的 event 字段与 recurrence 边界；
- 是否接受 Health personal baseline `28 日中位数 / 至少 14 complete days`；
- 是否接受 Workers AI GLM 作为首选措辞候选、DeepSeek 默认 disabled；
- 是否允许 coordinator 进入 Gate A 另行分配实现 worktree（仍不代表生产授权）。
