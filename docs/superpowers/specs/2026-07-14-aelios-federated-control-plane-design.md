---
date: 2026-07-14
status: accepted
scope: example.com control planes, Agent, Memory, MCP, Telegram, Operia, Xiaozhi, Ops, future channels and CLI
accepted_at: 2026-07-14
---

# Operia 全域控制面分流与唯一真源设计

## 1. 决策

`example.com` 下的每个产品域名是同一套 Operia 系统的职责视图，不是彼此隔离的配置
孤岛。控制面采用 federated single source of truth：每一种事实只有一个权威 owner，其他域名
通过 Service Binding、受保护的内部 API、显式 override 和语义深链接消费该事实。

统一真源不等于建立一个保存全部状态的超级数据库。Memory、MCP、Agent、Channel 与 Ops
继续拥有符合各自生命周期的数据；统一的是 key、owner、作用域、覆盖顺序、事件关联和修改
协议。

### 2026-07-16 MCP 消费端合流补充

- `mcp.example.com` 继续独占 Provider 注册、工具启停与 owner revision。
- Agent、Telegram 和后续前端可以展示并修改 MCP 状态，但 mutation 必须经 Service Binding
  代理回 MCP owner，并携带 `If-Match`；消费端不得保存第二套开关。
- Gateway owner 中启用且可观测的工具默认进入 Agent 的 Gateway-owned executable projection；
  Agent 继续负责风险、审批、幂等、预算和结果清洗，不再用环境变量复制 Gateway allowlist。
- 各消费端向 Gateway 上报已观察的 owner revision 与状态；MCP 面板据此显示前端投影是否一致。
- Telegram 固定顶层命令只保留 `/mcp` 与 `/skills`，动态 Provider、Tool 和 Skill 使用消息内的
  层级子命令，不复制到 BotFather 固定命令目录。自然语言调用继续使用同一 Agent catalog。
- `/mcp` 的 Telegram 交互入口固定分为“内置工具”和“外置 MCP”：内置工具只深链或调用其
  canonical owner；外置目录每次经 Agent Service Binding 读取 MCP owner 当前 projection，包含
  暂不可执行的 Provider/Tool 状态，不在 TG D1 保存目录副本。按钮仅携带固定长度 catalog
  locator，点击时必须对当前目录重新解析；目录变化或 locator 冲突均 fail-closed。
- 外置工具参数优先由 JSON Schema 驱动点选。无参数工具可一键进入既有 read-only 执行链；
  enum/boolean 参数逐项选择；自然语言或复杂结构参数交给 Opus 根据当前对话和 schema 组装，
  不要求用户手写字段名或 `key=value`。所有实际调用仍经过 Agent policy、幂等、审批和 handoff。

本 spec 是后续控制面、CLI、渠道和 Provider 调整的架构约束。新功能必须先确定事实归属，
再决定页面、存储和 API。不能先在当前页面加一个开关，再事后补同步逻辑。

## 2. 目标

1. Agent 控制面只管理渠道无关的 Agent 能力、Provider、执行、预算、审批和审计。
2. Telegram 控制面只管理 Telegram 独有行为，以及 Agent 通用能力在 Telegram 的显式覆盖。
3. Memory、MCP、Operia、Xiaozhi、Ops 和未来 HA/CLI 均遵循同一 owner 与 override 规则。
4. 每个控制面都能显示参数的当前生效值、来源、owner 和精确跳转入口。
5. 每次请求和配置变更都能通过统一 ID 在相关控制面之间双向定位。
6. 任何域名都不能复制另一个域名已经拥有的配置或业务逻辑。
7. 增加新渠道或 CLI 时只新增视图与 adapter，不创建第二套模型、Voice、MCP、记忆或审批配置。

## 3. 非目标

