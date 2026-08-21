---
title: Operia P1 Tool Loop and Reasoning Owner Transfer
status: accepted
accepted_at: 2026-07-14
date: 2026-07-14
depends_on: 2026-07-14-operia-federated-control-plane-design.md
scope: Telegram tool continuation, control mutation foundation, Memory reasoning ownership, Telegram reasoning presentation
---

# Operia P1 工具闭环与 Reasoning Owner Transfer Spec

## 1. 决策摘要

本阶段完成两件相互验证的工作：

1. 用一条只读 Browser 任务验收 Telegram -> Opus -> Agent -> Tool -> Opus -> Telegram 的真实续轮闭环；
2. 建立 owner mutation、revision/CAS、override、审计和回滚底座，并以 Reasoning 作为第一个完整 owner transfer。

Reasoning 必须拆成两个不同事实域：

- Memory 拥有模型是否执行 reasoning、effort、sampling temperature、兼容边界与最终请求映射；
- Telegram 拥有 summary/debug trace 是否展示、expandable block 状态与渠道事件。

现有 `/think_on`、`/think_off`、`/think_debug` 继续只控制 Telegram 展示，不暗中改变模型执行，避免破坏已上线命令语义。模型执行配置由 Memory owner API 修改；Agent 只提供聚合视图和精确跳转。

用户实际控制 Opus execution 的入口为 Memory canonical workbench：

```text
https://memory.example.com/admin?config_key=memory.inference.reasoning.enabled
```

该工作台同时提供 Adaptive Thinking 开关、`low | medium | high | max` effort、temperature、scope、继承来源和恢复继承。Agent Models & Reasoning 页面显示同一生效值并精确跳转；TG 页面可以创建 Telegram/chat override，但 mutation 仍直接写入 Memory owner，不落 TG 本地副本。

## 2. 目标

- 用生产 Telegram 消息证明真实工具链不是只有 synthetic smoke。
- 所有 mutation 由 canonical owner 校验和持久化，不允许 projection 写回。
- 所有可写记录具备单调 revision、CAS、幂等和可审计事件。
- 支持 global、channel、chat 与 next-turn 范围，但严格区分 channel 与 recipient，裸 chat ID 不构成 scope。
- Memory 与 TG 页面显示相同 effective execution 值、owner、source、revision 和更新时间。
- TG 页面只编辑 Telegram presentation；Agent 页面不成为 Memory reasoning 的第二 owner。
- 迁移过程可以双读比较、冻结旧写、按 flag 切换和快速回滚。
- 不保存或展示模型未主动暴露的隐藏思维链。

## 3. 非目标

- 本阶段不迁移 Voice、MCP registry、主模型选择或 Provider credentials。
- 不启用 Cloudflare Dynamic Workers、任意代码执行或 unrestricted Browser。
- 不把 Agent DO、TG D1 或 CLI 变成 Memory reasoning 的同步副本。
- 不建立跨 owner 通用分布式事务；本阶段只实现 Reasoning 所需的 owner-local mutation 和 next-turn claim 合同。
- 不改变 Operia persona、稳定 system prefix 或生产模型供应商。
- 不因为调试需要而记录 prompt、memory 正文、tool result 全文或原始 hidden CoT。

## 4. 当前事实

### 4.1 工具链

- Memory 向 Opus 暴露 `request_context`、`delegate_action`、统一 `browse_web` 与非 Web direct tools。Opus 不再选择 `browser_markdown` 或 `search_web`；Agent 内部将明确单页读取、明确检索走确定性 fast path，将点击、导航、登录、表单、翻页、持续观察和歧义 Web 目标送入 GLM planner。两个旧 Web 工具仅保留为隐藏兼容接口。
- Telegram continuation 已能保存 tool round，并经 Agent Service Binding 执行后续轮。
- Agent Browser 当前只允许固定 quick actions、精确域名 allowlist、预算和 lifecycle hooks。
- synthetic smoke 已通过；尚缺由真实 Telegram 用户消息触发的生产只读 Browser 闭环证据。

