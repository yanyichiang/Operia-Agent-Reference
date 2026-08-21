---
title: Operia Health Auto Export Canonical Mapping and P0 Design
status: accepted-design-baseline
date: 2026-07-18
depends_on:
  - 2026-07-17-operia-miniapp-artifacts-calendar-health-requirements.md
  - 2026-07-17-operia-telegram-mini-app-life-console-design.md
related:
  - 2026-07-16-operia-home-assistant-integration-design.md
scope: Health Auto Export capability boundary, canonical health schema, bounded projections, P0 read-only investigation
---

# Operia Health Auto Export 字段映射与 P0 设计基线

## 1. 决策

Apple Health 数据通过 Health Auto Export 进入独立的 Health canonical owner。Health owner 是原始导出、
规范化样本、聚合指标、同步状态和健康 projection 的唯一所有者；Mini App、Operia、时间线与未来 HA
摘要桥均只是受限消费者，不形成第二真源。

本阶段唯一已确认的入口路径是：

```text
Apple Health / HealthKit
  -> Health Auto Export REST Automation（JSON v2）
  -> owner-only Health Ingest Worker
  -> private raw object store
  -> canonical normalization
  -> hourly / daily aggregates
  -> owner-only read-only projection API
     -> health.example.com
     -> Telegram Mini App
     -> bounded Operia tool
     -> future read-only HA summary bridge
```

Auto Export 当前官方资料没有列出 S3 automation，也没有 NDJSON export。自定义 S3 endpoint、region、
path-style、AWS SigV4 和直接写 R2 均没有已确认支持证据。因此：

- P0 不再把 Auto Export 直写 S3/R2 当推荐或备选实现；
- R2/S3 只出现在受控 ingestion 后端之后；
- 除非后续在当前手机版本 UI 中发现官方资料未覆盖的新能力并用合成数据验证，否则不恢复直写分支；
- canonical raw format 可以由 Worker 内部转存为 JSON/NDJSON，但不能把内部存储格式写成 Auto Export
  原生输出能力。

本文件保存设计基线和 P0 清单，不授权创建凭据、bucket、D1、Worker、Queue、域名、HA 实体、生产
binding 或上传真实健康数据。

## 2. 已确认的 Auto Export 能力边界

截至 2026-07-18，官方文档和 App Store 可确认：

- App Store 当前可见版本为 `9.0.12`；
- REST automation 向任意可达 HTTP/HTTPS URL 发 HTTP POST；
- 支持 JSON、CSV、自定义 HTTP headers、timeout 和手动历史范围导出；
- JSON 支持 Batch Requests；CSV 使用 multipart/form-data、总是聚合且不支持 Batch Requests；
- REST 可配置 Default、Since Last Sync、Today、Yesterday、Previous 7 Days 等窗口；
- 普通 cadence 使用分钟、小时、天或周；官方未公开 N 的完整最小/最大范围；
- 每个 automation 一次选择一种 data type；Health Metrics 与 Workouts 应拆成不同 automation；
- JSON v2 是当前推荐版本；metric 名主要使用 snake_case；
- 时间通常为 `yyyy-MM-dd HH:mm:ss Z`，保留数值 offset；
- 心率、睡眠、血压、workout 等存在特殊结构，不能统一假设为 `qty/date`；
- iOS 后台执行不是精确 cron，锁屏时 HealthKit 不可读，迟到、重传、乱序和窗口重叠均属于正常输入；
- 细粒度、大时间窗、全部指标和 workout GPS 可能形成极大 payload，后台任务通常受约 30 秒预算限制。

官方资料：

- <https://help.healthyapps.dev/en/health-auto-export/automations/>
- <https://help.healthyapps.dev/en/health-auto-export/automations/rest-api/>
- <https://help.healthyapps.dev/en/health-auto-export/export-format/>
- <https://help.healthyapps.dev/en/health-auto-export/export-format/health-metrics/>
- <https://help.healthyapps.dev/en/health-auto-export/export-format/workouts/>
- <https://help.healthyapps.dev/en/health-auto-export/getting-started/supported-data/>

### 2.1 仍需手机现场核对

以下内容不能仅靠网页资料定案：