- 不把所有数据迁入 Agent Durable Object 或单一 D1。
- 不让控制台成为绕过应用 bearer、owner scope、审批或工具 allowlist 的超级入口。
- 不在跨域 URL、manifest、审计事件或前端状态中传递 secret、Cookie、原始 prompt 或正文。
- 不让 TG、Operia、Xiaozhi 或 CLI 自行维护 Provider 凭据和通用模型目录。
- 不在本阶段发布独立 CLI 项目；CLI 只作为后续消费同一 control contract 的客户端。
- 不为视觉统一强行共用一个前端 bundle；先统一契约、组件语义和导航，再决定代码复用粒度。

## 4. 第一性原则

### 4.1 一个事实，一个 owner

每个可配置或可观测事实必须有唯一 `ownerDomain`。owner 负责：

- schema 与默认值；
- 权威存储；
- 校验、版本和迁移；
- override 能否存在及其允许作用域；
- effective value 计算；
- mutation 审计和敏感字段处理。

消费者不得把读取到的值持久化为自己的“同步副本”。短期缓存必须带 owner version、TTL 和
失效协议，且不得成为写入真源。

### 4.2 域名是职责视图

一个页面是否展示某参数由使用场景决定，一个页面是否拥有某参数由 owner registry 决定。
TG 可以展示正在使用的音色，但音色 profile 的 owner 仍是 Agent Voice；TG 只拥有“何时发
语音”和“发成 voice note 还是 audio”等渠道行为。

### 4.3 覆盖只能显式且可撤销

通用参数的渠道、聊天和一次性覆盖由参数 owner 保存，不由渠道复制。每个 override 必须带：

- 作用域；
- 创建者与来源域名；
- 创建时间和可选过期时间；
- 被覆盖的 canonical key；
- 审计事件；
- `reset to inherited` 语义。

### 4.4 偏好可替换，权限只能收紧

普通枚举、展示和音色等偏好可以在 owner 声明的 envelope 内替换；权限、allowlist、危险能力
和 hard budget 必须保持单调收紧。渠道不能绕过审批、扩大权限或超过最终资源 owner 的 hard
limit。每个 key 必须声明 resolution strategy，不能用一条“全部取交集”的规则处理任意值。

### 4.5 链接共享身份，不共享秘密

控制面使用现有 `.example.com` 应用会话和 Cloudflare Access 完成浏览器身份联通。域间
深链接只携带不敏感的 locator；服务间数据读取使用 Service Binding 和独立应用 bearer。

## 5. 域名 Owner Registry

| 域名 | 权威拥有 | 可以消费但不能复制 |
|---|---|---|
| `memory.example.com` | 长期记忆、identity、persona、召回与保留；主对话 inference model、transport、prompt cache 和模型 reasoning 执行 | Agent planner、渠道展示与工具状态 |
| `mcp.example.com` | MCP Gateway Provider 注册、authoritative catalog、客户端暴露、Provider auth reference | Agent policy、渠道命令映射 |
| `agent.example.com` | Tool planner、媒体/工具 Provider runtime、工具 execution policy/risk/cache/delegated allowlist、任务与工具审批、Context Capsule 引用生命周期、Browser、Skills、Hooks、Heartbeat、聚合 usage/audit | Memory inference/正文、MCP Gateway 注册真源、渠道 delivery 设置 |
| `tgbot.example.com` | Telegram webhook、owner/chat binding、消息合并、命令、短期渠道会话、展示、投递、TG outbox 与渠道事件 | Agent Provider 参数、MCP registry、Memory 正文 |
| `operia.example.com` | Operia 客户端布局、展示和渠道偏好 | Agent 模型/工具、Memory、MCP |
| `xiaozhi.example.com` | 设备注册、设备能力、设备渠道表现与本地音频行为 | Agent Voice/Tools、Memory、HA policy |
| `ops.example.com` | 部署、路由、健康、版本、基础设施事实和 control-plane topology/index | 业务配置，只提供状态、manifest 聚合和深链接 |
| future HA / CLI | 渠道或客户端自身的 transport、presentation 与 local preference | 所有通用能力均引用现有 owner |