### 4.2 Reasoning

- Memory 请求组装器已经识别 `reasoning_effort`、thinking enable、budget 和 temperature，并最终映射到 Anthropic 请求。
- Memory 当前默认值仍主要来自 Worker 配置，尚无统一 runtime owner store。
- 当前 adapter 使用 manual `budget_tokens`；Opus 4.6 官方已推荐 Adaptive Thinking + effort，manual budget 进入 deprecated 兼容状态，因此 owner transfer 同时负责迁移请求形态。
- 当前 adapter 在 thinking 开启时已经省略 temperature；新 owner read model 必须把这种 provider 兼容约束明确展示，不能让用户误以为温度仍在生效。
- TG D1 的 `reasoning_mode` 只控制 `off | summary | debug_trace` 展示。
- `/think_on`、`/think_off`、`/think_debug` 与 TG 页面都直接写 TG setting；这部分继续归 Telegram owner。
- Agent `/control` 已能只读聚合 Memory 与 TG 投影，但不接受跨 owner mutation。

## 5. Phase A：真实工具闭环验收

### 5.1 固定探针

使用 owner 私聊向 `@<OWNER_BOT_USERNAME>` 发送一次带唯一 probe ID 的自然语言请求：读取 allowlist 内的 Cloudflare Agents 文档标题，并用一句话返回。Opus 必须只调用 canonical `browse_web`；Agent 内部必须把它解析为隐藏的 `browser_markdown` quick action，不调用 GLM，也不允许点击、登录、写表单或访问新域名。另加交互探针“从 GitHub 项目页进入 Releases”，必须由同一个 `browse_web` 升级为 `delegate_action`，不得退化为单页读取。

探针目标固定为：

```text
https://developers.cloudflare.com/agents/
```

### 5.2 必须贯通的阶段

```text
telegram_update
  -> memory_chat_request
  -> agent_task_created
  -> policy_allowed
  -> browser_tool_started
  -> browser_tool_completed
  -> continuation_submitted
  -> memory_final_response
  -> telegram_outbox_delivered
```

每个阶段共享 `trace_id`、`request_id` 和 `task_id`；Telegram update/message ID 只作为渠道 locator。跨域日志只保存摘要、状态、时延和 hash，不复制正文。

### 5.3 验收句柄

- 只产生一个 Agent task、一次 Browser 执行和一条最终 TG 回复；Webhook 重试不重复执行。
- `request_context` 与紧随其后的 `delegate_action` 使用相同 scope/capsule。
- 工具结果由 Opus 续轮消费，不由 GLM 或 Telegram 模板直接拼成最终回答。
- 最终回复不得为空；空 content 必须进入显式 error/fallback，不得发送“（空回复）”。
- 面板可按同一 trace 定位 Telegram、Memory、Agent 和 Browser 阶段。
- 展示四组常用指标：model/service tier、TTFT/总耗时、input/output tokens、cache read/create tokens。
- 工具调用失败时返回可见的短错误并保留 retryable 分类，不静默吞掉。

该探针先执行一次冷请求，再用语义相同、probe ID 不同的请求执行一次缓存观察。工具副作用不得因缓存试验而变化。

## 6. Canonical Reasoning Keys

### 6.1 Memory execution owner

| Key | Schema | Scope | Resolution | Notes |
|---|---|---|---|---|
| `memory.inference.reasoning.enabled` | boolean | global/channel/chat/next-turn | replace_within_envelope | 是否发送 `thinking: {type: "adaptive"}` |
| `memory.inference.reasoning.effort` | `low\|medium\|high\|max` | global/channel/chat/next-turn | replace_within_envelope | Opus 4.6 推荐的思考深度与总体 token/tool eagerness 控制 |
| `memory.inference.sampling.temperature` | number `0..1` | global/channel/chat/next-turn | replace_within_envelope | 仅在 adaptive thinking 关闭时发送给 Provider |
| `memory.inference.reasoning.legacy_budget_tokens` | integer | global only | numeric_min | 迁移期兼容旧配置，不作为常规 UI 主控 |