- 当前手机实际安装版本、iOS 版本和 Premium 状态；
- REST 配置页可选 cadence 数值范围；
- 当前 UI 中可选 data type、window、aggregation、batch size 与 retry 表现；
- `automation-id`、`session-id` 等自动 headers 在重试和手工导出时是否稳定；
- v2 实际 source metadata、上游记录 ID 和 aggregation 后来源字段是否保留；
- 同一窗口手动重跑、失败重试和 Since Last Sync 的边界；
- payload 压缩、最大批次、错误响应后的 retry/backoff 行为；
- 当前 UI 是否出现尚未进入官方文档的 S3 选项；若没有则记录为 `unsupported_observed`。

现场核对只能抄录配置项或使用合成数据；不得输入生产 URL、token 或真实健康 payload。

## 3. 数据层与所有权

| 层 | 权威内容 | 推荐存储 | 禁止事项 |
|---|---|---|---|
| Raw | 原始请求体、接收 headers 的安全子集、payload hash | private R2/S3 object | public bucket、custom domain、日志正文 |
| Ingest ledger | batch、状态、游标、hash、object ref、计数、审计 | Health D1 | 保存大 payload 或逐条 raw |
| Canonical samples | 规范化样本、source、时间、单位、raw ref | P1 决定；D1 仅在体量证据允许时 | 写入 Memory、TG D1、HA Recorder |
| Aggregates | 小时/日聚合、coverage、freshness、rule version | Health D1/DO projection | 用 0 表示未同步 |
| Projection | 今日、7/30 天趋势、来源、freshness、missing reason | Health Worker API | 暴露 raw object key、逐条样本、token |
| Timeline | bounded event 与 Health locator | timeline owner | 复制 raw 或完整 projection 到 Memory |

Health 与 Memory、Calendar、HA、Telegram 分域。Operia Memory 只能保存显式 pin 的安全引用和 snapshot，
不能保存 raw sample、完整健康序列或 ingestion credential。

## 4. Canonical schema

### 4.1 Batch envelope

```ts
type HealthCanonicalBatch = {
  schemaVersion: "health.canonical.v1";
  batchId: string;                 // canonical content hash
  ownerId: string;                 // opaque internal id
  sourceSystem: "apple_health";
  exporter: {
    name: "health_auto_export";
    version: string | null;         // unknown means null, never guessed
    automationIdHash?: string;
  };
  exportFormat: "json" | "csv";
  exportVersion: "v1" | "v2" | "unknown";
  dataType: string;
  exportedAt: string | null;
  receivedAt: string;
  sourceTimezone: string | null;
  window: { start: string; end: string }; // half-open [start, end)
  payloadSha256: string;
  canonicalSha256: string;
  sampleCount: number;
  synthetic: boolean;
  status: "received" | "validated" | "quarantined" | "normalized" | "deleted";
};
```

约束：

- `ownerId` 不使用姓名、Telegram ID、邮箱、设备名或其他可识别值；
- `receivedAt`、`exportedAt`、测量时间不可互相替代；
- `payloadSha256` 对 raw bytes 计算；`canonicalSha256` 对稳定排序、规范化后的语义内容计算；
- `window.end` 使用半开区间；
- headers 只允许保存 `automation-id/session-id` 的 hash 和必要的非敏感版本字段；
- bearer、Cookie、完整 HMAC、raw URL query 与未经审查的 header 不入 D1、日志或审计。

### 4.2 Metric sample

```ts
type HealthMetricSample = {
  sampleId: string;
  batchId: string;
  ownerId: string;
  metric: string;
  value: number | string | null;
  unit: string | null;
  originalUnit: string | null;
  startAt: string;
  endAt: string;
  utcStartAt: string;
  utcEndAt: string;
  timezone: string | null;
  source: {
    platform: "apple_health";
    label: "watch" | "phone" | "app" | "manual" | "multiple" | "unknown";
    sourceNamePrivate?: string;
    sourceIdHash?: string;
  };
  quality: {
    status: "observed" | "derived" | "invalid";
    isUserEntered: boolean | null;
    isAggregatedUpstream: boolean;
  };
  rawRef: { objectKey: string; recordIndex: number };
};
```