新增域名必须在 registry 中声明 owner 范围。没有 owner 的参数不得上线；有两个 owner 的参数
必须先收敛后才能修改 UI。Ops 拥有 control-plane topology/index 和唯一 `registryVersion`；
各业务域仍分别拥有自己的参数 definitions 与 manifest，Ops 不因此获得业务 mutation 权限。

## 6. 参数模型

### 6.1 Canonical definition

```ts
type ControlParameterDefinition = {
  key: string;
  schemaVersion: number;
  ownerDomain: string;
  category: string;
  label: string;
  description: string;
  valueSchema: JsonSchema;
  defaultValue?: unknown;
  allowedScopes: Array<"global" | "channel" | "chat" | "next_turn" | "device">;
  resolutionStrategy: "replace_within_envelope" | "numeric_min" | "numeric_max" | "set_intersection" | "deny_only";
  policyEnvelope?: JsonSchema;
  hardLimit?: number | string[] | boolean;
  sensitivity: "public_status" | "private" | "secret_reference";
  mutableFrom: string[];
  routeTemplateId: string;
  auditClass: "read" | "preference" | "policy" | "credential" | "dangerous";
  legacyLocations?: string[];
};

type ControlValue = {
  key: string;
  value: unknown;
  revision: number;
  ownerVersion: string;
  updatedAt: string;
  actor: { type: "user" | "service" | "migration"; id: string };
};

type ControlScopeRef =
  | { type: "channel"; channel: string }
  | { type: "chat"; channel: string; chatId: string }
  | { type: "device"; channel: string; deviceId: string }
  | { type: "next_turn"; channel: string; recipientType: "chat" | "device"; recipientId: string };

type ControlOverride = {
  id: string;
  key: string;
  scopeRef: ControlScopeRef;
  value: unknown;
  revision: number;
  ownerVersion: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  idempotencyKey: string;
  actor: { type: "user" | "service"; id: string; sourceDomain: string };
};

type NextTurnClaim = {
  requestId: string;
  ownerDomain: string;
  scopeRef: Extract<ControlScopeRef, { type: "next_turn" }>;
  overrideIds: string[];
  claimedAt: string;
  effectiveSnapshotHash: string;
  effectiveSnapshot: Record<string, unknown>;
};
```

`secret_reference` 只允许返回“已配置/未配置”和不敏感引用名，API 永远不返回 secret value。

### 6.2 Effective value

通用参数先按 scope 优先级收集候选值，再使用 definition 声明的 `resolutionStrategy` 求值：

```text
owner global default
  -> channel override
  -> chat/device override
  -> atomic next-turn override
  -> resolutionStrategy
  -> owner hard limit and policy
  = effective value
```

`replace_within_envelope` 用于显示偏好、普通枚举、模型和音色；预算通常用 `numeric_min`；
allowlist 用 `set_intersection`；安全开关用 `deny_only`。参数不得依靠调用方猜测合并算法。
owner hard limit 和安全 policy 始终最后执行，不能被任一 override 替换。

Browser 域名范围的 canonical key 为 `agent.browser.domain_allowlist`，owner 为
`agent.example.com`。其权威值和 revision 存在 Agent Durable Object；
`wrangler.agent.toml:BROWSER_DOMAIN_ALLOWLIST` 仅作为首次迁移 seed 与旧版回滚参考，不能成为
第二真源。编辑入口固定为 `/tools/browser`，全域控制页只读取同一 owner projection。

返回值必须同时给出来源：

```json
{
  "key": "memory.inference.reasoning.effort",
  "effectiveValue": "medium",
  "effectiveSource": "channel:telegram",
  "ownerDomain": "memory.example.com",
  "ownerVersion": "memory-control-12",
  "revision": 4,
  "globalValue": "low",
  "overrideValue": "medium",
  "allowedValues": ["off", "low", "medium", "high"],
  "canOverride": true,
  "canReset": true,
  "deepLink": "https://agent.example.com/models/reasoning?focus=reasoning.effort"
}
```

UI 不得只显示裸值。用户必须能看到它来自全局、渠道、聊天、设备还是下一轮。

### 6.3 Next-turn consumption