约束：

- `enabled=true` 时发送 Adaptive Thinking；Opus 4.6 的 effort 允许 `low | medium | high | max`，默认建议显式设为 `medium`，避免日常聊天长期使用 API 默认 `high` 带来的额外时延。
- `enabled=false` 时不发送 thinking，但 effort 仍可影响文本输出和工具调用的 token eagerness；UI 必须把“Thinking 开关”和“Effort 档位”显示为两个相关但不同的控制。
- thinking 开启时，Anthropic 不允许修改 temperature。owner 保存用户的 temperature preference，但 request adapter 省略 temperature，并返回 `runtimeStatus=inactive_due_to_adaptive_thinking`；关闭 thinking 后自动恢复该偏好。
- 不把 temperature 强制改写成 1，也不在开关 thinking 时删除用户偏好。
- manual `budget_tokens` 在 Opus 4.6 仍可兼容但已 deprecated。迁移期只用于 dual-read 和回滚；新 UI 不用预算 slider 作为主要档位，最终由 effort 取代。
- effort、Adaptive Thinking 和 sampling 兼容矩阵只在 Memory adapter 中实现；TG、Agent 和 CLI 不复制映射表。
- forced tool choice 若要求临时禁用 thinking，必须在 effective request metadata 中记录 `runtimeSuppression=forced_tool_choice`，不得反向修改 owner setting。

### 6.2 Telegram presentation owner

| Key | Schema | Scope | Resolution | Notes |
|---|---|---|---|---|
| `telegram.presentation.reasoning_mode` | `off\|summary\|debug_trace` | channel/chat | replace_within_envelope | 控制 TG 展示，不控制模型执行 |
| `telegram.presentation.expandable_usage` | boolean | channel/chat | replace_within_envelope | 展开 token/cache 指标块 |
| `telegram.presentation.expandable_tool_trace` | boolean | channel/chat | replace_within_envelope | 展开工具阶段摘要 |

`summary` 只能展示模型 API 主动返回且允许呈现的 reasoning summary。`debug_trace` 只展示上下文请求、工具选择、审批、执行结果摘要和阶段耗时。二者都不得恢复或推断 hidden CoT。

### 6.3 命令兼容

- `/think_on`：将 TG presentation mode 设为 `summary`。
- `/think_off`：将 TG presentation mode 设为 `off`。
- `/think_debug`：将 TG presentation mode 设为 `debug_trace`。
- 三条命令不修改 `memory.inference.reasoning.*`。
- `/reasoning off|low|medium|high|max|reset`：通过 Service Binding 写入或删除 Memory chat override；不写 TG D1。
- `/temperature 0..1|reset`：通过 Service Binding 写入或删除 Memory chat temperature override。thinking 开启时命令明确回复“已保存，当前因 Adaptive Thinking 暂不生效”。
- Agent/TG 页面中的渠道 override 使用同一 owner API；不得重载旧 `/think_*` 语义。

## 7. Owner Mutation Contract

### 7.1 API

Memory owner 提供：

```text
GET    /service/control/values?keys=...
POST   /service/control/effective
PUT    /service/control/values/:key
PUT    /service/control/overrides/:key
DELETE /service/control/overrides/:key
POST   /service/control/next-turn/claim
POST   /service/control/next-turn/release
GET    /service/control/events
```

浏览器使用同语义的 `/api/control/*` 路由，并继续要求域会话、精确 Origin 与 CSRF。Service Binding 请求要求独立 bearer、调用方 service ID、owner ID 与允许 scope。

### 7.2 Mutation request