约束：

- 无样本不创建 `value=0` 的伪记录；真实的 0 必须保留为 observed value；
- 瞬时测量允许 `startAt=endAt`；持续事件必须保留起止；
- 原单位先进入 allowlist 和转换审计，再写 canonical unit；
- `sourceNamePrivate` 只留在 Health owner 私有层，对外 projection 使用粗粒度 label；
- 非法时间、未知单位、超范围值和缺关键字段进入 quarantine，不静默猜测。

### 4.3 Aggregate

```ts
type HealthAggregate = {
  aggregateId: string;
  ownerId: string;
  metric: string;
  localDate: string;
  timezone: string;
  windowStart: string;
  windowEnd: string;
  value: number | string | null;
  unit: string | null;
  aggregation: string;
  sampleCount: number;
  sourceLabels: string[];
  coverage: {
    status: "complete" | "partial" | "not_synced" | "unavailable" | "unsupported";
    observedStart?: string;
    observedEnd?: string;
    reason?: string;
  };
  freshness: {
    lastSourceAt: string | null;
    lastSyncedAt: string | null;
  };
  ruleVersion: string;
};
```

`aggregateId` 由 owner、metric、local window、rule version 生成。算法升级时新旧 rule version 可并存
比较；projection 只暴露被激活的规则版本。

## 5. 首批字段映射

Auto Export 原始路径在获得当前 v2 合成导出前均标为 `expected/unverified`；下面是 canonical 目标，不是
对供应端字段稳定性的承诺。

| Auto Export expected metric | Canonical metric | 单位 | 日聚合 | 规则 |
|---|---|---:|---|---|
| `step_count` | `activity.steps` | `count` | 去重后求和 | 多来源不可直接相加 |
| `active_energy` | `activity.active_energy` | `kcal` | 去重后求和 | `kJ` 先换算 |
| `apple_exercise_time` | `activity.exercise_duration` | `min` | 区间并集或可信上游总量 | 防 workout 重叠 |
| `apple_stand_time` / `apple_stand_hour` | `activity.stand_duration` | `min` | 待现场定案 | 先确认分钟、小时或事件语义 |
| `sleep_analysis.totalSleep` | `sleep.total_duration` | `min` | 有效睡眠区间并集 | 不把 in-bed 当 asleep |
| `sleep_analysis.inBed` | `sleep.in_bed_duration` | `min` | 区间并集 | 与睡眠总时长分开 |
| `sleep_analysis.sleepStart` | `sleep.onset_at` | timestamp | 主睡眠 session 起点 | 跨日按 session 结束日归属 |
| `sleep_analysis.sleepEnd` | `sleep.wake_at` | timestamp | 主睡眠 session 终点 | 不用 0 表缺失 |
| `sleep_analysis.core` | `sleep.stage.core` | `min` | 区间并集 | 不擅自改名“浅睡” |
| `sleep_analysis.deep` | `sleep.stage.deep` | `min` | 区间并集 | 仅来源提供时展示 |
| `sleep_analysis.rem` | `sleep.stage.rem` | `min` | 区间并集 | 仅来源提供时展示 |
| `sleep_analysis` segment `Awake` | `sleep.stage.awake` | `min` | 区间并集 | aggregated/unaggregated 分开 mapper |
| `resting_heart_rate` | `cardio.resting_heart_rate` | `bpm` | 上游定义值；多条时中位数 | 不从全天心率自行推导 |
| `heart_rate.Min` | `cardio.heart_rate.min` | `bpm` | min | 必须附覆盖与样本数 |
| `heart_rate.Avg` | `cardio.heart_rate.avg` | `bpm` | 待时间权重核验 | 不默认算术平均 |
| `heart_rate.Max` | `cardio.heart_rate.max` | `bpm` | max | 不等于医学异常 |
| `heart_rate_variability` | `cardio.hrv_sdnn` | `ms` | 中位数 | P0 核实确为 SDNN |
| `walking_heart_rate_average` | `cardio.walking_heart_rate_average` | `bpm` | 上游定义值 | 不自行重建 |
| `weight_&_body_mass` | `body.weight` | `kg` | 当日最后有效值 | `lb` 先换算，保留 source time |