`ControlScopeRef` 是严格 discriminated union。Chat/device/next-turn 缺少 channel、recipient
type 或 ID 时必须 fail-closed，不能只依赖一个可能跨渠道碰撞的裸 ID。

一次性覆盖必须由 canonical owner 在创建任务时以 compare-and-swap 一次 claim 该 owner 对
`request_id + channel + recipient` 的全部匹配 next-turn overrides，并保存单一
`effectiveSnapshot` 与 hash；API 不按单个 key claim。渠道不得先删除本地 flag 再调用 owner。

跨 owner 时由 Agent request coordinator 执行幂等 saga：使用同一 request ID 向每个相关 owner
prepare claim；所有 owner 都返回固定快照后才提交 aggregate snapshot 并启动任务。部分成功的
claim 只保留给同一 request ID，不能被其它请求消费；重试必须返回原快照。任务尚未启动且最终
放弃时，协调器才可用同一 idempotency key 显式 release prepared claims。

### 6.4 目标 Owner 与当前物理位置

第 5 节声明的是迁移完成后的 canonical owner，不声称当前生产已经满足该状态。P0 inventory
必须为每个 key 记录现有物理位置和目标 owner，例如：

- 主对话 `CHAT_MODEL` 当前位于 Memory/TG Wrangler 配置；目标 canonical namespace 为
  `memory.inference.*`，Memory Worker 继续拥有实际 Opus 调用、transport、prompt cache 和
  模型 reasoning 执行。Agent Models & Reasoning 页面是通用聚合视图，不成为第二 owner；
- TG `reasoning_mode` 当前位于 TG settings；其中 summary/debug 展示归 TG presentation，
  模型 reasoning capability/default/hard limit 归 `memory.inference.reasoning.*`；
- Agent DO 当前存在 runtime-local `mcp_registry`，必须区分 MCP Gateway authoritative
  registration 与 Agent executable projection/allowlist，不能直接删除或把两者继续都叫 registry；
- TG voice policy/model 当前位于 `tg_chat_config`，其中发送行为归 TG，Voice profile 与
  Provider 参数归 Agent，迁移时必须拆 key 而不是整列搬家。

迁移完成前，`legacyLocations` 用于发现和比较旧读路径；它不授予旧位置继续写入的永久权利。

## 7. Control Manifest

每个控制面提供版本化 manifest。浏览器入口需要应用会话，服务入口通过 Service Binding；
manifest 不包含 secret 或用户数据。

```ts
type ControlManifest = {
  manifestVersion: 1;
  registryVersion: string;
  domain: string;
  title: string;
  owns: string[];
  consumes: Array<{ ownerDomain: string; keys: string[] }>;
  sections: Array<{ id: string; title: string; routeTemplateId: string }>;
  capabilities: Array<{ key: string; status: "ready" | "disabled" | "degraded" }>;
  schemaVersions: Record<string, number>;
  generatedAt: string;
};
```

建议入口：

- 浏览器：`GET /api/control/manifest`
- Service Binding：`GET /service/control/manifest`

全域导航、Control Pages 右栏、CLI discovery 和链接完整性测试都从 manifest 生成，不再在每个
页面手写另一份域名列表。

Ops 提供唯一 topology/index 聚合入口；P0 可以先由仓库中的版本化静态 registry 构建，随后由
Ops 暴露受保护的聚合 API。聚合失败时各域自己的 manifest 仍可用，但不得回退到另一份手写
全域列表。

## 8. Control API 与 Service Binding

### 8.1 Owner API

每个 owner 提供相同语义的受保护接口：

- `GET /service/control/definitions`
- `GET /service/control/values`
- `POST /service/control/effective`
- `PUT /service/control/values/:key`
- `PUT /service/control/overrides/:key`
- `DELETE /service/control/overrides/:key`
- `POST /service/control/next-turn/claim`
- `GET /service/control/events`

具体路由可以按 Worker 约束调整，但 request/response contract 必须共享类型与合同测试。

### 8.2 Mutation 规则