```json
{
  "scope": {
    "kind": "chat",
    "channel": "telegram",
    "recipientType": "private_chat",
    "recipientId": "<opaque-id>"
  },
  "value": "medium",
  "reason": "owner_console_update"
}
```

要求：

- 更新和删除必须携带 `If-Match: \"<revision>\"`。
- 创建必须携带 `Idempotency-Key`，相同 key 与相同 body 返回原响应；不同 body 返回 409。
- scope 使用严格 discriminated union；缺 channel、recipient type 或 ID 时 fail-closed。
- response 返回 canonical key、effective/global/override values、source、revision、ownerVersion、updatedAt 和 deepLink。
- revision 按记录单调递增；ownerVersion 在 owner 任一成功 mutation 后变化，用于 projection invalidation。
- CAS 不匹配返回 409，并带当前 revision 与不含敏感值的 current metadata；不得 last-write-wins。

### 7.3 Owner store

Memory D1 使用 additive schema：

```text
control_values
control_overrides
control_events
control_idempotency
control_next_turn_claims
```

所有 key 必须先存在于版本化 Control Registry。D1 更新使用 `WHERE revision = ?` 实现 CAS；影响行数为 0 即冲突。写入值使用 typed JSON，读取后仍按 registry schema 复验。

事件只记录 actor reference、scope hash、old/new value hash、revision、result、request ID 和时间。Reasoning 偏好本身不是 secret，可以在 owner 受保护页面显示，但跨域审计默认仍不复制完整 payload。

### 7.4 Next-turn claim

- Memory 按 `request_id + channel + recipient` 一次 claim 该 owner 的全部匹配 next-turn overrides。
- claim 返回固定 `effectiveSnapshot`、snapshot hash 和 ownerVersion。
- 相同 request ID 重试返回原 snapshot，不重复消费。
- 任务未启动且明确放弃时，才允许用同一 idempotency key release。
- Telegram 不得先删除本地 flag 再请求 Memory。

本阶段只有 Memory reasoning 参与 claim，因此不实现跨 owner saga；接口必须保留可扩展的 owner result envelope，供 Voice 或其它 owner 后续接入。

## 8. UI 分工

### 8.1 Memory canonical workbench

提供 **主模型生成与推理** 编辑器：

- Adaptive Thinking toggle；
- `low / medium / high / max` effort segmented control；
- temperature `0.00..1.00` slider + number input，步长 `0.05`；
- global/channel/chat/next-turn scope selector；
- effective source、revision、reset to inherited 和最近 owner events；
- effective request preview，只显示参数，不显示 prompt 或正文。

thinking 开启时 temperature 控件保留数值但进入 disabled/inactive 视觉状态，并说明 Provider 约束；不能让滑块看似可用却在后端静默忽略。Legacy budget 只放在折叠的 migration diagnostics 中。

### 8.2 Agent aggregate view

显示 Memory execution、temperature 与 Agent planner reasoning 的并列状态，二者必须标注不同 owner。Memory 项只提供只读 effective projection 和“前往通用设置”深链接，不接受本地保存。

### 8.3 Telegram workbench

编辑 presentation mode、expandable blocks，以及明确允许的 Telegram/chat execution overrides。execution override 控件是 Memory owner API 的客户端，必须显示“保存到 Memory”；页面本地不得新建同名字段。页面同时显示当前 Memory execution/temperature effective value、source 和 owner，并提供 canonical deep link。不得出现 Provider credential 或第二套模型默认值。

owner 不可达时显示 unavailable 和最后 observedAt；不得回退到 TG 旧字段伪装成当前 execution 值。

## 9. Owner Transfer Protocol

### Stage 0：Schema 与 shadow read

- 部署 additive D1 migration、owner API 和合同测试。
- 从当前 Memory Worker 默认配置生成只读 fallback，不立即删除环境变量；temperature 没有 owner 默认时沿用请求值或 Provider default。
- canonical store 未初始化时，effective read 标记 `source=legacy_default`。