首版 projection 上限：

- 今日：步数、活动能量、运动分钟、睡眠总时长、静息心率、HRV、体重；
- 7/30 天：相同指标的日序列与简单变化率；
- 状态：来源标签、最后源时间、最后同步时间、coverage 和 missing reason；
- 心率范围可以展示，但必须同时显示覆盖窗口和 sample count；
- ECG、用药、经期、情绪、症状、GPS route、血糖和血压默认不进入首批 projection。

## 6. 幂等、重叠与重算

三层去重键：

1. `payloadSha256`：完全相同 raw bytes 的快速拒绝键；
2. `batchId/canonicalSha256`：忽略 JSON key order 等表现差异后的语义批次键；
3. `sampleId`：由 owner、metric、规范化时间、值、单位、稳定 source id 和可用的 upstream id 生成。

规则：

- 同一窗口重跑和相邻窗口重叠是正常情况；
- ingestion 使用 upsert/provenance link，不能按“本批增量值”累加 aggregate；
- aggregate 总是从唯一 canonical sample 集合重算；
- batch 与 sample 使用多对多 provenance；删除一个 batch 不删除仍被其他 batch 引用的 sample；
- 上游 ID 只有在合成重跑证明稳定后才作为主要身份字段；
- retry、replay、delete、recompute 均写安全审计事件，但不写 raw payload。

## 7. 时间与时区

- 保存原始带 offset 时间、解析后的 UTC instant 和 IANA timezone；
- owner 默认展示时区是 `<YOUR_TIMEZONE>`，日窗口为本地 `[00:00, next 00:00)`；
- 主睡眠 session 默认归属到结束所在的本地日期，并保留完整起止；
- 旅行历史不能用当前上海时区反向改写原始 instant；
- 无 offset 且无可验证 timezone 的记录进入 quarantine；
- 同一 instant 的不同 offset 表达应判为同一时刻。

P0 最低测试矩阵：

- 上海 `23:59:59` / `00:00:00` 半开区间；
- UTC 日期与上海日期不同；
- 跨午夜睡眠；
- DST spring-forward 不存在时刻；
- DST fall-back 重复本地时刻，使用 offset 区分；
- export timezone 与 sample offset 不一致；
- 非法时间、缺 offset、未知 timezone；
- 同一 instant 不同 offset 的 sample identity。

## 8. Bounded projection 与时间线

```ts
type HealthSummaryProjection = {
  projectionVersion: "health.summary.v1";
  ownerId: string;
  window: { start: string; end: string; timezone: string };
  metrics: Array<{
    metric: string;
    value: number | string | null;
    unit: string | null;
    coverage: HealthAggregate["coverage"];
    sourceLabels: string[];
    lastSourceAt: string | null;
    lastSyncedAt: string | null;
  }>;
  generatedAt: string;
};
```

- `health.example.com` 与 Mini App 必须从同一个 projection API、同一 window 和 rule version 读取；
- Operia 只允许查询今日、本周、7/30 天趋势、异常候选和最后同步时间；
- “异常候选”只代表规则命中，不代表诊断；回答固定标注为健康信息而非医疗建议；
- raw sample 不进入 prompt、stable prefix、普通 audit 或长期 Memory；
- 未经明确 opt-in，Heartbeat 不读取健康 projection、不发消息、不产生模型调用；
- Health timeline 只贡献 bounded event，例如睡眠摘要、周趋势和 stale event；
- pin 保存 `source + eventId + timestamp + safe snapshot + owner locator`，不复制 raw 数据。

## 9. P0 只读实施清单

### 9.1 手机能力盘点

- [ ] 记录 App 版本、iOS 版本、Premium 状态，不截图或记录 Apple ID；
- [ ] 抄录 REST automation 的 URL/method/headers/timeout/data type/window/cadence/aggregation/batch 配置；
- [ ] 核实 cadence 的具体数值范围；
- [ ] 核实 JSON v2、CSV 与 batch 的组合限制；
- [ ] 核实 automatic headers 及 retry/session 行为；
- [ ] 核实 Since Last Sync 的成功游标语义；
- [ ] 只读确认 UI 是否存在 S3；没有则记录 `unsupported_observed`；
- [ ] 明确 NDJSON、ZIP、compression 是否存在；没有证据则保持 `unsupported/unverified`；
- [ ] 核实 HA 原生 automation 的实体、单位、state/attributes 和更新方式，只将其定位为摘要消费者。