- 浏览器 mutation：应用会话、精确 Origin、CSRF、owner 身份。
- Worker mutation：Service Binding、独立 bearer、service ID、owner ID、scope。
- preference mutation 也必须审计；credential 与 dangerous mutation 继续使用更高门禁。
- `mutableFrom` 只决定谁可以请求，owner 仍重新校验 scope、值和 hard limit。
- global value 与 override 的 PUT/DELETE 必须携带 `If-Match` revision；冲突返回 409，不允许
  last-write-wins 静默覆盖。创建操作还要求 idempotency key。
- 不使用公开 workers.dev 回环作为控制面同步机制。

### 8.3 Read model

控制面可以建立只读聚合 projection，但 projection 必须标记：

- `ownerDomain`
- `sourceVersion`
- `observedAt`
- `staleAfter`
- `effectiveSource`

projection 不能接受 mutation，也不能在 owner 不可达时伪装为当前值。

## 9. 双向导航与语义深链接

全域右栏只负责顶层入口；上下文跳转必须定位到具体对象。Registry 保存
`routeTemplateId`，不保存任意 URL；服务端使用精确 HTTPS hostname allowlist 和模板生成链接。

允许的 locator：

- `config_key`
- `run_id`
- `task_id`
- `approval_id`
- `message_id`
- `provider_id`
- `tool_key`
- `session_id`

示例：

```text
TG Voice 生效音色
  -> agent.example.com/tools/voice?focus=voice.profile&channel=telegram

Agent Channel 状态
  -> tgbot.example.com/admin#delivery?focus=run_id

TG delivery event
  -> agent.example.com/runs/:run_id

Agent MCP tool
  -> mcp.example.com/providers/:provider_id/tools/:tool_name
```

URL 不得携带 prompt、memory、tool result、chat text、Cookie、token、provider key 或 Live View
secret。生成器拒绝非 HTTPS、未知 hostname、userinfo、非默认端口、未知 query、外部重定向
和未注册模板。目标页必须在服务端重新验证 locator 对当前 owner 是否可见。

## 10. Agent 通用控制面

`agent.example.com` 是渠道无关能力的聚合控制面。页面可以消费 Memory inference 与 MCP
Gateway 的 owner API，但不能因为统一展示而成为这些事实的第二 owner；它不负责某个渠道
如何显示或投递。

### 10.1 页面

1. **Overview**：Provider 健康、任务、审批、异常、预算与全渠道 usage 摘要。
2. **Models & Reasoning**：聚合 Memory inference model/reasoning 与 Agent planner model，
   明确显示各自 owner、默认值、hard limit、usage 和模型事件。
3. **Tools**：MCP、Skills、Browser、Search/Image、Voice、HA 与内部工具目录。
4. **Tool Workbenches**：每个工具的参数、allowlist、预算、cache、测试和执行日志。
5. **Execution**：tasks、continuations、approvals、Browser sessions、outbox 与恢复。
6. **Automation**：Hooks、Heartbeat、定时任务与触发历史。
7. **Usage & Cost**：全渠道 model/provider usage、tokens、cache、TTFT、费用来源。
8. **Audit & Security**：Service Binding、策略、secret configured status、脱敏审计。
9. **Channels**：渠道适配器健康、生效覆盖摘要和精确深链接，不复制渠道设置。

### 10.2 Agent 不拥有

- Telegram BotFather 命令、parse mode、message split、webhook、chat binding；
- Memory 正文、persona/identity 编辑；
- Memory inference model、transport、prompt cache 和模型 reasoning 执行真源；
- MCP 客户端暴露和 Provider 注册真源；
- 设备 UI、Operia 布局和 Ops 路由事实。

## 11. Telegram 专用控制面

`tgbot.example.com` 是 Telegram adapter control plane。它展示通用能力在 TG 的生效值，
但只拥有 Telegram 行为和允许的 TG override。

### 11.1 页面