### Stage 1：Seed 与 dual-read

- 将当前生产 execution 默认 seed 到 owner store，记录 seed event 和来源版本。
- 每个请求同时计算 legacy 与 canonical effective result，只记录 hash、差异类型和 trace ID。
- canonical 值此时不影响模型请求。

### Stage 2：冻结旧写

- 确认不存在 TG/Agent 对 execution key 的旧写入口。
- 如发现旧 mutation，改为 409 + canonical deep link；不删除旧列或配置。
- presentation 的 TG 写路径不属于 execution 旧写，继续正常工作。

### Stage 3：Consumer cutover

- 以显式 flag 将 Memory Anthropic request builder 切到 canonical effective snapshot，并从 manual thinking 迁到 `thinking: {type: "adaptive"}` + output effort。
- 每个模型调用记录 ownerVersion、revision、effective source 和 snapshot hash。
- projection cache 必须带 ownerVersion 与短 TTL；版本变化后 5 秒内失效。
- thinking 开启时 request 必须省略 temperature；关闭时恢复 effective temperature。

### Stage 4：Observation

观测窗口至少 24 小时且至少 50 个真实主模型请求，两者取较晚者。期间要求：

- legacy/canonical hash 不出现未解释差异；
- 空回复率、错误率和 P95 总耗时不显著回归；
- TG 命令和页面 presentation 行为不变；
- 无 CAS 绕过、跨 chat scope 污染或重复 next-turn consumption；
- 控制面显示值与实际模型请求 metadata 一致。

### Stage 5：Finalize

- 将 canonical owner 标记为 active，legacy location 标记 read-only compatibility。
- 另开普通提交清理确认无消费者的旧字段；不在 cutover 提交中删除回滚路径。
- 更新 registry、控制面、测试和运维 ledger 的 migrated 状态。

## 10. Rollback

以下任一条件触发回滚：

- production tool loop 出现重复执行、空回复或无法续轮；
- canonical reasoning 与实际 Anthropic request 不一致；
- UI 显示 temperature active，但生产请求因 thinking 实际省略，或反之；
- owner store 不可达导致主聊天失败，而不是安全回退；
- revision/CAS 可被绕过；
- scope 泄漏到其它 chat/channel；
- P95 总耗时相对基线增加超过 20%，且无法由显式开启 reasoning 解释。

回滚动作：

1. 关闭 consumer cutover flag，恢复 Memory legacy default 读取；
2. 保留 canonical store、events 和 dual-read 证据，不反向覆盖旧配置；
3. TG presentation 路径继续运行；
4. 停止 owner mutation API 或切为 read-only，不删除已写记录；
5. 用新提交修复，禁止 force push、amend 或破坏性 D1 回滚。

## 11. 测试与验收矩阵

### Contract

- Registry 中四个 Memory execution key 只有一个 owner，三个 TG presentation key 只有 TG owner。
- typed value、effort enum、temperature bounds、legacy budget bounds、strict scope、deep link template 全部验证。
- Opus 4.6 effort 仅允许 `low|medium|high|max`；temperature 仅允许 `0..1`。
- CAS success、stale revision 409、幂等重试、幂等 body 冲突、reset inherited 全部覆盖。
- next-turn claim/retry/release 不重复消费。
- ownerVersion 变化使 Agent/TG projection 在 5 秒内失效。

### Security

- 浏览器 mutation 缺 session、Origin 或 CSRF 均拒绝。
- Service Binding 缺 bearer、错误 caller/scope 或越权 global mutation 均拒绝。
- manifest、events、URLs、screenshots 和 fixtures 不含 token、Cookie、prompt、memory 正文或 hidden CoT。
- hard max 不能被 channel/chat/next-turn override 提高。

### Regression

