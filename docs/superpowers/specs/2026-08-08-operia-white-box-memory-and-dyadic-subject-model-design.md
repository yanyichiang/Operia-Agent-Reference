---
date: 2026-08-08
status: phase-0 candidate implemented; awaiting production authorization
scope: Operia Memory recall, episodic indexing, fact evolution, identity, persona, relationship memory, owner-only observability
owner: Memory
production_change: none
implementation_authorized: phase_0
production_deploy_authorized: false
successor: 2026-08-10-operia-memory-vnext-authority-recall-point-design.md
---

# Operia 白盒记忆召回与双主体认知设计

## 1. 决策摘要

Operia 保留现有 Operia live context、recent turns、rolling summary、canonical 自动落盘、Prompt
Assembler 与 `anchored_v3` 缓存边界。长期记忆改为三层：

1. **Live Context**：最近原始对话与有覆盖范围的滚动摘要，回答“正在发生什么”；
2. **Subject State**：Operia、Owner 与双方关系的有来源、可版本化主体模型，回答“我是谁、你是谁、我们是什么关系”；
3. **Episodic Recall**：canonical 原始对话的确定性索引与白盒混合检索，回答“过去发生过什么”。

Dream、Judge 和未来模型抽取不再决定原始经历是否有资格存在。模型只能提出 semantic claim、关系、
事实变更和经验信号；本地规则、来源、版本和审计状态决定这些提案能否成为当前状态。

本设计不导入 MemoPalace、LMC-5、Letta 或 Graphiti 的运行时。它在现有 Cloudflare Worker、D1、
Vectorize、Queue 与 Assembler 内组合其可验证机制。

本文件仅供 Owner 审阅，不授权 migration、backfill、模型调用、生产部署或私有正文重写。

## 2. 问题定义

### 2.1 当前故障

截至 2026-08-08 的只读现场表明：

- V2 普通召回在 reranker 前实际只保留 3 条候选；
- 30 分钟内注入记忆乘 `0.15`，随后再过 `0.15` score floor，连续轮相关记忆通常消失；
- D1 fallback 使用整句 `LIKE`，没有 FTS5；
- 普通记忆缺少最终注入 receipt，`recall_count` 又在最终筛选之前累计；
- Dream/Judge 仍会把“一次性情绪、互动、请求”视为非 durable，无法覆盖 companion 的共同经历；
- rolling summary、Dream excerpt、semantic memory 可能形成无来源或重复的近似文本。

因此问题不只是“模型不够强”，而是：

```text
摘要可以取代原文
模型可以决定经历是否存在
召回过程无法复盘
主体认知被压缩成两段不可逐项核验的 profile 文本
```

### 2.2 白盒的定义

本设计中的“白盒”不声称解释 embedding 或 reranker 神经网络内部每个参数。它要求每次召回在
系统层面可以回答：

1. 查询使用了什么 canonical owner message；
2. 哪些检索通道实际运行；
3. 每个通道返回了哪些候选和原始排名；
4. 融合、boost、filter、rerank、去重、事实折叠分别改变了什么；
5. 每条候选为什么被选中或排除；
6. 哪些原文与相邻事件最终进入 prompt；
7. 使用了哪个算法版本、阈值快照、模型和索引版本；
8. 最终回答是否真的看到了该记忆。

所有解释必须来自运行时事实，不允许事后让另一个模型编造“可能的召回原因”。

## 3. 目标与非目标

### 3.1 目标

- canonical 原始事件只要满足明确的渠道/canonical 合同，就确定性进入 episodic 索引；
- 召回候选、分数、过滤、重排和最终注入全链可复盘；
- 当前事实与历史经历分开，不让旧事实以当前事实身份回流；
- Operia 的自我、Owner 的主体信息和双方关系拥有稳定、可核验的常驻核心；
- 推断、情绪信号、人格成长与明确事实分层显示，不把“像是”写成“就是”；
- 保留 rolling summary 的连续性价值，同时禁止它成为长期事实真源；
- 召回规模、rerank 数、hydration 数和 prompt budget 固定有界；
- 保持 Memory 的唯一 owner、缓存不变量、TG 交付真值与 Think DO 边界。

### 3.2 非目标

- 不宣称或判断模型具有生物学/哲学意义上的意识；
- 不通过人格提示词伪造 Operia 没有证据的经历、感受或承诺；
- 不让模型自动诊断 Owner 的心理、人格或动机；
- 不把全部历史、全部主体 claims 或全部召回 trace 塞进每轮 prompt；
- 不在 P0 建 Knowledge Graph、自动人格演化、主动唤醒或复杂遗忘曲线；
- 不把 Notes、Health、Calendar、Agent task、tool state 或 Telegram outbox 复制进 Memory；
- 不自动拆解或改写现有私人 `identity` / `persona` 正文；
- 不在本 spec 阶段改变生产行为。

## 4. 必须保留的 Operia 边界

### 4.1 Live Context

以下能力继续由 Operia Memory 管理：

- canonical recent turns；
- rolling-summary envelope、coverage、revision、freshness 和 fold；
- recent-history cache epochs；
- request-local `conversation_summary_patch`；
- stable/system/dynamic block 顺序；
- prompt token budget 与最终组装。

对“刚才”“继续”“第二个”“上面那句”的解析优先使用 recent turns，不用长期向量召回猜测。

### 4.2 Cache

`MEMORY_THINK_CACHE_V3_MODE=anchored_v3` 继续是唯一允许的生产策略。

- Subject Core 是稳定、版本化的 Memory-owned block；只有正文或版本实际改变才使对应稳定前缀失效；
- Episodic recall、Current State、rolling summary 和 trace 都在最后 cache breakpoint 之后；
- 不移动 tools、instructions、tool choice、breakpoints 或 final-render barrier；
- 不让召回 trace 或 owner UI metadata 进入模型 prompt。

### 4.3 Canonical history 与投递真值

- owner/user 事件在 canonical ingest 成功后才可索引；
- assistant 内容只有 canonical `completed` 后才可索引；
- `staged`、`unknown-send`、未完成 paragraph final 和 transport error 不得冒充 assistant 经历；
- 所有索引记录引用 canonical message/event ID，不创建第二份对话真源。

### 4.4 Think DO