1. **Inbox Board**：消息入口、处理中、需要关注、已完成。
2. **Conversation**：TG 默认模型覆盖、debounce、短期渠道会话、`/new` 和重置。
3. **Reasoning Presentation**：显示模式、TG/Chat/下一轮覆盖和 TG 呈现；模型能力和 hard
   limit 通过 Agent 聚合页定位到 Memory inference owner。
4. **Voice Behavior**：文字/下一条语音/偶尔主动、voice note/audio、STT 行为；音色和
   Provider 参数链接到 Agent Voice。
5. **Commands**：BotFather 固定命令、别名、菜单同步、`/tool`/`/skill` 映射和调用日志。
6. **Delivery**：webhook、debounce、分泡、parse mode、重试、outbox、Telegram message ID。
7. **Approvals Presentation**：审批通知、按钮和 callback 状态；票据和 policy 链接到最终
   资源 owner，Agent 页面只提供聚合任务投影。
8. **TG Usage**：按 Telegram 过滤的模型、tier、TTFT、total、input/output、cache read/create。
9. **TG Security**：bot token configured status、webhook secret、owner/chat allowlist。
10. **Channel Events**：`webhook -> inbox -> Agent -> outbox -> Telegram` 渠道时间线。

### 11.2 参数展示

每个引用通用 owner 的参数显示：

- effective value；
- source badge；
- owner global value；
- 当前 TG/Chat override；
- `恢复继承`；
- `前往通用设置`，并在 Agent 聚合页继续标出 canonical owner。

TG 页面不提供 ElevenLabs Voice Design、模型凭据、Browser allowlist、MCP registry、HA service
allowlist 或 Agent hard budget 的复制编辑器。

## 12. 典型归属

| 能力 | 通用 owner | 渠道 owner |
|---|---|---|
| 主对话模型 | Memory inference：模型、transport、prompt cache、全局默认与 hard limit；Agent 只聚合 | TG：默认模型 override、Chat/next-turn 选择 |
| Tool planner 模型 | Agent：planner model、预算、执行与 usage | TG：不拥有，只显示工具任务结果 |
| Reasoning | Memory inference：模型支持参数、默认强度、预算、实际执行与 usage；Agent 只聚合 | TG：是否展示、展示模式、渠道/Chat/下一轮覆盖 |
| Voice | Agent：Voice profile、TTS/STT、Provider、预算与生成日志 | TG：何时发、voice note/audio、caption 与接收行为 |
| MCP Tools | MCP：Provider/catalog/schema/auth/client exposure；Agent：execution policy/risk/cache/delegated allowlist | TG：命令别名、入口映射和命令事件 |
| Browser | Agent：session、Live View、allowlist、执行与证据 | TG：`/browser` 入口、通知和 handoff presentation |
| Memory | Memory：长期事实、persona、identity、召回 | TG：短期渠道会话、`/remember` 交互入口 |
| Usage | 各执行 owner：原始 usage/费用事实；Agent：跨 owner 聚合 projection | TG：Telegram-filtered projection |
| Approval | 最终资源 owner：mutation authorization 与 canonical ticket；Agent：工具执行审批和聚合投影 | TG：通知、按钮和 callback delivery |
| Logs | 各 owner：本阶段 canonical events；Agent：orchestration correlation/projection | TG：channel transport truth |

## 13. 事件关联与 Expandable Blocks

所有跨域流程使用统一 envelope：

```ts
type ControlCorrelation = {
  traceId: string;
  requestId: string;
  runId?: string;
  taskId?: string;
  channel?: string;
  channelMessageId?: string;
  approvalId?: string;
  configKey?: string;
};
```

渠道入口创建并在重试中保持 `traceId + requestId`；Agent 在开始编排时创建并保持
`taskId + runId`；最终渠道 adapter 创建 delivery/channel message ID。Agent 拥有 Context
Capsule 的引用、scope、过期和消费元数据，Memory 继续拥有 Capsule 所引用的内容。相同请求的
重试保持 trace/request/task/run ID；只有新的用户请求创建新 ID。

TG 请求详情 expandable block 只展示渠道相关投影：

- model / service tier；
- TTFT / total；
- input / output；
- cache read / create；
- TG stage timeline；
- `查看 Agent 执行` 深链接。

Agent run 展示完整模型、planner、tools、approval 和 Provider timeline，并提供 `查看 Telegram
投递`。两边引用同一 correlation ID，不复制对方的完整日志。

## 14. 安全边界

- Cloudflare Access 是入口身份层，不替代应用层 authorization。
- 跨域浏览器会话复用 `.example.com` Cookie，但 mutation 仍要求目标域 Origin/CSRF。
- Service Binding bearer 按调用关系分离，不使用一个全能 bearer。
- 偏好 override 可在 owner envelope 内替换；权限、危险能力、hard budget 和 allowlist 只能收紧。
- secret 只以 configured status 或 secret reference 出现。
- 日志和 manifest 经过统一 sanitizer；敏感事件只保存摘要和稳定 ID。
- deep link locator 必须重新授权，不能凭“来自另一个可信域名”自动放行。
- 最终资源 owner 拥有危险 mutation authorization、canonical ticket、幂等和消费；Agent 只
  拥有工具执行审批及其聚合投影，TG 只拥有 presentation/callback delivery。

## 15. 迁移计划

### P0：Inventory 与契约

- 清点 Agent、TG、Memory、MCP、Wrangler vars、DO state 和 D1 中现有参数。
- 生成 owner matrix 和 legacy-location inventory，发现重复 owner、孤儿参数、名称冲突和
  当前物理位置与目标 owner 的差异。
- 建立共享类型、Ops-owned topology registry、scope 与 effective resolver 合同测试。
- 固化项目级 `AGENTS.md` 和本 spec。

### P1：只读合流

- 每个域名增加 manifest。
- 各 canonical owner 提供 definitions/effective read API；Agent 聚合，TG 通过 Service Binding
  读取所需投影。
- 两个面板先显示 effective value、source badge 和 deep links，不改变现有 mutation。
- 建立 correlation envelope 和双向日志 locator。

### P1：Mutation 与 override

- 将通用参数 mutation 收回 owner API。
- TG 对通用参数只写 channel/chat/next-turn override。
- 实现严格 scope、owner 内批量 next-turn claim、跨 owner 幂等 saga、reset to inherited 和审计。
- 当前空心 Reasoning summaries、强度/预算投影和 TG expandable logs 在此阶段接通。

### P2：UI 分流

- Agent 删除渠道专用编辑器，只保留 channel status 和 deep links。
- TG 删除 Provider/工具通用编辑器，只保留生效值、渠道行为和 deep links。
- Voice、Reasoning、Tools、Usage、Approvals 按第 12 节完成归属收敛。
- 全域导航改为 manifest 驱动。

### P2：兼容迁移与清理

- 旧读路径进入兼容期，比较 old/new effective result。
- 将 Agent 当前可写 `mcp_registry` 拆为 MCP Gateway authoritative registry 与 Agent 只读
  projection/execution policy；冻结旧注册写入口后才允许切换。
- 先停止旧写入口，再删除重复字段；迁移必须可回滚且保留普通 Git 历史。
- 更新控制面、命令、API、文档和运维 ledger 中的旧入口描述。

### P3：CLI 与未来渠道

- 当前控制面稳定、无明显 bug 后再发布独立 Workers + CLI 项目。
- CLI 消费相同 manifest、definition、effective、override、event 和 deep-link contract。
- CLI 是客户端，不成为新的配置 owner，也不保存 Provider secret 副本。

### P3：社区提示词契约

- 社区默认 prompt 只保留短而稳定的 Operia 核心：身份边界、记忆协议、工具委派协议、审批与
  安全约束；不得内置私人 persona、域名、账号或凭据引用。
- Tool、Skill 与 MCP 的能力说明由版本化 Registry 生成紧凑摘要；动态运行状态放在请求上下文，
  不把完整 catalog 反复拼入稳定 system prefix。
- Persona、语言风格和家庭/设备偏好作为 Memory owner 的可替换 profile 层加载，不与执行策略、
  工具 schema 或社区默认模板耦合。
- Prompt contract、tool registry hash 与 persona version 分别版本化，使 cache invalidation 只影响
  真正变化的层。CLI 和渠道只消费这些版本，不维护自己的 prompt 分叉。
- 上线前用无 persona 的社区 fixture、私有 persona fixture 和工具 catalog 变更 fixture 分别验证
  行为、缓存命中与 secret redaction。

### Owner 转移协议

任何 owner 转移必须单独写 ADR，并依次完成：目标 schema 与 API、双读比对、冻结旧写、切换
执行消费者、明确 cutover flag、观测窗口和回滚窗口。cutover flag 生效前，当前生产执行 owner
仍是权威；目标 owner 只能标为 planned，不能被控制面展示为已完成迁移。

## 16. 验收矩阵

### 16.1 参数与覆盖

- `[contract][integration]` 修改 owner global 后，mutation response 返回新 ownerVersion；消费者
  通过 version invalidation 在 5 秒 SLA 内读取同一 effective value。
- `[unit][contract]` 创建 TG override，不影响其它 channel scope 或 global。
- `[unit][contract]` 创建 Chat override，只影响目标 chat。
- `[unit][security]` 缺 channel/recipient 的 scope fail-closed，不同渠道相同 recipient ID 不碰撞。
- `[unit][integration]` 每个 owner 一次 claim 全部匹配 next-turn overrides；跨 owner 任一 prepare
  失败时不启动任务，同 request ID 重试返回各 owner 原快照且不发生部分消费。
- `[contract][browser]` `恢复继承` 通过 CAS 删除 override，下一次 read 返回 owner value。
- `[unit][contract]` hard limit 和安全 policy 始终胜过渠道请求。

### 16.2 UI 与导航

- `[browser]` 每个共享参数显示 owner、source 和 effective value；测试使用已认证 Access fixture。
- `[contract][browser]` 相互深链接定位到具体对象，恶意 URL 与未知模板被拒绝。
- `[integration]` 失效 locator 返回明确 not found/forbidden，不跳到模糊首页。
- `[browser]` 390px 与 1440px 无文本溢出或不可达控制。
- `[integration][E2E]` 生产 Telegram 菜单与当前 `BOT_COMMANDS` manifest 完全一致，普通聊天、
  Voice、usage 和工具调用无回归。

### 16.3 数据与安全

- `[unit]` Registry 中每个 key 恰好一个 owner。
- `[contract]` CI 拒绝重复 owner、无 owner、非法 scope 和未知 mutable source。
- `[contract][security]` manifest/deep link/log 不包含 secret、Cookie、prompt 或正文。
- `[integration]` 所有 mutation 具有 actor、scope、revision、old/new hash、request ID 和事件。
- `[integration]` owner 不可达时 projection 标为 stale/unavailable，不返回伪造当前值。

### 16.4 事件

- 从 TG message 可以定位 Agent run。
- 从 Agent run 可以定位 TG delivery。
- Reasoning、Voice、Tool、Browser 和 Approval 共享 trace/run ID。
- 两个面板显示的是各自投影，没有互相复制完整事件正文。

## 17. 后续修改的 Definition of Done

任何新增或调整控制面功能的 PR/提交必须回答并验证：

1. canonical key 是什么，唯一 owner 是谁？
2. 哪些 scope 可覆盖，resolution strategy 与 policy envelope 是什么？
3. effective value 由谁计算，next-turn 如何原子消费？
4. 哪些域名消费该事实，是否通过 Service Binding/owner API？
5. route template、双向 deep link 和 correlation ID 生命周期是什么？
6. manifest、共享 schema、migration 和合同测试是否更新？
7. 是否引入了重复存储、秘密泄漏或第二套业务逻辑？
8. 当前执行 owner 与目标 owner 是否不同；ADR、cutover、兼容、验证和回滚是什么？

缺少任一项时，功能不能视为完成。