- `/think_on|off|debug` 与 TG 页面仍只改变 presentation。
- 普通无工具聊天、带图聊天、Voice、usage、cache 和现有固定命令不回归。
- reasoning disabled 不发送 Anthropic thinking；enabled 时 Adaptive Thinking 与 effort 映射正确。
- reasoning enabled 发送 Adaptive Thinking 和 effort，不发送 temperature；disabled 时恢复 effective temperature。
- legacy manual budget 仅在回滚 flag 下发送，新写路径不会创建 budget override。
- provider 未返回 summary 时 UI 明确显示“无主动返回摘要”，不生成伪摘要。

### Production E2E

- 固定 Browser 探针完成唯一 task、唯一工具调用、唯一续轮和唯一 TG delivery。
- 冷/暖请求的四组 metrics 可在 expandable blocks 与域名面板中定位。
- owner 页面修改 reasoning 后，Memory 实际请求 metadata、Agent projection、TG projection 在 SLA 内一致。
- owner 页面修改 temperature 后，thinking off 时请求立即采用；thinking on 时显示已保存但 inactive，关闭 thinking 后恢复。
- stale browser tab 提交旧 revision 得到 409，并能刷新后重试。
- reset 后 effective source 恢复 inherited。

## 12. 实施顺序

1. 增加真实工具闭环 trace 与固定生产 probe runner，不改变业务行为。
2. 修复 probe 暴露出的空回复、重复续轮或日志关联问题，形成稳定基线。
3. 实现共享 mutation types、Memory D1 schema、CAS、idempotency、events 与合同测试。
4. 注册 Reasoning、effort 与 temperature canonical keys，接通 Memory owner read/mutation API。
5. 接通 Agent/TG 只读 projection、semantic deep links 和 unavailable 状态。
6. 运行 seed、dual-read 和旧写入口审计。
7. 以 flag 切换 Memory request builder，执行生产 observation。
8. 验收后更新迁移状态；Voice 与 MCP 只能复用该底座，不能另建写协议。

## 13. 完成定义

只有同时满足以下条件，本阶段才算完成：

- 真实 Telegram Browser 闭环通过且无空回复、重复工具执行或手工拼接最终答案；
- Memory reasoning mutation 具备 owner-only、CAS、幂等、审计、override 与 reset；
- Adaptive Thinking、effort 与 temperature 的 Provider 兼容状态在 UI 和实际请求中一致；
- Memory 实际请求、Agent projection、TG projection 对 effective execution 值一致；
- TG presentation 保持独立且旧命令兼容；
- observation 窗口完成，回滚演练通过；
- 完整测试、Wrangler dry-run、生产浏览器和 Telegram E2E 通过；
- 部署记录、网络入口总表、近期主线总表和私有 GitHub 镜像在验证后同步。

## 14. 待用户验收的决策

本 spec 当前为 `proposed`。进入实现前只需确认以下三项，其余均视为已由上位联邦控制面 spec 约束：

1. `/think_on|off|debug` 保持“TG 展示模式”语义；新增 `/reasoning` 和 `/temperature` 控制 Memory execution override；
2. 第一条生产工具探针使用 Cloudflare Agents 文档的只读 Browser 读取；
3. Reasoning owner cutover 的最短观测窗为 24 小时且至少 50 个真实请求。

验收后将 frontmatter 状态改为 `accepted`，并在项目 `AGENTS.md` 的 Change Protocol 下将本文件列为 Reasoning mutation 与真实工具闭环的实施约束。

## 15. Provider 依据

- Anthropic Opus 4.6 推荐 Adaptive Thinking + effort；manual `budget_tokens` 已 deprecated。
- Opus 4.6 effort 支持 `low | medium | high | max`，API 默认 `high`。
- Extended thinking 不兼容 temperature 修改；thinking 参数变化会使 message cache breakpoint 失效，但稳定 system prompt 和 tool definitions 的 cache 可继续保留。

实现时应以 Anthropic 官方最新文档为准：

- https://platform.claude.com/docs/en/build-with-claude/effort
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking
