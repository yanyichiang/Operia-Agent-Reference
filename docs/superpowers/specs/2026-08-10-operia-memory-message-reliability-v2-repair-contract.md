---
date: 2026-08-10
status: owner-requested repair contract; implementation and production rollout require separate gates
scope: Telegram ingress -> Memory inference -> recall -> durable presentation -> Telegram delivery -> canonical memory publication
owners: [Memory, Telegram]
cache_mode: anchored_v3_unchanged
production_changed: false
---

# Operia Memory / Telegram Reliability v2 修复合同

## 0. 一句话结论

本次不再用“多重试几次”掩盖状态机缺口，而是把一次回复拆成三个不可混淆的事实：

```text
模型是否已经产生结果
  != 结果是否已形成可重放的展示包
  != 用户是否已确认收到该结果
```

修复只落在 Harness、D1 状态机、召回 deadline、投递序列与 Memory publication projection；不要求模型调用工具、输出特殊标记或“记得完成某一步”。

## 1. 硬边界

以下内容在全部 Gate 中保持原样：

1. `MEMORY_THINK_CACHE_V3_MODE=anchored_v3`；不得把 `automatic_v3` 作为默认、发布目标或回滚点。
2. 当前 tools、instructions、tool choice、cache breakpoints、cache anchor block 与 final-render execution barrier。
3. Telegram canonical history 的时间顺序与稳定前缀；不得把旧 suffix 拼到较新的 Memory state 后面。
4. 同一 inference idempotency identity 最多一次付费模型调用；`calling/responded/sending` 的未知副作用不得盲重试。
5. 同一聊天可以让后续模型计算继续，但外部 Telegram 发送必须保持单一全局顺序。
6. 不新增模型、Provider、提示词、模型工具、路由、Secret 或外部服务。

允许变化的是“哪些已经发生的事实可以进入上下文”。修正未送达 assistant 被当成已送达的错误投影，不属于修改缓存算法；它必须保持已确认历史前缀不动，只修正可变 suffix。

## 2. 当前故障与直接证据

| 编号 | 当前行为 | 用户可见后果 | 根因 |
| --- | --- | --- | --- |
| R1 | `reconcileTgInferenceFromMemory()` 对 `attention_required` 直接返回 | Memory 稍晚完成时，真实回复永远不再接管；先前“状态不确定”通知成为误报 | Telegram terminal state 早于 Memory canonical outcome，且没有窄 CAS 复活路径 |
| R2 | pending approval / SDK action / Code Mode parked 只写 `responded`，不持久化 response JSON | Service Binding 返回丢失后审批卡无法重建，run 卡住 | “中间展示”被误当成不可重放的最终副作用 |
| R3 | assistant 在 Telegram 送达前进入 `messages`、maintenance 与 conversation archive | 用户没收到的话仍被当成共同经历，形成 ghost memory | generated 与 delivered 没有分层 |
| R4 | paragraph、result capsule、final batch 各自维护 FIFO | 后一轮段落/卡片可越过前一轮待发 final | FIFO 只在局部表内成立，不是 chat-wide |
| R5 | delivery batch 已 terminal、run 尚未 terminal 时重入直接返回 | crash window 后 run 永久停在 `delivery_pending` | terminal read 缺少确定性状态对账 |
| R6 | imported-summary recall 不受 3.5 秒 recall deadline 约束 | 主召回已超时降级，整体请求仍被历史检索拖住 | 并行 lane 使用不同的隐含等待边界 |
| R7 | Harness 把除 tool/pause/compaction 外的所有 finish reason 当作完整 final | `length/error/content-filter/unknown` 被改写为 `stop` 并作为完整记忆 | “循环结束”与“内容完整”被合并成一个布尔值 |

## 3. 统一状态模型

### 3.1 Reply lifecycle

```text
claimed
  -> awaiting_memory
  -> presentation_ready     # 审批/Code Mode 等可见但非 final 的中间包
  -> final_generated        # 已有付费结果，尚未确认 Telegram 送达
  -> delivery_pending
  -> delivered | delivered_partial | delivery_unknown | excluded
```

`attention_required` 是人工/系统处置状态，不再同时表示“模型没结果”“结果没落盘”“Telegram 未知送达”三种不同事实。所有 attention 必须带稳定 `reason_code` 和 `last_known_stage`。

### 3.2 Message publication state

Telegram 来源的 assistant message 增加以下持久状态：

```ts
type MessagePublicationState =
  | "source_received"       // Owner 消息已被 Telegram ingress 接收
  | "generated_unconfirmed"// 模型结果已持久化，但尚无 Telegram success receipt
  | "delivered"            // Telegram 明确返回成功
  | "delivered_partial"    // 用户确实收到，但 provider JSON 表明内容不完整
  | "delivery_unknown"     // send side effect 结果未知，不得重发
  | "excluded";            // 空/错误/静态系统提示等非 assistant canonical content
```

存储字段至少包括：

```text
messages.publication_state
messages.publication_ref       # tg batch key；不得放正文
messages.turn_order_key        # 本轮最小 tg_inbox.id
messages.turn_item_order       # owner=0, assistant=1
messages.publication_resolved_at
```

非 Telegram 旧行迁移为 `delivered`；能够关联 TG run 的旧 assistant 必须按第 11 节联查真实 delivery state，不能关联且无法证明送达的 TG assistant 进入 migration exception 并排除普通召回。新 Telegram assistant 必须由调用方显式传入 publication state，禁止依赖数据库默认值。非 Telegram client 继续沿用现有已返回即 canonical 的合同。

### 3.3 各层准入矩阵

| publication state | Inspector / audit | rolling context suffix | episodic / FTS / vector | semantic candidate | Fact / Subject / Point evidence |
| --- | --- | --- | --- | --- | --- |
| `source_received` | 是 | 是 | 是 | 是 | 是 |
| `generated_unconfirmed` | 是 | 否 | 否 | 否 | 否 |
| `delivered` | 是 | 是 | 是 | 是 | 是 |
| `delivered_partial` | 是 | 是，带确定性 partial 标签 | 否 | 否 | 否 |
| `delivery_unknown` | 是 | 否 | 否 | 否 | 否 |
| `excluded` | 是 | 否 | 否 | 否 | 否 |

任何 retrieval / injection SQL 若没有显式 publication predicate，即为 Gate 失败。不得指望 Judge、摘要模型或 Operia 自己“识别并忽略没送达内容”。

### 3.4 Publication gap barrier

为保持 anchored cache 的稳定历史前缀：

1. summary fold / cache watermark 不得越过同一聊天中尚未 resolved 的 `generated_unconfirmed` assistant event。
2. Owner 后续消息仍可进入可变 suffix，按 `(turn_order_key, turn_item_order)` 排序。
3. assistant 变为 `delivered` 后，只填充 barrier 后的 suffix；不得改写已缓存 prefix。
4. assistant 变为 `delivery_unknown/excluded` 后，barrier 以“确定性跳过”方式关闭。
5. fold 只能覆盖连续、publication 已终结的前缀。

这允许下一轮模型计算不等待上一轮 Telegram tail，同时不制造乱序缓存或 ghost memory。

## 4. 合同 R1：晚到 Memory 结果必须能窄接管

### 4.1 Memory outcome authority

Telegram watchdog 只读取以下 Memory-owned canonical 状态：

```text
calling/responded       -> awaiting_memory_outcome；不发“请重发”，不发起第二次模型调用
completed+response_json -> 恢复原 response；进入 ready/final_generated
attention_required      -> 按 Memory 明确错误终结
missing                 -> 继续有界对账；不得推断“模型没有回复”
```

ready event 与 watchdog 使用同一 CAS，谁先成功谁接管。watchdog 是丢事件恢复，不是付费重试。

### 4.2 允许复活的唯一窗口