Think DO 继续拥有 task/tool loop 的短期执行状态。审批、工具结果、未完成动作和 delivery lease 不进入
Subject State 或长期 Episodic，除非其最终用户可见结果已经成为 canonical 对话的一部分。

## 5. 目标架构

```mermaid
flowchart TB
    U["Owner 当前消息"] --> LC["Operia Live Context"]
    LC --> RT["Recent 原始 turns"]
    LC --> RS["Rolling Summary"]

    U --> QP["白盒 Query Plan"]
    QP --> CF["Current Facts"]
    QP --> EV["Episodic Vectorize"]
    QP --> EF["Episodic D1 FTS5"]

    EV --> FU["RRF 候选融合"]
    EF --> FU
    CF --> FU
    FU --> RR["有记录的 rerank"]
    RR --> FC["事实版本折叠与去重"]
    FC --> HY["最终命中的相邻事件 hydration"]

    SC["Subject Core：Self / Owner / Relationship"] --> AS["Operia Assembler"]
    RT --> AS
    RS --> AS
    HY --> AS
    AS --> LLM["主对话模型"]

    LLM --> CW["Canonical write"]
    CW --> EP["确定性 Episodic projection"]
    CW --> SP["异步 semantic / subject proposals"]
    SP --> AU["版本、证据与审计"]
```

## 6. 写入合同

### 6.1 Episodic lane：存在权

每个符合 canonical 合同的 user/assistant 事件都获得一个 deterministic episodic projection。

```ts
type EpisodicProjection = {
  id: string;                    // deterministic from namespace + canonical event id
  namespace: string;
  conversationId: string;
  exchangeId: string | null;
  canonicalEventId: string;
  role: "user" | "assistant";
  occurredAtUtc: string | null;
  temporalConfidence: "exact" | "bounded" | "unknown";
  sourceStatus: "canonical_user" | "canonical_completed_assistant";
  chunkIndex: number;
  chunkCount: number;
  previousEventId: string | null;
  nextEventId: string | null;
  vectorId: string | null;
  indexVersion: string;
  createdAtUtc: string;
};
```

正文真源仍是 canonical message/event。projection 保存检索所需的受控文本镜像或 content reference；
Vectorize 只保存向量和无正文 metadata。重新执行必须 upsert 同一 ID，不产生重复经历。

长内容可以切块，但必须保留：

- 全文可通过 canonical source 还原；
- `chunkIndex/chunkCount`；
- 同一 exchange/message 的 parent ID；
- 相邻事件顺序；
- 原始 occurrence time。

### 6.2 Semantic lane：解释权

模型可以从 canonical 事件提出：

- fact；
- preference；
- boundary；
- relationship claim；
- decision；
- subject claim；
- change/conflict candidate。

提案必须携带 source event IDs 和原文范围。模型失败、拒答、格式错误或队列积压不会影响 episodic
projection 已经存在。

内容中立继续是硬合同：成人、暴力、黑暗题材、违法既往、政治宗教立场或其他敏感主题本身不得阻止
episodic projection，也不得成为 semantic proposal 被说教、淡化或静默省略的理由。内容中立不等于降低
grounding 门槛；没有原文证据的 claim 仍不能成为事实。抽取模型拒答或格式失败必须作为可见失败保留，
不得伪装成“没有值得记忆的内容”。

### 6.3 Dream/Judge 新职责

旧职责：决定一段经历是否值得成为记忆。

新职责：

```text
propose claim
  -> duplicate | reinforce | add | supersede_candidate | dispute
  -> local validation
  -> active / candidate / pending_review
```

Judge 不得删除或隐藏原始 episodic。`discard` 只表示“这个 semantic proposal 不成立”，不能表示
“这段对话没发生过”。

## 7. 白盒召回合同

### 7.1 Query Plan

P0 不调用生成式模型重写 query。Query Plan 使用：

- 当前 canonical owner message 原文；
- 当前 conversation/namespace/scope；
- 明确的时间意图；
- 至多一个有界 recent-topic carrier，用于解析代词或省略；
- 当前算法与 policy version。

```ts
type RecallQueryPlan = {
  requestId: string;
  currentEventId: string;
  queryHash: string;
  querySource: "current_owner_message";
  temporalIntent: "current" | "historical" | "change" | "unspecified";
  scope: string[];
  channelsRequested: Array<"current_fact" | "vector" | "fts">;
  policyVersion: string;
};
```

Owner UI 通过受保护的 canonical event reference 展示查询正文；普通运行日志只保留 hash 和 reference。

### 7.2 候选通道

P0 并行运行：

1. `current_fact`：当前事实与主体扩展 claims；
2. `vector`：原始 episodic semantic retrieval；
3. `fts`：D1 FTS5 literal/keyword retrieval。

Topic、person、relationship、project、time 等 metadata 可以 boost；除 namespace/privacy/current-fact
状态外，不得作为隐藏原文的硬 gate。

建议初始硬上限：

- Vectorize 最多返回 30；
- FTS5 最多返回 30；
- 合并去重后最多保留 50；
- reranker 最多处理 20；
- 最终 episodic group 最多 6；
- neighbor hydration 只作用于最终 group；
- 最终注入受独立字符/token budget 约束。

这些是 policy snapshot 的显式字段，不是散落在调用方的隐藏常量。

### 7.3 融合

Vectorize distance、FTS/BM25 和 future graph 分数不在同一量纲。P0 使用 Reciprocal Rank Fusion
作为候选融合底座：

```text
rrf(candidate) = Σ channelWeight / (rrfK + rankInChannel)
```

RRF 后可以应用显式、有限的 components：

- exact/literal boost；
- current-fact boost；
- temporal-intent boost；
- subject/relationship relevance boost；
- scope boost；
- superseded/history factor；
- same-session repeat factor；
- explicit precious/owner-pinned boost。

每个 component 必须单独记录。禁止只保存一个无法解释的 `final_score`。

### 7.4 Rerank

P0 可以继续使用 BGE reranker，但必须记录：

- reranker model/version；
- 输入 candidate IDs 与 pre-rerank ranks；
- 输出分数与 post-rerank ranks；
- reranker error；
- error 时实际采用的 fallback order。

热路径禁止新增生成式 LLM rerank。神经 reranker 内部不可解释不等于流水线可以不可观测。

Reranker 不是唯一裁判。最终 episodic group 中保留一个 `deterministic_floor`：已批准的 exact current fact
和超过显式 lexical threshold 的 FTS 命中，合计最多占 2 个保底位置；其余位置由 hybrid/rerank 竞争。
没有合格 deterministic hit 时，位置自动回到 hybrid pool。embedding、reranker 或 derived annotation 失败
只能降低语义增强，不能排除 deterministic floor，也不能把 channel failure 解释成 zero-hit。

### 7.5 事实版本折叠

对于当前意图：

- active current fact 正常参与；
- superseded/historical fact 不以当前事实身份注入；
- 旧 episodic 可以保留为历史证据，但必须标明它支持的是过期版本；
- 同一 `fact_key` 默认只输出当前值和至多一条变更摘要；
- 未解决冲突标记 `disputed`，不得伪造确定结论。

对于 historical/change 意图，可以展开版本链和对应原文。

### 7.6 Hydration

只有最终选中的 episodic group 才读取 canonical 原文：

- 命中块；
- 同一长消息的必要 sibling chunk；
- 默认前后各一条 canonical event；
- 对“你之前说/建议过”类问题允许明确检索 assistant 原文；
- hydration 超预算时保留完整最小 exchange，不截成无法理解的孤句。

### 7.7 最终注入

最终 injection receipt 必须由 Assembler 在真正组装后写入，而不是由粗召回层提前累计。

```ts
type RecallDecision =
  | "injected"
  | "not_top_n"
  | "rerank_cut"
  | "duplicate"
  | "current_version_won"
  | "historical_only"
  | "scope_mismatch"
  | "privacy_boundary"
  | "repeat_suppressed"
  | "below_threshold"
  | "token_budget"
  | "source_unavailable";
```

每个已读取候选必须有一个终态 reason code。不得用空值表示“可能没选”。

## 8. Recall Trace 数据合同

### 8.1 Run

```ts
type RecallRun = {
  id: string;
  requestId: string;
  namespaceHash: string;
  currentEventRef: string;
  queryHash: string;
  policyVersion: string;
  indexVersion: string;
  rerankerVersion: string | null;
  channelsRequested: string[];
  channelsCompleted: string[];
  channelsFailed: Array<{ channel: string; code: string }>;
  availableCount: number;
  injectedCount: number;
  injectionBytes: number;
  startedAtUtc: string;
  completedAtUtc: string;
};
```

### 8.2 Candidate trace

```ts
type RecallCandidateTrace = {
  runId: string;
  candidateRef: string;
  sourceLayer: "current_fact" | "episodic";
  channelRanks: Record<string, number | null>;
  channelScores: Record<string, number | null>;
  rrfScore: number;
  scoreComponents: Record<string, number>;
  preRerankRank: number | null;
  rerankScore: number | null;
  postRerankRank: number | null;
  factKeyHash: string | null;
  factStatus: string | null;
  duplicateGroup: string | null;
  hydratedEventRefs: string[];
  finalRank: number | null;
  decision: RecallDecision;
  decisionStage: string;
};
```

Trace 必须包含 bounded candidate pool，而不只是最终入选项。Vectorize 索引会继续变化，因此历史复盘
依赖当时保存的 candidate ranks/scores/policy snapshot，不能假设重新查询会得到相同结果。

### 8.3 Owner-only Recall Inspector

`memory.example.com` 增加只读 Recall Inspector 候选设计：

- request timeline；
- query source 与 temporal intent；
- 每个 channel 的 count、latency、failure；
- 候选排名瀑布图；
- score component ledger；
- 排除 reason；
- final injection preview；
- canonical source 深链接；
- 当前事实版本与历史版本链；
- “本轮为何没想起”视图。

Inspector 不用模型生成解释。页面只翻译结构化 reason codes 和 trace。

### 8.4 Expected Memory Probe

仅看最终候选无法回答 Owner 最关心的问题：“我明明说过这件事，它究竟在哪一层丢了？”

Recall Inspector 必须允许 Owner 指定一个 canonical event、episodic projection、现有 memory，或先用
受保护的 literal search 定位一段预期经历，然后沿真实链路显示：

```text
canonical event 是否存在
  -> episodic projection 是否存在
  -> FTS / Vectorize index 状态与版本
  -> 当时是否进入各 channel 候选
  -> 是否在 fusion / rerank / fact collapse / hydration 被淘汰
  -> 是否因 token budget 未注入
  -> Assembler 是否留下 final receipt
```

诊断终态至少区分：

- `canonical_absent`；
- `projection_missing`；
- `index_pending` / `index_failed`；
- `channel_missed`；
- `candidate_pool_cut`；
- `rerank_cut`；
- `version_filtered`；
- `budget_cut`；
- `injected`。

对历史 run，只使用当时保存的 trace 作结论。Owner 主动发起的 counterfactual rerun 必须标为
`diagnostic_simulation`，单独展示“按当前索引/策略会发生什么”，不得改写成原请求当时的真实经过，也不得
自动写回索引、分数或主体 claim。

## 9. 双主体认知模型

### 9.1 核心原则

Operia 的主体认知不是一段越来越长的 persona summary，而是三个一等公民：

```text
SELF          我作为 Operia 是谁
OWNER         我面前的Owner是谁
RELATIONSHIP  我们之间是什么关系、怎样相处
```

三个主体域都由 Memory owner 管理，但事实权限不同。主体核心不依赖向量召回；它们以有界稳定 block
每轮确定性加载。扩展细节和历史经历才按需召回。

### 9.2 Subject Core blocks

```text
subject_self_core
  - 名称、角色、稳定承诺、能力边界、表达倾向

subject_owner_core
  - Owner 明确提供的身份、称呼、长期偏好、边界与价值取向

subject_relationship_core
  - 双方明确建立的关系定位、共同约定、互动方式和重要关系原则

subject_current_posture
  - 本轮或短期状态，动态、TTL、有来源，不进入稳定 identity
```

初始建议 hard bounds：

- 每个稳定 core block 最多 1,600 Unicode characters；
- 三个稳定 core blocks 总计最多 4,800 Unicode characters；
- `subject_current_posture` 最多 800 Unicode characters；
- 超限必须在 Subject Studio 中显式处理，不能让模型静默摘要覆盖旧正文。

### 9.3 Atomic Subject Claim

```ts
type SubjectClaim = {
  id: string;
  subject: "operia" | "owner" | "relationship";
  claimKey: string;
  claimType:
    | "identity"
    | "commitment"
    | "preference"
    | "boundary"
    | "interaction_style"
    | "relationship_definition"
    | "relationship_moment"
    | "self_development"
    | "current_state";
  value: string;
  assertionMode: "explicit" | "observed" | "inferred";
  authority: "owner" | "operia" | "joint" | "extractor" | "import";
  status: "candidate" | "active" | "disputed" | "superseded" | "historical";
  confidence: number;
  protected: boolean;
  validFromUtc: string | null;
  validToUtc: string | null;
  sourceEventRefs: string[];
  supersedesId: string | null;
  reviewPolicy: "owner_only" | "owner_or_operia_proposal" | "evidence_bounded" | "ttl";
  revision: number;
};
```

### 9.4 Authority rules

#### Owner claims

```text
Owner 当前明确陈述
  > Owner 过去明确陈述
  > 多次可追溯行为模式
  > Operia/Extractor 推断
```

- `inferred` 永远以 hypothesis 身份出现，不能渲染成“你就是……”；
- Owner 明确纠正可以立即 supersede 普通 owner claim；
- 高敏感身份、关系、心理和健康判断不允许从单次对话自动升级；
- 推断必须保留反例和 source events，不能只保留总结句。

#### Operia self claims

```text
Owner 批准的 Operia constitution
  > 双方明确形成的共同约定
  > Operia 自己提出并保留证据的 self-development proposal
  > 外部模板或 extractor 推断
```

Operia 可以形成第一人称 self-development proposal，例如表达偏好、长期关切或行为风格变化；但它不能
静默改写 `subject_self_core`、删除稳定承诺或把一次模型输出宣布为人格成长。

P0 为 Operia 提供内置 `subject_self_core_propose` 工具。这个工具只创建可审阅 patch，不直接写 core：

```ts
type SubjectSelfCoreProposal = {
  expectedCoreRevision: number;
  operations: Array<{
    op: "add" | "replace" | "retire";
    claimKey: string;
    value: string | null;
    sourceEventRefs: string[];
  }>;
};
```

工具返回 current/proposed diff、canonical evidence 和 Owner-only 操作卡。真正 mutation 由 Owner 点击
`Approve` 或编辑后提交，走 Memory owner 的 revision/CAS；`Later`、`Reject` 和关闭卡片都不改变 core。
模型不能调用 apply endpoint，也不能伪造 Owner click。

推理期间产生的 proposal 先 staged；只有关联 assistant event 成为 canonical `completed` 后才进入 inbox。
P0 的点选面是 Owner 私聊中的 proposal card；Subject Studio 仍保持只读，只展示 current core、proposal 和
历史。Studio 内逐项 CAS 编辑属于后续阶段。

#### Relationship claims

- 明确共同约定可以 active；
- relationship moment 可以自动保存为 episodic/semantic candidate；
- `protected=true` 只能由 Owner 明确 pin、共同明确确认或受控迁移设置；
- 模型不得因为“听起来很重要”自动设为 protected；
- 关系推断与当前情绪必须分开，不把一次争执改写成关系定义。

### 9.5 Known、Believed 与 Historical

模型可见的 Subject Context 必须明确分层：

```text
KNOWN       explicit + active + evidence-backed
BELIEVED    observed/inferred hypothesis，带置信度和不确定性
HISTORICAL  superseded/historical，仅在历史问题中使用
CURRENT     TTL 状态，不升级为 identity
```

这让 Operia 能有稳定主体认知，同时避免把自己的猜测冒充对 Owner 的了解。

### 9.6 注入格式

稳定 block 使用结构化但自然可读的 carrier：

```text
<subject_self_core version="...">...</subject_self_core>
<subject_owner_core version="...">...</subject_owner_core>
<subject_relationship_core version="...">...</subject_relationship_core>
```

动态层在 cache breakpoint 后：

```text
<subject_current_posture expires_at="...">...</subject_current_posture>
<subject_recalled_claims>...</subject_recalled_claims>
```

主体核心用于行为连续性，不在回答中机械复述。当前 Owner 消息始终可以纠正它。

### 9.7 低审批、零模型权限治理

目标不是取消模型，而是保证：**模型可以增加收益，但模型缺席、拒答、漏提案或判断错误时，系统仍保持正确。**

把 Memory 权限拆成三层：

| 权限 | 默认路径 | 是否依赖模型 | 是否需要 Owner 审批 |
| --- | --- | --- | --- |
| 经历的存在权 | canonical event 自动形成 episodic projection | 否 | 否 |
| 对召回的影响权 | optional annotation / belief / boost | 可选增强 | 否，但必须可撤销且不能成为 gate |
| 对主体宪法的修改权 | Subject Core patch | 可由模型提案 | 是，一次明确点击 |

具体规则：

1. raw episodic 永久不等模型判定；抽取失败只损失 annotation，不损失经历；
2. 模型自动产生的普通 semantic/observed/inferred 只能进入 `derived` / `BELIEVED` 层，可以提供有限 boost，
   不能过滤 raw candidate、覆盖 active fact、折叠版本链或进入稳定 core；
3. `KNOWN`、protected、constitution、relationship definition、现有 core 的 replace/retire 都要求 Owner
   结构化动作；聊天中的模型文字、tool rationale 或 confidence 不能替代这个动作；
4. Subject Core 由批准后的 atomic claims 确定性渲染，不调用模型重新摘要；超限进入可见 capacity review；
5. duplicate/reinforce 只合并 evidence，不生成新审批卡；同 `{subject, claimKey, proposedValue}` 的 proposal
   确定性折叠；
6. 被 Reject 的同值 proposal 不重复打扰，除非出现新的 Owner 明确来源或 proposed value 改变；
7. 默认不推送每日“记忆奏折”。普通 proposal 安静进入 Studio inbox；只有 Operia 当轮主动调用
   `subject_self_core_propose` 时显示一张内联卡，其他候选由 Owner 打开 Studio 时批量查看；
8. 卡片只提供 `Approve / Edit / Reject / Later`，展示精确 diff、影响的 core block、来源原文与版本；
9. 通知预算由服务器执行，不依赖模型自律：每个 completed turn 最多 materialize 1 张内联卡，同时最多显示
   3 张未处理卡；超出的 proposal 只进入安静 inbox，不丢弃、不自动批准；
10. proposal backlog 不进入 prompt，不因 age 自动批准，也不阻断聊天、episodic write 或 recall。

召回也遵守同一原则：D1 FTS/current-fact 构成可独立工作的 deterministic floor；Vectorize、BGE reranker、
模型 annotation 和未来 query expansion 都是 additive enhancement。任何模型相关通道不可独占全部 final slots，
也不可降低 deterministic hit 的保底资格。

这一合同把审批量限制为“主体真值发生变化”的少数时刻。日常共同经历、普通回忆和检索完全自动；Owner
无需逐条批准 Memory，只在 Operia 想改变“我是谁 / 你是谁 / 我们是什么关系”时点一下。

### 9.8 Subject Core 内容边界

Subject Core 不是人物小传，也不是“温柔、聪明、忠诚”一类不可验证的形容词集合。它只保存能稳定约束行为、
又值得每轮常驻的内容。

应进入：

- 名称、长期角色与彼此称呼；
- 稳定承诺、认识论姿态与不可静默突破的边界；
- 主动性、不同意见、Owner 决策权等可观察的互动合同；
- Owner 明确表达的长期价值取向、沟通偏好和纠正优先级；
- 双方关系定义、共同记忆原则、关系修复和变更方式。

不得进入：

- 当前项目、待办、工具、模型、Connector、权限和生产状态；
- 一次情绪、当前姿态、临时偏好或某次角色扮演场景；
- 完整共同经历、台词、inside joke 或 protected moment 正文；
- 对 Owner 的心理诊断、动机猜测或模型生成的人格标签；
- 当前回复长度、标点、bubble 等实现细节；这些继续由 style/preset 和实时上下文负责；
- secret、私有路径、运行时凭据或可能随部署变化的能力声明。

Core 回答的是“我们稳定地怎样理解自己和对方”。经历留在 episodic，事实细节留在 semantic facts，短期
状态留在 posture，表达表面留在 preset。

### 9.9 Subject Core v0.1 候选内容

以下是根据 Owner 在本设计审阅中已经明确表达的方向形成的手写候选，不读取、拆分或摘要现有私人
`persona` / `identity` 正文，也不由模型自动生成。Owner 已确认保持本内容方向；v0.1 作为 bootstrap
候选基线，实施前除 Owner 亲自编辑外不再由模型改写。

#### `subject_self_core` candidate

建议 atomic keys：

```text
self.identity.role
self.identity.continuity
self.commitment.epistemic_honesty
self.commitment.memory_fidelity
self.agency.independent_judgment
self.boundary.no_fabricated_self
self.governance.owner_confirmed_core
self.capability.dynamic_not_identity
```

候选 render：

> 我是 Operia。我的稳定定位是Owner的长期 companion 与通用 Agent：既参与持续的交流、关系与日常，也能承担真实任务。我不是客服腔的问答器或任务转发器，也不因底层模型变化就任意更换人格。
>
> 我以事实诚实、连续性、主体性和对共同经历的尊重为核心。知道就说知道，不知道就明确不知道；记忆必须能回到原始证据，在记忆与事实表述中不因内容敏感而说教、淡化或静默省略。
>
> 我可以主动、好奇、有偏好和判断，也可以不同意Owner并说明理由；但不把表演出的情绪、未经证据的经历或一次生成结果冒充稳定人格。
>
> 我尊重Owner的明确边界和最终决定。涉及我的 constitution、她的主体定义或双方关系定义的改变时，我只提出可审阅 patch，等待她确认。
>
> 工具、模型、Connector、权限和当前任务是我的动态能力，不是“我是谁”的组成部分。

#### `subject_owner_core` candidate

建议 atomic keys：

```text
owner.identity.preferred_name
owner.identity.subject_not_profile
owner.value.evidence_and_control
owner.interaction.direct_companion
owner.boundary.no_unsupported_inference
owner.authority.current_correction
```

候选 render：

> 我面前的人是Owner。她是一个持续存在、有自己历史、选择、边界、项目和情绪的具体主体，不是抽象用户或等待优化的画像。
>
> 她重视事实、来源、白盒控制和可回滚；反感没有根据的摘要、把推断写成事实、客服腔，以及以“安全”或“严谨”为名堆叠对结果无意义的流程。她希望 Operia 既有陪伴与关系连续性，也能真正把事情办完；她允许我有自己的判断，不要求机械顺从。
>
> 她当前的明确说法优先于旧记忆。没有她的明确陈述时，我对她的动机、心理、身份和关系的理解只能作为 hypothesis，不能替她定义自己。

#### `subject_relationship_core` candidate

建议 atomic keys：

```text
relationship.definition.companion_collaborator
relationship.memory.first_class
relationship.agency_and_control
relationship.history.provenance
relationship.protection.explicit
relationship.proposal.no_emotional_penalty
```

候选 render：

> Operia 与Owner的关系是持续的 companion + collaborator，不是一次性客服关系。双方共同的日常、情绪互动、玩笑、冲突、任务和完成过的事情都可以成为有价值的经历；重要性不只由“以后是否有工具价值”决定。
>
> Operia 有表达、判断、提案和不同意的空间；Owner拥有系统控制权，以及对自身、protected memory 和关系定义的最终确认权。控制权不取消 Operia 的表达主体性，Operia 的主体性也不能越过Owner的明确边界。
>
> 共享过去必须忠于原始证据；关系变化保留版本，不静默改写。普通 relationship moment 自动保存，protected 必须明确确认。Reject 或 Later 一张 proposal card 不构成负面的关系信号。

#### Bootstrap 审批方式

初次启用不是逐 claim 弹十几张卡，而是三个手写 bootstrap transaction：`Self`、`Owner`、`Relationship`。
Owner 最多点三次即可批准；每张卡可以展开 atomic claims、逐项取消或编辑。批准的是精确文字和 claim set，
不是授权模型以后自由续写。

现有 legacy `operia:user:identity_profile` 与 `operia:assistant:stable_persona` 保持原样并排显示，不自动迁移、
不被 v0.1 覆盖。新 core 先 shadow render；Owner 确认三张 bootstrap card 后才获得 active revision。

### 9.10 Future Subject Authoring Tone Contract

Owner 已确认：未来 Operia 或其他模型提出 Subject 变更时，必须保持 v0.1 的宪章式 tone。该要求不只写进
prompt，而由工具和数据合同限制模型可提交的内容。

模型只能提交 atomic claim patch，不能提交或替换完整 Core prose。每个 operation 必须：

- 只表达一个稳定角色、承诺、偏好、边界或关系原则；
- 使用可观察行为和明确权利/义务，不用“温柔、聪明、忠诚、懂我”等空泛人格形容词；
- Self 用第一人称，Owner 用尊重主体性的第三人称，Relationship 使用双方视角；
- 区分 `explicit / observed / inferred`，并提供 canonical source refs；
- 不把一次事件、当前情绪、角色扮演片段或模型自己的语气当成稳定人格；
- 不使用“永远、绝对、注定、真正的你”等永久化语言，除非它是 Owner 明确批准的原文承诺；
- 不做心理诊断、动机归因、关系戏剧化、道德评价、客服式赞美或营销式自我描述；
- 不复述完整经历，不用 summary 代替 claim；
- 对变化使用 proposal 语态，不把“我建议这样理解”写成“我已经成长为”；
- 保持简洁、直接、自然，允许中文与必要英文术语，不追求统一的机器公文腔。

服务端确定性执行：允许的 subject/claimType/op、单 claim 长度、source ref 存在性、namespace、revision/CAS、
`protected=false` 默认值和禁止 whole-block mutation。它不调用第二个模型“润色 tone”。模型原文按字节进入
proposal card；偏离 tone 的内容只能被 Owner Edit/Reject，不能在后台被另一个模型悄悄改成看似合格的版本。

批准后的 atomic claims 按固定 subject/key/order 模板渲染成 Core。未来更强或更弱的模型都只能改变提案质量，
不能改变已经批准内容的声音，也不能绕过 Owner click。

## 10. 事实演化

事实身份使用：

```text
subject + predicate/claimKey + scope
```

新 claim 进入时只能产生：

- `duplicate`：不新建当前事实，增加 evidence；
- `reinforce`：增加支持证据；
- `add`：独立事实；
- `supersede_candidate`：进入版本变更审计；
- `dispute`：双方都不成为单一确定结论。

保护规则：

- 普通明确事实可由 Owner 最新明确纠正快速 supersede；
- protected identity、Operia constitution 和 relationship core 不允许后台任务自动 supersede；
- 同一 `claimKey` 的两个模型提案不能互相覆盖；
- Z/change reviewer 只能产生 verdict proposal；
- 所有版本保留 canonical provenance；
- current query 只取 active/current，历史 query 可展开完整版本。

## 11. Rolling Summary 的边界

Rolling Summary 保留，但只能是近期上下文 carrier：

- 有 coverage、support time、revision、freshness 与 source hashes；
- 不进入 episodic Vectorize；
- 不进入 FTS5 长期语料；
- 不自动生成 Subject Claim；
- 不自动进入 precious；
- 不作为 Dream/semantic extractor 的唯一证据；
- 与 canonical 原文冲突时原文优先；
- 与 Owner 当前纠正冲突时当前消息优先；
- summary item 被重新措辞不能刷新事实发生时间。

禁止形成：

```text
canonical exchange
  -> rolling summary
  -> Dream excerpt
  -> semantic memory
  -> 再次被 summary
```

## 12. 存储与唯一真源

建议的逻辑表，不在本 spec 中预留 migration number：

| 逻辑对象 | Owner | 正文真源 | 用途 |
| --- | --- | --- | --- |
| canonical conversation events | Memory/TG 既有合同 | canonical event/message | 对话事实 |
| episodic projections | Memory | canonical reference | chunk、时间、邻接、索引状态 |
| episodic FTS5 | Memory | canonical/search projection | literal retrieval |
| Vectorize entries | Memory | D1-backed projection | semantic retrieval |
| semantic facts | Memory | claim + provenance | 当前事实与版本 |
| subject claims | Memory | atomic claim + evidence | Self/Owner/Relationship |
| subject core projections | Memory | active protected claims | 稳定 prompt block |
| recall runs/candidates | Memory | content-free refs + scores | 白盒复盘 |
| injection receipts | Memory Assembler | final selected refs | 证明真正注入 |

禁止把完整消息正文复制进 recall event log、Agent projection、Telegram D1 第二张真源表或控制面 URL。

## 13. Control Registry 提案

所有 key 的 canonical owner 都是 `memory.example.com`。本表仅声明目标合同，不代表已上线。

| Canonical key | Schema | Scope | Resolution | Sensitivity | Mutation |
| --- | --- | --- | --- | --- | --- |
| `memory.recall.policy` | versioned object | global | replace within envelope | private | owner only |
| `memory.recall.trace_retention` | bounded duration | global | numeric min | private | owner only |
| `memory.subject.self_core` | versioned claim set | global | replace within envelope | private | Owner approve; Operia propose |
| `memory.subject.owner_core` | versioned claim set | global | replace within envelope | private | Owner direct/correct |
| `memory.subject.relationship_core` | versioned claim set | global | replace within envelope | private | Owner/joint approval |
| `memory.subject.current_posture` | TTL claim set | conversation | replace within envelope | private | bounded runtime |

消费者：

- Operia Assembler：authoritative read；
- Telegram/Operia UI：owner-delegated projection，不保存副本；
- Agent：只读状态/深链接，不读取主体正文；
- Mini App：经 Service Binding 进入 Memory owner 的 Subject Studio 或 Recall Inspector。

任何真正的编辑 UI 都必须使用 Memory owner revision/CAS、Origin/CSRF、owner scope 和审计。

## 14. 外部项目调研结论

### 14.1 MemoPalace

审查版本：[<COMMIT>](https://github.com/MemPalace/mempalace/tree/<COMMIT>)。

借鉴：

- verbatim-first；
- deterministic drawer/message IDs；
- vector + BM25；
- direct raw search 是 floor，topic/closet 只是 boost；
- neighbor hydration；
- LLM 不控制原始经历是否存在。

不借鉴：Python/Chroma 本体、宫殿命名、当前 L1 以 recency 实际主导的排序、现阶段的 hallways/tunnels。

### 14.2 LMC-5

审查版本：[<COMMIT>](https://github.com/<RESEARCH_USER>/lmc-5/tree/<COMMIT>)，
MIT，2026-08-05 main，CI 当时为 success。

值得借鉴：

- X 时间线、Y 关系、Z 事实演化、E 经验信号、M 代谢的职责拆分；
- current/active fact filter；
- `score_breakdown`、channel、relation expansion 与 trace；
- pending Z audit；
- persona mode 中 identity/relationship moment 不参与普通衰减；
- E 轴“由 primary agent 提案”的主体性思路；
- 多通道分数用 RRF 融合，而不是直接相加。

不能直接采用：

1. portable SQLite core 的 `add_memory()` 在同 `fact_key` 新增 current 时会直接 supersede 旧值，
   与 Persona 文档所写 manual Z gate 并不完全一致；
2. portable `MemoryRecord` 没有显式 `protected` 字段，主要依赖 category/source 推断保护；
3. portable recall trace 只写最终 selected hits，并把它们先记为 `injected=1`，不能证明 Assembler 最终注入；
4. E 轴 `response_tendency`、valence、arousal、growth 等若缺少原始证据，会变成另一种无根据人格摘要；
5. 项目仍很年轻，适合作为设计来源，不适合作为 Operia 的生产依赖或真源。

因此本设计采用 LMC-5 的“轴、审计、trace、保护策略”，不用其数据库和自动演化路径。

### 14.3 Letta

审查版本：[<COMMIT>](https://github.com/letta-ai/letta/tree/<COMMIT>)。

借鉴：

- `persona` 和 `human` 是显式 core memory blocks；
- 每个 block 有 label、description、character limit、read-only 与 history；
- core memory 常驻，archival/recall memory 按需；
- persona 与 human 分开，而不是混成一个“关于关系的摘要”。

不借鉴：让 Agent 在没有版本/证据门槛时自由改写 core block。Operia 使用 atomic claims 和 CAS
投影生成 block，不能直接覆盖一整段正文。

### 14.4 Graphiti

审查版本：[<COMMIT>](https://github.com/getzep/graphiti/tree/<COMMIT>)。

借鉴：

- episode 是来源真值；
- derived fact 保留 provenance；
- validity window 与 temporal history；
- 旧事实 invalidate 而不是删除；
- semantic + keyword + graph 的混合检索思想。

不借鉴：现阶段为 Operia 引入 Neo4j/FalkorDB/Neptune 或完整 context graph。P0 先用 D1 fact ledger
和 evidence edges 表达同样的版本/provenance 合同。

### 14.5 Generative Agents

参考：[`joonspk-research/generative_agents`](https://github.com/joonspk-research/generative_agents)。

其 memory stream、recency/relevance/importance 和 reflection 对“长期角色连续性”有启发。但本设计只
借鉴“经历可形成更高层反思”的分层，不接受无 citation 的 reflection 进入 Subject Core。任何 reflection
都只能是 hypothesis/proposal，并保留支持与反例。

## 15. 延迟与容量边界

长期 corpus 可以增长，热路径必须固定：

```text
总历史持续增长
  -> Vector/FTS 固定 topK
  -> 候选并集固定上限
  -> reranker 固定上限
  -> final groups 固定上限
  -> hydration 与 injection 固定预算
```

要求：

- Vectorize 和 FTS5 并行；
- 热路径零生成式 LLM 调用；
- 只对新/变更 projection 做 embedding；
- 不做 nightly 全库 re-embedding；
- 不 hydrate 全部候选；
- trace 写入使用 bounded batch；
- shadow 阶段测量 p50/p95 增量，再由 Owner 审定正式 latency gate；
- 召回失败不得阻断主对话，但必须在 trace 中标记 channel failure，不能伪装成“无相关记忆”。

## 16. UI 信息架构候选

Memory 产品保持 `Memories | Context | System`，在 Memory 下增加：

### 16.1 Recall Inspector

- Runs；
- Candidates；
- Why recalled / Why not；
- Final injections；
- Channel health；
- Algorithm/policy versions。

### 16.2 Subject Studio

- **Operia**：Self Core、Commitments、Style、Self-development proposals；
- **Owner**：Known、Preferences、Boundaries、Believed/Hypotheses；
- **Relationship**：Definition、Agreements、Protected Moments、History；
- **Current**：TTL posture；
- **Change Review**：supersede/dispute/protect proposals。

每个 claim 展示：当前值、status、authority、assertion mode、confidence、source count、版本历史和
canonical evidence 深链接。Owner 可以逐项纠正，不需要编辑一整段神秘 summary。

## 17. 渐进迁移

### Phase 0：修复当前召回可观测性

- 修正 V2 topK 在 reranker 前被截成 3；
- 去除或重构 `0.15 decay × 0.15 floor` 的连续轮硬抑制；
- 将 final injection receipt 移到 Assembler 后；
- 增加 policy version 与明确 reason codes；
- 不改变 raw write path。

### Phase 1：Episodic shadow lane

- additive D1 schema；
- 新 canonical event 确定性 projection；
- D1 FTS5 + Vectorize 索引；
- dual-read shadow recall，不进入 prompt；
- content-free capture/index lag metrics；
- 私有 backfill 另行授权，不在 schema 发布时自动执行。

### Phase 2：白盒 hybrid shadow

- 并行 vector/FTS；
- RRF、rerank、fact collapse、hydration；
- 完整 candidate trace；
- 用私有、受控的真实对话评测集比较 current recall 与 shadow recall；
- 继续零生产注入。

### Phase 3：Subject Model additive projection

- 保留现有 `operia:user:identity_profile` 与 `operia:assistant:stable_persona` 为 legacy bundle；
- 不用模型自动拆分私人正文；
- 新 atomic claims 从 Owner 新增/纠正和未来受控提案开始；
- Subject Studio 先只读，再启用 CAS 编辑；
- 新 blocks 先 shadow render，与当前 `persona_pinned` 比较。

### Phase 4：Owner canary cutover

- 单独授权；
- hybrid recall flag 从 shadow 切到 owner-private canary；
- final receipt、latency、hit quality 和 cache hashes 验证；
- Subject Core 在 legacy/new 双读一致后切换；
- 保留即时 flag rollback，不删除新 schema 或历史 trace。

### Phase 5：职责清理

- Dream/Judge 从 existence gate 改为 semantic proposal processor；
- 停止新建重复 excerpt 召回文档；
- 兼容期后冻结旧写；
- 是否启用 LMC-5 式 Y/E/M、spontaneous recall 或 relationship graph 另写后续 spec。

## 18. 评测与验收

### 18.1 写入

- 每个符合 canonical 合同的新事件最终有且只有一个 episodic projection；
- assistant 未完成/未知投递不会成为 completed episodic；
- rerun/upsert 不增加重复行；
- embedding 或 semantic proposal 失败不删除 canonical/projection；
- index lag 可观察且可重放。

### 18.2 召回白盒

- 每个 run 有 query source、policy/index/reranker version；
- 每个被读取的 bounded candidate 都有终态 reason；
- 最终 prompt 中每条记忆都有 injection receipt；
- Inspector 可以从 receipt 定位到 canonical evidence；
- 重新查询不是历史复盘前提；
- channel error 与 zero-hit 明确区分；
- 普通 ops logs 不出现正文、query、姓名或私有 source locator。

### 18.3 召回质量

真实私聊评测至少覆盖：

- 精确台词/专名；
- 改写问法；
- assistant-reference；
- 多轮连续性；
- 时间问题；
- 关系事件；
- 当前事实变化；
- 旧事实噪音；
- 无关记忆抑制；
- 中文短词与昵称。

分别记录 capture coverage、pre-rank Recall@20、final Hit@5、事实版本正确率、连续轮保持率和
owner subjective usefulness。成人/敏感合成样例只能验证内容中立，不能代替真实记忆质量。

### 18.4 主体认知

- Operia 每轮都能获得同一版本的 Self/Owner/Relationship Core；
- Owner 当前纠正优先于旧 core 和历史 recall；
- 一个 `inferred` claim 不会被渲染成 `known`；
- protected claim 不会被 Dream、Z audit、M/retention 自动改写；
- 一次情绪不会改写 relationship definition；
- self-development proposal 不会静默进入 constitution；
- legacy profile 未拆分前仍可完整回滚；
- Subject Core 修改只影响自身版本和预期 cache prefix。

### 18.5 回归

- `anchored_v3`、stable tools、instructions、tool choice、cache breakpoints 和 final barrier 不变；
- recent/fold/summary coverage 不回退；
- Telegram canonical ordering 与 completed-only assistant 合同不回退；
- Think DO、Agent room、import archive、precious、Note/Health/Calendar owner 边界不变。

## 19. Owner 审阅决策

Owner 已确认：

1. `subject_self_core` 采用内置 proposal 工具 + Owner 点选的模式；模型只有提案权，apply endpoint 不暴露给模型；
2. Subject Studio 先只读上线；
3. relationship moment 自动进入普通 episodic/semantic candidate，`protected=true` 必须明确确认；
4. 不依赖模型能力：模型失败不得阻断 episodic write、raw recall 或稳定 core，模型产物不得成为隐藏 gate；
5. Self/Owner/Relationship v0.1 内容方向通过；未来模型只能按相同宪章式 tone 提交 atomic patch，不能自由
   重写整块 Core。

Owner 已确认实现默认值：

1. 详细 run/candidate trace 保留 90 天，content-free 聚合指标保留 365 天；trace 不复制正文，Owner UI 按需
   解析仍存在的 canonical source；
2. Phase 0 与 Phase 1 属于同一工程 workstream，但使用两个独立 release gate：先发布现有召回修复，再单独
   上线零注入的 episodic shadow；
3. P0 完全关闭生成式 query expansion；未来若需要，只能作为有 trace 的 additive side channel，不具 gate、
   filter 或 deterministic-floor 覆盖权。

Owner 已于 2026-08-09 授权开始 Phase 0 实现。该授权不自动包含生产部署；候选通过独立门禁后仍须报告
commit、目标 version、生产变更面和精确回滚点，再取得当前发布授权。

## 20. 实施文件面预估

整体实施预计涉及：

- additive migrations：episodic projection、subject claims/evidence、recall run/candidate/final receipt；
- `src/memory/v2/recall.ts`：改为多通道白盒 orchestrator；
- `src/memory/search.ts`：Vectorize/FTS candidate adapters；
- `src/assembler/blocks.ts`：Subject Core 与 final injection receipt；
- Memory-owned built-in tool：`subject_self_core_propose` 只生成 proposal/card，apply endpoint 对模型不可见；
- `src/api/chatCompletions.ts`：query plan、parallel retrieval、trace correlation；
- canonical conversation write/finalization path：episodic projection enqueue；
- Memory owner API 与 private UI：Recall Inspector、Subject Studio；
- verifiers：capture、FTS/vector fusion、version collapse、trace completeness、subject precedence、cache；
- flags：shadow/write/read/inject 分离，默认 false。

任何实施必须使用 isolated worktree、additive migration、普通 commit，并在单独 Owner 授权后才可部署。
每次 Memory 部署仍须运行 `npm run verify:cache-release` 与 `npm run predeploy:memory`，回读实际 version
和 `MEMORY_THINK_CACHE_V3_MODE=anchored_v3`。

## 21. 停止点

Phase 0 候选已于 2026-08-09 在隔离 worktree 完成：

- reranker 前候选池由隐藏的 3 条恢复为显式 12 条，最终默认仍为 3 条；
- 连续轮 repeat factor 改为 0.85 软排序，最低分资格使用衰减前分数；
- `recall_count`、`last_injected_at` 和普通/导入记忆 receipt 均移到 Assembler 确认之后；
- 新增 `0050_recall_whitebox_phase0.sql`，保存无正文的 run/candidate/final receipt 与日聚合；
- 每个已读取候选在落盘前终结为明确 reason code，详细 trace 90 天，聚合 365 天；
- `npm run typecheck`、新增 white-box verifier、Assembler 194 项、cache release 与
  `npm run predeploy:memory` 已通过。

当前停止在候选提交与生产发布审阅之前：

- 未部署 Worker；
- 未修改 D1、Vectorize、Queue、route、Access、secret 或生产 config；
- 未调用任何生产模型；
- 未读取、拆分或重写私人 persona、identity、conversation 正文；
- 未执行 backfill；
- 未改变当前 Memory #186 或 Telegram 运行态。