### 9.2 合成 fixture

- [ ] 每个首批指标至少两条 synthetic record；
- [ ] 真实 `0` 与 `null/not_synced`；
- [ ] 同一指标 watch/phone/app 多来源重叠；
- [ ] 同批重放、排序变化重放、相邻窗口重叠；
- [ ] aggregated 与 unaggregated sleep；
- [ ] 跨午夜主睡眠；
- [ ] `kJ -> kcal`、`lb -> kg`；
- [ ] UTC、上海和 DST 边界；
- [ ] user-entered、缺 source、非法单位、非法时间、超范围值；
- [ ] fixture 标明 `synthetic: true`，与未来真实环境和 prefix 完全隔离。

### 9.3 字段盘点表

每个字段至少记录：

```text
raw JSON path
raw example type
canonical metric
original unit
canonical unit
timestamp semantics
source fields
nullable
identity fields
aggregation rule
sensitivity
verification status
open questions
```

未知字段统一为 `unverified`，不得按字段名脑补。

### 9.4 本地 validator 设计

P0 可以新增不联网、不接生产的本地 validator/fixtures，但必须另行获得当前窗口实施确认后才写代码。
validator 最小能力：

- JSON Schema；
- timestamp/offset/IANA timezone 校验；
- metric 与 unit allowlist、转换表；
- payload size、record count、时间范围统计；
- payload/canonical/sample hash；
- source/设备标识发现报告；
- quarantine reason；
- 只输出 batch id、计数、状态、耗时的安全日志；
- synthetic import、aggregate、delete、recompute dry-run。

## 10. P0 验收证据

- 当前 App 配置字段清单，明确 REST 与 S3/NDJSON 的真实边界；
- 至少一份不含真实健康数据的 v2 synthetic fixture；
- raw-to-canonical mapping table，所有未知项显式标记；
- schema、metric allowlist、unit allowlist 和 conversion table；
- 同一批次导入两次后 sample count 与 aggregate 不变；
- 重叠批次不重复；
- 上海跨日、睡眠跨午夜、DST spring/fall tests 通过；
- `0/null/not_synced/unavailable/unsupported` 在 projection 中可区分；
- synthetic batch 可 validate、quarantine、delete、recompute；
- 日志 fixture 不含 token、raw payload、逐条健康样本或私有 source name；
- domain 与 Mini App 在相同 window/rule version 下数值一致；
- Operia bounded projection 无 raw object ref、逐条样本、token 和高敏指标；
- 未 opt-in 时不发健康消息、不调用模型、不触发 HA；
- P1 所需凭据、bucket、Worker、D1、Queue、域名和首日真实数据仍全部列为 owner approval gate。

## 11. 已有轮子的定位

- Health Auto Export 原生 Home Assistant automation：可作为少量日级摘要实体桥和 HA UI/自动化消费者，
  不能作为 Health raw/canonical 真源；本项目禁止 Health 数据自动触发 HA 设备控制。
- `HealthyApps/health-auto-export-server`：可参考其 REST -> MongoDB -> Grafana 流程和 metrics/workouts
  拆分方式，但其 schema 不是本项目 canonical contract。
- MQTT：可作为未来低关键度 projection transport；在 QoS、retain、replay 和事实库边界未验证前，不作
  ingestion 真源。

## 12. 下一阶段审批门

本基线完成后仍不得自动进入 P1。以下任一动作都需要 Owner 在执行窗口明确确认：

- 创建或写入 token、HMAC key、bucket、D1、Queue、Worker secret；
- 注册或修改 `health.example.com`、Cloudflare Access、route 或 Service Binding；
- 配置手机 Auto Export production automation；
- 上传任何真实健康数据；
- 修改 HA、Operia、Memory、Telegram Mini App 或 Cloudflare 生产配置；
- 让 Heartbeat 主动读取、推送或解释健康数据；
- 启用任何模型费用、提醒或 Health -> HA 自动化。

## 13. 2026-07-18 Owner 授权后的实现合同

Owner 已在当前窗口明确授权“先写 spec，再完成上传与读取管线”，但说明到家后才提供 Cloudflare 登录。
因此本轮的执行边界固定为：可以写代码、schema、合成 fixture、Mini App/Agent 消费端与本地验收；不得登录
Cloudflare、创建远端资源、写入 secret、启用生产 feature flag、修改 DNS/Access、上传真实健康数据或部署生产。

### 13.1 Worker 与入口

- Worker：`<HEALTH_SERVICE>`，canonical owner 由 Worker 内部 `HEALTH_OWNER_KEY` 映射，消费者不各自创建第二 owner；
- 上传：`POST /ingest/health-auto-export/v2`；
- 上传认证：静态高熵 `HEALTH_INGEST_BEARER`。Auto Export 不能被假定会动态生成 HMAC、timestamp 或 nonce；
- 可选采集 `Automation-Id` / `Session-Id`，只保存 hash；原文 SHA-256 是批次幂等键；
- 请求体上限 5 MiB，首版支持样本上限 5,000；超限 fail-closed；
- raw 原文只写私有 `HEALTH_RAW` R2，D1 保存 batch ledger、最小 canonical sample index、聚合与安全 audit；
- 同一 payload 重放返回原 batch，不重复聚合；已删除 batch 可以重新导入并重算。

### 13.2 读取合同

- TGBot：`GET /service/health/projection?range=7|30&group=...`，独立 TG service bearer；
- Agent/Opus：`POST /service/health/tool/query?range=7|30&group=...`，独立 Agent service bearer；
- 域名面板：`GET /api/health/projection?range=7|30|90`，必须通过 operia 应用 session；
- Admin 删除：`DELETE /service/health/batches/:batchId`，仅独立 admin service bearer；
- 所有 projection 固定包含 source、lastSyncedAt、lastSourceAt、freshness、missingData、null gap 与
  `informational_not_medical_diagnosis`；不返回 raw object key 或逐条原始样本。

### 13.3 Feature flags 与上线门

- `wrangler.health.jsonc` 默认 `HEALTH_INGEST_ENABLED=false`；
- `wrangler.tgbot.toml` 默认 `HEALTH_MINIAPP_ENABLED=false`；
- `wrangler.agent.toml` 默认 `HEALTH_ENABLED=false`；
- 到家后的生产步骤必须按顺序完成 D1/R2/Worker、独立 secrets、Health Worker canary、合成 batch、
  Mini App canary、Agent tool canary，最后才允许一天真实数据；任何阶段失败都保持下游 flag 为 false。

## 14. 2026-07-18 生产激活补充：Owner session 不轮换

Owner 到家后已确认本机 Wrangler 登录正确账号，并按既有授权创建独立 D1 `operia_health`、私有 R2
`<HEALTH_RAW_BUCKET>`，写入 D1 binding id 并成功应用 `0001_health_owner.sql`。此时发现 Cloudflare Secret 不可回读，
本机也不存在 `OPERIA_SESSION_SECRET` 的安全副本。为避免轮换 Memory、Agent、TG、MCP 的共享 session
secret 并使全部面板掉登录态，生产读取认证改为以下最小内部合同：

- Health Worker 通过私有 `MEMORY_SESSION_SERVICE` Service Binding 调用
  `<MEMORY_SERVICE>.internal/service/domain-session/verify`；
- 请求只转发 `operia_session` cookie，并附专用 `HEALTH_SESSION_VERIFY_BEARER`、固定 source domain 和
  service id；不转发 health payload、projection、浏览器其余 headers 或 raw 数据；
- Memory 使用现有 `OPERIA_SESSION_SECRET` 完成 owner/session 校验，只返回 `{ ok: true|false }`，不返回
  email、profile、session 内容或 Memory 数据；
- 该 path 仅接受内部 hostname、POST、固定身份 headers 与 timing-safe bearer 校验；失败一律 fail-closed；
- Health Worker 不保存或接收共享 session secret。此认证依赖不改变 Health 数据域、Memory 长期记忆边界或
  Mini App/Agent 的 bounded projection 合同。