一个由旧实现过早写成 `attention_required` 的 Telegram run，仅在同时满足以下条件时允许迁移期恢复：

1. `last_error IN ('memory_outcome_reconcile_exhausted','memory_outcome_unresolved')`；
2. Memory 行为同一个 `tg:{batch_key}`，`request_hash` 与 `source` 完全匹配；
3. Memory 状态为 `completed` 且 `response_json` 可解析；
4. TG 尚无 `final_package_json`，统一 delivery sequence 尚未开始外部发送；
5. 尚未超过本轮 `outcome_wait_expires_at`，且没有更高 `delivery_seq` 开始外部发送；
6. CAS 仍以当前 `status + updated_at/revision` 为前置条件。

任何 `tg_outbox_attention_required`、approval unknown、invalid package、policy refusal 或其他 attention 均不得复活。

### 4.3 Watchdog 时序

现有 30/30/60/90 秒阶梯改成“事件优先、短探针补洞、长等待保价格”：

```text
ready event: 0 秒立即接管
watchdog: 2s, 5s, 15s, 45s, 120s, 300s, 900s absolute checkpoints
```

每次只读一行 D1，不调用模型。`calling/responded` 在 900 秒前保持非 terminal 的 `awaiting_memory_outcome`，不得被描述为失败；ready event 到达即刻解除该状态。900 秒后以 `memory_outcome_unresolved` 终结、释放同 chat 的计算锁并发送一次静态状态：

> 这次结果仍未能确认；系统没有重新调用模型。这一轮已经关闭。

该通知属于 system presentation，不进入 assistant memory，也不要求用户重发。900 秒后才完成的 Memory response 只保留为 audit evidence，不再晚到发送，以免越过已经开始投递的后续聊天轮次。

任何 inference 状态通知还必须通过同一个 notice CAS：Memory 仍非 `completed`、没有 durable presentation、没有 `first_response_json/final_package_json`、没有 delivery item 开始发送，且当前 run 仍为 `awaiting_memory_outcome`。只要真实回复已经落盘或发送开始，watchdog 就只能对账，不能在回复段落之间插入“状态不确定”提示。

## 5. 合同 R2：pending presentation 是可重放的一等状态

新增 `inference_presentations`（或等价 additive 表），最小字段：

```text
idempotency_key + revision          primary identity
request_hash + source               replay identity
kind                                approval | sdk_action | codemode_parked
response_json                       完整 OpenAI-compatible presentation envelope
status                              ready | consumed | superseded | attention_required
created_at / updated_at / expires_at
```

顺序必须是：

```text
持久化 approval/action/codemode continuation
  -> 持久化 presentation JSON
  -> enqueue tg_inference_ready
  -> 返回 Service Binding response
```

禁止只调用 `markInferenceResponded()` 后返回。TG 在 HTTP/Service Binding 返回丢失时从 presentation ledger 重建同一个卡片；callback ref、approval ref、args hash、authority scope 与 expiry 必须保持原值。重放只重发 presentation intent，不重做模型调用或外部 Action。

最终 response 到达后，presentation 标记 `consumed/superseded`；最终 replay 与中间 presentation 使用不同 revision，不互相覆盖。

## 6. 合同 R3：只有送达确认才能发布 assistant memory

### 6.1 写入

`saveAssistantMessage()` 对 Telegram final 先写 `generated_unconfirmed`，同时保存 `publication_ref` 与 turn order；此时：

- 可以写 usage 与 inference audit；
- 不得 enqueue memory maintenance / retention derivation；
- episodic trigger 不得投影；
- conversation archive 不得把 assistant 加进 rolling state。

Owner user message 继续在 ingress 后按 `source_received` 立即 canonical，不因 assistant 失败而消失。

### 6.2 送达对账

统一 delivery sequence terminal 后执行一个幂等 publication CAS：

```text
all required visible items sent + completeness=complete
  generated_unconfirmed -> delivered

visible text sent + completeness=partial
  generated_unconfirmed -> delivered_partial

unknown Telegram side effect
  generated_unconfirmed -> delivery_unknown

没有可见 assistant final / 静态系统提示
  generated_unconfirmed -> excluded
```

只有 `delivered` 转换成功后才 enqueue assistant maintenance、episodic indexing 与 canonical archive。`delivered_partial` 只进入带标签的短期 rolling suffix，用于下一轮连续性，不参与长期事实提炼。

### 6.3 Conversation event identity

原来的单一 `batch:{batch_key}` application key 拆成角色级 identity：

```text
batch:{batch_key}:owner
batch:{batch_key}:assistant
```

投影始终按 `(turn_order_key, turn_item_order)` 重建可变 suffix。未决 publication 形成 gap barrier；不得通过按 `created_at` 直接 append 的方式把晚到 assistant 放到更新的 Owner 消息后面。

## 7. 合同 R4：一个 chat 只有一条外部发送序列

### 7.1 Sequence identity

每个自然语言 batch 的 `delivery_seq` 固定为其已 claim inbox ID 的最小值；该值在模型调用前已存在，无需新增热路径计数器写入，也不进入 prompt 或 provider request。

全部可见 payload 使用：

```text
(chat_id, delivery_seq, item_seq, intent_key)
```

其中 `intent_key` 继续负责 Telegram side-effect idempotency，`delivery_seq/item_seq` 只负责顺序。

### 7.2 Unified delivery ledger

新增 `tg_chat_delivery_sequences` 与 `tg_chat_delivery_items`，或把现有表演进为等价合同：

```text
sequence: reserved | open | closed | completed | attention_required
item:     staged | sending | sent | attention_required
```

paragraph stream、reasoning/result capsule、final text、media 与本轮 system receipt 都只能向同一个 sequence 追加 item。它们不得各自直接 claim Telegram outbox。

确定性 item 顺序：

1. 已产生并发布的 paragraph prefix；
2. final 时尚未发布且按当前产品合同位于正文前的 reasoning/result card；
3. 剩余 canonical text bubbles；
4. media intents；
5. 本轮 receipt/status item。

无 paragraph prefix 时，保持当前“result card 在 final text 前”的展示顺序。

### 7.3 Claim gate

一个 item 只有在以下条件同时成立时可调用 Telegram：

1. 它等于该 sequence 的 `next_send_index`；
2. 同 chat 不存在更小且未 terminal 的 `delivery_seq`；
3. 当前 sequence lease CAS 成功；
4. 对应 outbox intent 不是 `sent/sending-unknown`。

后续 run 可以完成 Memory 计算和持久化，但只能停在自己的发送 gate；因此修复顺序不以串行化模型推理换取可靠性。

### 7.4 Terminal re-entry repair

`resumeTgInferenceDelivery()` 读取到 delivery sequence/batch 已 terminal 时，必须先做幂等对账再返回：

```text
delivery completed          -> run completed + publication delivered/partial
delivery attention_required -> run attention_required + publication delivery_unknown/excluded
```

这关闭“batch 已完成但 run 仍 delivery_pending”的 crash window。对账不得产生 Telegram send 或模型调用。

## 8. 合同 R5：所有可选检索共享一个绝对 deadline

请求开始时由 Harness 创建一次：

```ts
type RecallDeadline = {
  startedAtMs: number;
  deadlineAtMs: number;
  remainingMs(): number;
  signal: AbortSignal;
};
```

默认 deadline 继续使用现有 `MEMORY_RECALL_TIMEOUT_MS=3500`；本 Spec 不调整缓存、Top-K、embedding、fusion 或注入内容。

适用 lane：

- v2 `runRecall()`；
- `searchImportedSummaries()`；
- 以后进入前台的其他 optional recall lane。

规则：

1. 所有 lane 并行启动，共享同一个 `deadlineAtMs`，不得每条 lane 各拿 3.5 秒。
2. 单 lane 超时只降级该 lane；`Promise.all` 不得继续等待它。
3. 支持 abort 的 fetch / Vectorize / AI 调用必须接入同一个 signal；不支持取消的 D1 查询结果在 deadline 后丢弃，不阻塞请求。
4. persona 与 Subject Core 仍是本地 mandatory projection，不因 optional historical recall 超时被一起清空。
5. receipt 记录 `lane_status=hit|empty|timeout|error`、耗时与 deadline；不记录 query 正文或召回正文。

该修复只消除 3.5 秒之后的额外尾延迟，不通过降低现有 recall budget 换速度。

## 9. 合同 R6：Harness 从 provider JSON 判定完整性

`HostFinalBarrier` 继续只回答“是否结束 tool loop”；新增正交的 `TerminalCompleteness`，由 Harness 读取 provider/AI SDK JSON 元数据确定：

```ts
type TerminalCompleteness =
  | "complete"
  | "partial"
  | "failed"
  | "attention";
```

确定性映射：

| unified / raw finish reason | completeness | 行为 |
| --- | --- | --- |
| `stop`, `end_turn`, `stop_sequence` | `complete` | 正常 final |
| `length`, `max_tokens` | `partial` | 发送已有可见文本并显式标 partial；不自动续写 |
| `error` | `failed` | 不伪装成 `stop`；不自动重试付费调用 |
| `content-filter`, `content_filter`, `other`, `unknown` | `attention` | 有可见文本则按 partial 送达；无文本则静态准确提示 |
| `tool-calls`, `pause_turn`, `compaction` | 非 terminal | 保持现有 Harness continuation |

OpenAI-compatible response 必须保留规范化 `finish_reason`，并增加 bounded `operia_terminal` metadata；不得把任何 terminal 一律重写为 `stop`。

该判定完全在 Harness 层完成：不新增“请调用某工具结束回复”的要求，不解析模型正文中的 JSON、符号或自然语言承诺。模型即使忘记所有工具，provider finish metadata 仍会被处理。

## 10. 延迟合同

### 10.1 不以可靠性增加热路径等待

1. 不新增模型调用、repair inference 或自动 continuation。
2. 不串行运行 recall lanes；只引入共享绝对 deadline。
3. 不让后续 inference 计算等待上一轮 Telegram delivery；只在外部 send claim 处等待。
4. delivery sequence 在 run 创建时由现有 inbox ID 派生，不增加单独的序号分配 round trip。
5. presentation/final 一旦 durable，ready event 立即唤醒；watchdog 只补丢事件。
6. 已 durable final 且位于 chat lane head 时，同一 Queue invocation 继续尝试首个 payload，不等待下一次普通 Queue 调度。

### 10.2 验收 SLO

在 Telegram API 可用且本轮位于 chat lane head 时：

| 指标 | 目标 |
| --- | --- |
| webhook durable handoff | p95 <= 250 ms |
| optional recall 总等待 | hard cap = 当前 3500 ms |
| Memory presentation/final durable -> TG resume claim | p95 <= 500 ms |
| delivery item durable -> 首次 send attempt | p95 <= 500 ms |
| 同 idempotency key 的 provider call count | exactly 1 |
| chat-wide overtakes | exactly 0 |

quiet/debounce 与模型本身生成时间不计入“修复新增延迟”。如 Cloudflare Queue dispatch 无法稳定满足 500 ms，验收报告必须拆出 durable-to-enqueue、enqueue-to-consume 与 consume-to-send，不能把平台时间归因给模型。

## 11. Additive schema 与迁移

建议下一 migration 为 `0061_tg_memory_reliability_v2.sql`，只做 additive schema、索引与 episodic trigger replacement：

1. `messages` 增加 publication / turn order 字段；旧行 backfill 为 `delivered`。
2. episodic insert trigger 增加 `publication_state IN ('source_received','delivered')` predicate；`delivered` transition 使用显式 projector 补建，不依赖 UPDATE trigger 猜测。
3. 新增 `inference_presentations`。
4. 新增 unified delivery sequence/item ledger；现有 outbox intent 表继续保存外部副作用状态。
5. `tg_chat_inference_runs` 增加 `delivery_seq`、`state_revision` 与 bounded terminal completeness。
6. `conversation_turn_events` 使用 role-specific event ID；不删除旧 event。

历史数据迁移规则：

- 现有普通 `messages` 为 `delivered`。
- 现有 TG run `completed` 对应 assistant 为 `delivered`。
- 现有 `delivery_pending` 必须联查 outbox/delivery batch：全 sent 才是 `delivered`，否则为 `generated_unconfirmed`。
- 现有 `attention_required` assistant 不得批量猜成 delivered；映射为 `delivery_unknown`，保留原文只供 Inspector。
- 无法建立 batch/message identity 的遗留行进入 migration exception table，不进入自动召回。

## 12. 实施 Gate

### Gate A — schema + shadow classification

- 合入 additive migration 与纯读 shadow classifier。
- 记录新旧状态差异，但所有线上读写仍走旧路径。
- 证明 tools/instructions/tool choice/breakpoints hash 与 baseline 相同。

### Gate B — outcome 与 presentation recovery

- 启用 R1/R2：晚到完成接管、pending presentation durable replay。
- 不改 delivery ordering 和 Memory publication。
- 先消灭“真实结果已落盘却仍提示重发”的误报。

### Gate C — publication state cutover

- 启用 R3；Telegram assistant 先写 generated，送达后再发布。
- 更新所有 rolling/episodic/semantic/Fact/Subject/Point 查询 predicate。
- migration exception 必须为 0 或逐项有明确处置，不能静默默认 delivered。

### Gate D — unified delivery order

- paragraph/result/final/media 先 shadow 写统一 ledger并比较顺序。
- shadow 证明无冲突后，唯一 claimant 切到 unified ledger。
- 旧局部 FIFO 表保留一个发布窗口作 rollback projection，不再拥有 send 权。

### Gate E — shared recall deadline + terminal completeness

- 启用 R5/R6。
- 不改变 3500 ms budget、召回算法、Top-K 或 prompt/cache wire。
- 只有 Gate E 验收通过后才允许删除旧分散 timeout / finish normalization 分支。

每个 Gate 分开 commit、分开 feature flag、分开部署 readback；不得将“代码合入”“migration 完成”“Worker 已部署”“Owner 实际收到”写成同一个完成状态。

最小 feature flags：

```text
TG_MEMORY_OUTCOME_V2_ENABLED
MEMORY_PUBLICATION_STATE_V2_ENABLED
TG_UNIFIED_DELIVERY_ORDER_ENABLED
MEMORY_RECALL_SHARED_DEADLINE_ENABLED
```

terminal completeness 随 `TG_MEMORY_OUTCOME_V2_ENABLED` 一起启用，避免再产生一条互相矛盾的 final 状态机。

## 13. 必须通过的故障注入矩阵

| 用例 | 期望 |
| --- | --- |
| Memory 240 秒后 completed，TG 已因旧 watchdog attention | 同 request hash 窄复活；原 response 送一次；provider call=1 |
| Memory completed 与 ready event 同时到达 | 一个 CAS 胜出；一个 final package；一次 delivery intent |
| attention 原因为 unknown Telegram send | 永不复活、永不重发未知 item |
| pending approval 的 Service Binding response 丢失 | 从 presentation ledger 重建同一审批卡；callback identity 不变 |
| Code Mode parked presentation 丢失 | 重放 parked presentation，不再调用模型或 Code Mode |
| assistant 已生成，Telegram 尚未成功 | Inspector 可见；rolling/episodic/semantic/Subject/Point 均不可见 |
| Telegram 明确成功 | publication CAS 到 delivered；各 projector 只入一次 |
| Telegram outcome unknown | publication 到 delivery_unknown；后续正常召回为 0 |
| finish_reason=length 且有正文 | 正文可见且标 partial；不写长期记忆；不自动续写 |
| finish_reason=error/unknown 且无正文 | 静态准确提示；不得伪装 stop |
| A final 因 429 pending，B 已生成 paragraph/result | B 可以完成计算，但任何 B payload 不得先于 A terminal |
| final batch completed 后、run completed 前 crash | 重入只对账状态，不再发送，run 收敛为 completed |
| imported summary 查询永久 pending | 整体 recall 在同一 3500 ms deadline 后继续，无额外尾等待 |
| unresolved assistant 位于 Owner A 与 Owner B 之间 | cache prefix 不变；suffix 为 Owner A, Owner B；送达后变 Owner A, assistant A, Owner B |

所有测试使用合成 fixture，不读取 Owner 私聊正文，不访问 Telegram、生产 D1 或付费 Provider。

## 14. Cache 不变量验收

每个实现 Gate 在合入前必须通过：

```text
npm run verify:cache-release
npm run predeploy:memory     # 仅当 Gate 触及 Memory Worker
npm run predeploy:tgbot      # 仅当 Gate 触及 Telegram Worker
```

并比较 baseline / candidate 的：

- effective tools hash；
- effective instructions hash；
- tool choice；
- cache breakpoints；
- final-render barrier wire；
- 已确认 canonical prefix hash；
- anchored_v3 模式与 binding。

hash 相同只证明静态 wire 未改，不能单独证明缓存连续。生产 Gate 仍需 Owner 自然连续两轮的 cache read/create 与 prefix coverage 证据；不得用 mock 或合成请求代替。

## 15. 可观测性与白盒 trace

新增 trace 只保存 bounded metadata：

```text
batch_key / correlation_id
memory_outcome_state + probe + recovery_source
presentation_kind + revision + replayed
publication_before -> publication_after
delivery_seq + item_seq + lane_wait_ms
terminal_completeness + normalized/raw finish reason
recall lane + elapsed_ms + deadline_remaining_ms + outcome
provider_call_count_for_idempotency_key
```

Inspector 必须能回答：

1. 模型什么时候完成？
2. TG 什么时候拿到 durable presentation/final？
3. 每个 payload 排在谁后面、为什么等待？
4. 用户是否明确收到？
5. 该 assistant 为什么进入或没有进入 rolling / episodic / semantic / Subject / Point？
6. watchdog 是否复用了原结果，还是发生了新 provider call？

不得记录 message body、prompt、provider response body、token、Secret 或 Telegram payload 正文。

## 16. Rollback

1. 所有 schema additive，不回滚 migration、不删除新状态行。
2. Gate B 回滚：关闭 `TG_MEMORY_OUTCOME_V2_ENABLED`；保留 presentation ledger 只读。
3. Gate C 回滚：关闭 publication cutover，但不得把已标 `delivery_unknown` 的 assistant 重新发布为 canonical。
4. Gate D 回滚：停止 unified claimant 后才恢复旧 claimant；同一时刻只能有一个发送 owner。
5. Gate E 回滚：恢复旧 recall orchestration，但 `length/error/unknown` 的真实 metadata 不得被数据迁移改写为 stop。
6. Worker 必须成对记录 deployed version、candidate commit 与直接 rollback version；Memory/TG 只有一侧满足新 schema 合同时不得切流。

## 17. Done 的定义

本修复只有同时满足以下条件才算完成：

1. R1-R7 的故障注入全部通过，provider call count 始终为 1。
2. chat-wide overtakes 为 0；没有用阻塞后续模型计算换取该结果。
3. generated/unconfirmed assistant 在所有普通 recall 和长期写入 lane 中命中为 0。
4. historical optional recall 不再越过现有 3500 ms 总 deadline。
5. `length/error/content-filter/unknown` 不再伪装为完整 `stop`。
6. anchored_v3 的静态 wire 与已确认 prefix 保持不变。
7. 生产 readback、Owner 自然 canary 与 rollback point 分别留证；任何自动测试都不能代替“Owner 确实收到且上下文未错乱”。
