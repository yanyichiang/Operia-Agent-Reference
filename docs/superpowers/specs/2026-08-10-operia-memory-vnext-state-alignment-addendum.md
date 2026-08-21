---
date: 2026-08-10
status: owner-reviewed normative addendum; Gate A-E production shadow deployed
scope: query-conditioned state alignment, revision-link expansion, state evidence packet, ghost-memory verification
owner: Memory
parent: 2026-08-10-operia-memory-vnext-authority-recall-point-design.md
research_basis: A-TMA: Decoupling State-Aware Memory Failures in Long-Term Agent Memory, arXiv:2607.01935v2
implementation_authorized: gate_a_through_e_shadow
implementation_status: production_shadow_deployed
production_deploy_authorized: true_for_shadow_only
production_packet_injection_authorized: false
---

# Operia Memory vNext.1 补充合同：Query-conditioned State Alignment 与 Ghost Memory 防线

## 0. 文档状态与适用关系

本文件是 `Operia Memory vNext.1：可执行权威状态机与 Evidence-carrying Receipt` 的规范性补充，不替代父 Spec，
不改变 Gate A/B 的总体方向。Owner 于 2026-08-10 先授权 Gate C-E 独立候选实现，随后明确授权 Gate A-E 合入
main、执行远程 additive D1 migration 并发布 production shadow。该生产授权不包含 backfill、真实模型调用、
Owner-private canary 或 `memory_state_packet_inject` 启用；旧 recall、Assembler 与 prompt 注入保持不变。

本补充只解决一个缺失层：

```text
Fact/Point revision 自身处于什么状态
  -> 当前查询请求查看哪个时间状态
  -> 候选在本轮应扮演什么角色
  -> 哪些 predecessor / successor / transition 必须进入候选池
  -> 最终 prompt 中哪些状态进入前景、对照、变化轨迹或争议集合
```

父 Spec 已经规定 authority、canonical evidence、bitemporal revision、protected mutation、lineage、
deterministic Query Plan、EvidenceBundle、RecallReceipt 与非 LLM verifier。本补充不重新定义这些权利，
而是保证存储层已经正确保存的新旧事实，不会在召回、排序或回答阶段重新混成 ghost memory。

发生冲突时：

1. canonical existence、authority、protected impact、Owner confirmation、CAS、secret、deletion 与 evidence lineage
   继续以父 Spec 为准；
2. query-relative state role、revision-link expansion、state packet 与 ghost-memory 分层验收以本补充为准；
3. 本补充中的任何 query role 都不能改变 FactRevision、PointRevision 或 Subject revision 的持久状态。

## 1. 结论与设计决议

A-TMA 最值得吸收的不是 Learned Sentry、额外在线 Retrieval Controller、Qwen Judge 或论文阈值，而是以下系统
不变量：

> 新旧事实的状态角色必须从 revision store 贯穿 candidate construction、fusion、packet packing、render 和
> receipt；数据库里存在时间戳、superseded 字段或 revision relation，并不等于回答阶段会正确使用它们。

Operia 采用三个最小增量：

1. `QueryStateProjection`：确定性描述一个候选相对于本轮 query view 应扮演的角色；
2. `RevisionExpansionArtifact`：在最终 fusion/Top-K 之前，沿强 revision relation 有界补齐 predecessor、
   successor、transition、scope exception 与 unresolved contradiction；
3. `StateEvidencePacket`：把 primary state、历史对照、变化链与争议集合以结构化、原子化的 packet 交给
   Assembler，并在 RecallReceipt 中记录每条证据的 query-relative role。

不引入新的生产模型依赖，不允许模型覆盖 state role，不允许 unbounded graph traversal，不允许状态标签成为
唯一正确性保障。

## 2. 术语与正交维度

### 2.1 Intrinsic state

`Intrinsic state` 是 revision 在指定 transaction snapshot 下自身具有的状态，与当前查询无关：

```text
lifecycle:
  current | historical | superseded | retracted | deleted

epistemic:
  known | believed | disputed

valid time:
  该 assertion 在现实世界中被声明为何时有效

transaction time:
  Operia 在哪个 commit sequence 中持有该 revision
```

这些状态由 Gate C 的 FactRevision、FactRevisionRelation、PointRevision 或后续 Subject revision 合同提供。

### 2.2 Requested state view

`Requested state view` 是 Query Plan 对本轮问题的确定性时间视图：

```ts
type RequestedStateView =
  | "current"
  | "historical"
  | "change"
  | "unspecified";
```

父 Spec 的 `RecallQueryPlan.temporalIntent` 继续作为该字段的唯一来源。不得增加一个由模型生成的平行
`query state profiler`。

为保证相对时间和历史 replay 可重算，`RecallQueryPlan` 增加：

```ts
type TemporalTarget = {
  requestedStateView: RequestedStateView;
  referenceTimeUtc: string;
  ownerTimeZone: string;
  targetValidFromUtc: string | null;
  targetValidToUtc: string | null;
  targetTimePrecision:
    | "exact"
    | "day"
    | "month"
    | "year"
    | "bounded"
    | "unknown";
  basis:
    | "query_explicit"
    | "relative_time_resolved"
    | "current_request_time"
    | "unspecified";
};
```

所有 interval 使用半开区间 `[valid_from, valid_to)`。`historical` 查询没有可确定目标区间时，不得由模型猜测；
应保持 `targetTimePrecision="unknown"`，并在 trace 中暴露降级。

### 2.3 Query-relative role

Query-relative role 不能用一个 `current_support | historical_support | material_contradiction` 枚举混合所有概念。
以下三个维度必须正交保存：

```text
intrinsic lifecycle / epistemic state
evidence polarity
query presentation role
```

同一条 historical revision 可以支持历史查询，也可以反驳另一个 historical claim；同一条 current revision
在历史查询中可能只是 successor contrast，而不是 primary answer。

## 3. 新增数据合同

### 3.1 QueryStateProjection

```ts
type QueryStateProjection = {
  projectionId: string;
  runId: string;
  queryPlanHash: string;
  txnSnapshotSeq: number;

  candidateRef: string;
  sourceRevision: number;
  claimAtomId: string | null;

  requestedStateView: RequestedStateView;

  intrinsicLifecycleStatus:
    | "current"
    | "historical"
    | "superseded"
    | "retracted"
    | "deleted";

  intrinsicEpistemicStatus:
    | "known"
    | "believed"
    | "disputed";

  queryRole:
    | "primary"
    | "contrast"
    | "trajectory"
    | "context"
    | "exclude";

  evidencePolarity:
    | "supports"
    | "contradicts"
    | "qualifies"
    | "neutral";

  validTimeFit:
    | "exact_match"
    | "overlap"
    | "mismatch"
    | "unknown"
    | "not_applicable";

  roleBasisRevisionIds: string[];
  roleBasisRelationIds: string[];
  ruleCodes: string[];

  projectionVersion: string;
  artifactHash: string;
  createdAtUtc: string;
};
```

规范：

1. `QueryStateProjection` 由 Harness 代码根据同一 `txnSnapshotSeq` 下的 revision、relation、valid interval、
   Query Plan 与 authority-valid evidence 派生；
2. Judge、reranker、extractor 与回答模型均无权写入或覆盖；
3. projection 只决定本轮 retrieval/render role，不修改持久 revision；
4. `exclude` 必须保留结构化 reason code，不能从 trace 中消失；
5. 相同输入 snapshot、Query Plan、projection version 必须产生相同 artifact hash。

### 3.2 RevisionExpansionArtifact

```ts
type RevisionExpansionArtifact = {
  artifactId: string;
  runId: string;
  queryPlanHash: string;
  txnSnapshotSeq: number;
  requestedStateView: RequestedStateView;

  seedCandidateRefs: string[];

  traversedRelations: Array<{
    relationId: string;
    relation:
      | "STATE_CHANGE"
      | "RETROACTIVE_CORRECTION"
      | "SCOPE_CLARIFICATION"
      | "EPISTEMIC_RETRACTION"
      | "MERGES"
      | "SPLITS";
    fromRevisionId: string;
    toRevisionId: string;
    direction: "forward" | "backward";
    rootSeedRef: string;
    ruleCode: string;
  }>;

  addedCandidates: Array<{
    candidateRef: string;
    sourceRevision: number;
    rootSeedRef: string;
    relationId: string;
    expansionReason:
      | "active_successor"
      | "historical_predecessor"
      | "transition_endpoint"
      | "scope_exception"
      | "merge_split_peer"
      | "material_contradiction";
    deterministicFloor: boolean;
  }>;

  omittedCandidates: Array<{
    candidateRef: string;
    reason:
      | "hop_limit"
      | "candidate_cap"
      | "scope_mismatch"
      | "time_mismatch"
      | "source_missing"
      | "privacy_boundary"
      | "deleted_or_purged";
  }>;

  hopLimit: number;
  candidateCap: number;
  completeness:
    | "complete_within_policy"
    | "truncated_by_hop_limit"
    | "truncated_by_candidate_cap"
    | "source_incomplete";

  expansionVersion: string;
  artifactHash: string;
  createdAtUtc: string;
};
```

规范：

1. expansion 输入只能来自已落盘的 bounded lane seed artifacts；
2. expansion 发生在最终 lineage collapse、global fusion、optional rerank 与 final Top-K 之前；
3. strong revision relation expansion 优先于 weak semantic neighbor 扩张；
4. `deterministicFloor=true` 的 successor、predecessor、transition endpoint、scope exception 或 material
   contradiction 不能被 reranker 删除；
5. traversal 必须有 hop/candidate cap、明确 omission reason 和 completeness，不允许“扩展所有关系”；
6. expansion 不能跨 namespace、authority、secret、deleted/purged 或 protected visibility boundary；
7. dense revision chain 超限时保留当前 view 所需的最近完整状态组，不得静默截断后伪装为完整。

初始 shadow policy 可采用：

```text
revision_expansion.hop_limit = 2
revision_expansion.candidate_cap = 16 / root claim atom
```

以上仅为 versioned policy default，需在 shadow trace 后校准；任何数值调整不得取消 deterministic floor 或
packet atomicity。

### 3.3 StateEvidencePacket

```ts
type StateEvidencePacket = {
  packetId: string;
  runId: string;
  queryPlanHash: string;
  txnSnapshotSeq: number;
  requestedStateView: RequestedStateView;

  groups: Array<{
    groupId: string;
    groupKind:
      | "PRIMARY_STATE"
      | "STATE_TRANSITION"
      | "MATERIAL_CONTRAST"
      | "DISPUTE_SET"
      | "CONTEXT";

    atomicity:
      | "ALL_REQUIRED"
      | "ANY_SUFFICIENT";

    candidateRefs: string[];
    projectionIds: string[];
    evidenceBundleIds: string[];
    revisionRelationIds: string[];

    // complete/included group 才能进入 deterministic renderer；false 只保留 omission audit。
    included: boolean;

    completeness:
      | "complete"
      | "incomplete";

    omissionReason:
      | null
      | "incomplete_relation_chain"
      | "incomplete_evidence"
      | "token_budget"
      | "byte_budget"
      | "source_unavailable"
      | "privacy_boundary";

    groupHash: string;
  }>;

  packetVersion: string;
  packetHash: string;
  totalBytes: number;
  estimatedTokens: number;
  createdAtUtc: string;
};
```

规范：

1. `STATE_TRANSITION` 默认是 `old revision + typed relation + new revision` 的 `ALL_REQUIRED` 原子组；
2. `DISPUTE_SET` 必须同时携带当前 unresolved conflict 中所有 material sides，或整体不注入；
3. `PRIMARY_STATE` 必须有 complete EvidenceBundle；不得只保留 semantic summary 而移除必要 L0；
4. 预算不足时删除整个不完整 group，而不是删除其中的 predecessor、successor、relation 或 contradiction；
5. `included=false` 的 group 只存在于 packet audit，不得产生 member render 或 ordered injection；
6. packet 是动态 memory carrier，位于 cache breakpoint 之后，不改变 stable prompt prefix；
7. section heading 只是 renderer 形式，真实 state role 来自 projection metadata；
8. memory 正文必须经过 escaping/length-delimited rendering，不能通过伪造 `[CURRENT SUPPORT]` 等文本改变
   自己的 role。

推荐 renderer 可以表现为：

```text
[PRIMARY STATE]
...

[HISTORICAL / MATERIAL CONTRAST]
...

[STATE TRANSITION]
...

[UNRESOLVED DISPUTE]
...
```

但 correctness 以结构化 packet、receipt 和 verifier 为准，不以自然语言标题为准。

### 3.4 RecallReceipt 扩展

父 Spec 的 `RecallReceipt` 增加：

```ts
type RecallReceiptStateExtension = {
  queryPlanHash: string;
  txnSnapshotSeq: number;
  requestedStateView: RequestedStateView;
  revisionExpansionArtifactId: string | null;
  queryStateProjectionIds: string[];
  stateEvidencePacketId: string | null;

  orderedStateInjections: Array<{
    sourceRef: string;
    sourceRevision: number;
    projectionId: string;
    packetGroupId: string;
    requestedStateView: RequestedStateView;
    queryRole: "primary" | "contrast" | "trajectory" | "context";
    evidencePolarity: "supports" | "contradicts" | "qualifies" | "neutral";
    renderedFragmentHash: string;
    order: number;
  }>;
};
```

`verifyRecallReceipt()` 必须验证：

```text
Query Plan temporal target
  = projection requested view
  = packet requested view
  = receipt requested view

packet group membership
  = ordered state injection membership

projection role
  = renderer placement/section role

deterministic floor candidate
  未被 reranker 或 packet packing 静默删除
```

任何 mismatch 返回结构化错误，不调用 LLM 解释。

## 4. 确定性执行链

新增后的 recall 主链固定为：

```text
canonical Owner query
  -> deterministic Query Plan + TemporalTarget
  -> bounded lane seed artifacts
  -> bounded RevisionExpansionArtifact
  -> QueryStateProjection
  -> claim atom + root-lineage collapse
  -> deterministic pre-rank / fusion
  -> optional bounded reranker
  -> complete EvidenceBundle
  -> StateEvidencePacket packing
  -> deterministic render
  -> RecallReceipt
  -> primary model
```

禁止改成：

```text
semantic Top-K
  -> reranker 已经删除旧/新状态
  -> 最后才尝试补 relation
```

因为一旦正确 successor、predecessor 或 transition endpoint 在 fusion 前缺席，后续标签无法补救 candidate miss。

所有阶段必须读取同一 `txnSnapshotSeq`。运行过程中出现新 mutation 时，本次 query 继续使用已冻结 snapshot；
下一轮 query 才读取新 head。

## 5. Query-conditioned expansion 与 role 规则

### 5.1 Current view

目标：回答 reference time 下当前有效状态。

规则：

1. active/current 且 valid interval 匹配 reference time 的 revision -> `primary`；
2. seed 命中 superseded/historical revision 时，沿 forward relation 补 active successor；
3. historical seed 保留为 `contrast` 或 `trajectory`，不得作为 current primary；
4. unresolved、scope/valid-time 重叠的 current conflict -> 形成 `DISPUTE_SET`，不得选择看起来更顺的一侧；
5. retracted/deleted revision 默认 `exclude`，除非 current query 明确询问纠错本身；
6. exact Owner current correction 继续属于 deterministic floor；
7. 没有可验证 successor 时，旧 revision 不得伪装为 current；返回 unknown/disputed 或仅使用 episodic evidence。

### 5.2 Historical view

目标：回答目标 valid interval 中成立的状态，而不是今天的 current head。

规则：

1. valid interval 与 target interval 匹配/重叠的 revision -> `primary`；
2. current successor 可以作为 `contrast`，但不得静默覆盖历史 primary；
3. target interval 之后才生效的 revision 作为 primary 属于 `future_state_intrusion`；
4. target interval 之前已经结束且不重叠的 revision默认 `exclude/context`；
5. 若 query 只给年份/月等粗粒度范围，多个重叠 revision 可形成 bounded dispute/trajectory，不擅自选一个瞬时值；
6. transaction-time replay 与 valid-time historical query必须区分：
   - “当时现实中是什么”读取 valid time；
   - “Operia 当时相信什么”读取 txn snapshot。

### 5.3 Change view

目标：解释状态如何变化，而不是只返回最新值。

规则：

1. 默认补齐 predecessor、typed relation、successor；
2. `STATE_CHANGE` packet 表示现实状态变化；
3. `RETROACTIVE_CORRECTION` packet 表示系统纠正旧 assertion，不能渲染成现实曾发生变化；
4. `SCOPE_CLARIFICATION` 必须携带旧 scope、新 scope 与 scoped exception/coexistence；
5. `EPISTEMIC_RETRACTION` 表示可信度/认识论状态变化，不伪装为现实事实变化；
6. chain 任一必要端点缺失时，`STATE_TRANSITION` group 为 incomplete，禁止部分注入；
7. dense chain 默认选择与 query target 最相关的最近完整 transition group，其他链路保留 trace omission。

### 5.4 Unspecified view

目标：在用户没有明确时间意图时提供最可能有用、但不伪造时间目标的状态。

规则：

1. 单值、可变 predicate 默认 current head 为 `primary`；
2. historical revision 只有在 seed 命中、存在 material contradiction、或当前回答需要解释变化时才进入
   `contrast/trajectory`；
3. 不得把 `unspecified` 改写成某个具体历史日期；
4. current head 不存在或 disputed 时，必须保留不确定性；
5. imported historical observation 不证明 current 状态。

## 6. Fusion、reranker 与 budget 边界

### 6.1 Fusion

global fusion 继续按父 Spec 的 `claim atom + root evidence set` 去重。新增状态规则：

- query role 是排序约束，不是额外独立票数；
- 同一 revision 通过多个 lane 命中仍只贡献一个 lineage vote；
- deterministic floor 先于 neural rerank；
- current query 中 historical-only candidate 不得仅凭 embedding/native score 超过已验证 active successor；
- historical query中 current successor 不得因 recency boost 覆盖 valid-time match；
- change query 的 transition group 作为 group 参与 packing，不能把三个节点分别当作三个可独立淘汰的候选。

### 6.2 Reranker

reranker 只能：

- 在 allowlisted pool 内调整非 floor 候选顺序；
- 对完整 packet group 提供辅助相关性分；
- 失败时回退到 persisted deterministic order。

reranker 不能：

- 删除 deterministic expansion floor；
- 修改 `QueryStateProjection`；
- 把 `exclude` 改为 `primary`；
- 拆分 `ALL_REQUIRED` transition/dispute group；
- 根据自由文本状态标签重新解释 revision lifecycle。

### 6.3 Budget

packet packing 优先级：

```text
target-view primary state + complete evidence
  > material contradiction / dispute sides
  > required transition endpoints + typed relation
  > direct episodic exchange
  > historical contrast
  > neutral context
```

预算不足时：

```text
drop whole lower-priority group
  > never inject partial state group
  > never retain summary while dropping required evidence
```

`StateEvidencePacket` 和 RecallReceipt 必须记录被删除 group 的明确 reason。

## 7. 与现有权威、隐私和删除合同的关系

### 7.1 Authority 与 protected impact

Query-relative role 不增加 authority：

- assistant/model-only evidence 即使被投影为 `primary`，仍不能建立 Owner `KNOWN`；
- protected Subject、Relationship、Permission 或 Point Anchor 的 historical/current role不构成 mutation；
- Owner confirmation 与 CAS 仍是 protected commit 的唯一入口；
- state alignment 只能决定“本轮如何使用已存在 revision”，不能决定“创建哪个 revision”。

### 7.2 EvidenceBundle

每个 packet candidate 必须绑定父 Spec 的 complete EvidenceBundle。State role 不能替代 SUPPORTS、
CONTRADICTS、QUALIFIES 或 revision relation edge。

特别地：

```text
current / historical / transition 标签
≠ 证据本身
```

没有 canonical evidence coverage 的状态标签不得注入。

### 7.3 Secret 与 deletion

revision expansion 不得穿越：

- secret-only index；
- purged source；
- privacy namespace；
- revoked evidence edge；
- Owner visibility boundary。

删除 source/evidence edge 后：

1. Gate C 重新计算 support coverage；
2. Gate D 下一次 snapshot 重新生成 expansion 与 projection；
3. 失去充分 evidence 的 revision 不得继续以 primary role进入 packet；
4. 历史 receipt 按父 Spec retention/purge 规则返回 `source_purged`，不重建正文。

### 7.4 Legacy

无 canonical source 或 relation attestation 不完整的 legacy item：

- 可以出现在 Inspector / migration diagnostics；
- 可以作为明确标记的 low-weight historical/observation context；
- 不得仅凭 legacy label 成为 current primary；
- 不得由模型批量猜测 predecessor/successor；
- 只有 exact-key、transaction history 与 canonical evidence 足以确定关系时，才允许 deterministic backfill；
- 其余标记 `state_alignment_attestation=partial`。

## 8. Subject 与 Point 的复用边界

Gate D/E 先只对 FactRevision 路径实现并验证本补充。

### 8.1 Subject

Gate F 可以复用同一机制处理 Subject revision：

- historical Owner/Self/Relationship claim 不得以 current Core 身份渲染；
- request-scoped Owner override 优先于旧 Core；
- protected historical state 可以作为明确历史对照，但不能自动恢复为 current；
- Subject Core renderer 必须记录 query-relative override 与 source revision。

具体 Subject schema 仍以 Gate F 独立合同为准；本补充不提前授权 Subject cutover。

### 8.2 Point

Gate G 可以将 revision expansion 与 query-relative role 复用于 Point：

- current Point、historical Point、contested Point 分离；
- Point 被 recall 后产生的 echo 不改变其 intrinsic stability；
- Point revision chain expansion 不得成为 recurrent 独立形成证据；
- Point state packet 属于 Operia-specific extension，不声称由 A-TMA 直接验证。

Point 路径不得成为 Gate A-F 上线依赖。

## 9. Ghost Memory 分层验收

### 9.1 故障阶段

每个失败必须落到以下一个或多个结构化阶段：

```text
BANK_STATE_MISSING
BANK_RELATION_MISSING
SEED_CANDIDATE_MISS
REVISION_EXPANSION_MISS
STATE_PROJECTION_ERROR
FUSION_OR_RERANK_DROP
PACKET_INCOMPLETE
PACKET_RENDER_MISMATCH
RECEIPT_MISMATCH
QA_STATE_RESOLUTION_ERROR
```

不允许生成事后 LLM 原因说明。

### 9.2 Fixture taxonomy

Operia 自有 fixture 至少覆盖：

1. 单值事实变化：地址、工作、偏好、计划、设备状态；
2. 反向或多次变化：A -> B -> A、临时状态恢复；
3. retroactive correction；
4. scope clarification；
5. coexistence：家庭住址/邮寄地址、工作/兼职、多设备偏好；
6. disputed evidence；
7. Owner、Operia、trusted tool、third-party authority 差异；
8. imported historical observation；
9. deleted/retracted/purged evidence；
10. protected Self、Owner、Relationship revision；
11. dense revision chain 与 hop/candidate cap；
12. current、historical、change、unspecified 四类 query；
13. relative time、时区、年/月精度与未知 target interval；
14. 用户正文伪造 `[CURRENT SUPPORT]` 等 state carrier；
15. reranker 尝试删除 deterministic successor/predecessor；
16. change packet 预算不足；
17. historical query 中 future state intrusion；
18. current query 中 stale historical primary leakage。

Gate G 另行增加 Point change、contested Point、historical Point 与 recall echo fixtures。

### 9.3 指标

#### 确定性 release blockers

| Metric | Required on fixture corpus |
| --- | ---: |
| `state_projection_determinism` | 100% |
| `expected_revision_relation_expansion` | 100% |
| `requested_state_candidate_hit` | 100% |
| `deterministic_floor_removed_by_reranker` | 0 |
| `stale_primary_leakage` | 0 |
| `future_state_intrusion` | 0 |
| `partial_transition_group_injected` | 0 |
| `partial_dispute_group_injected` | 0 |
| `state_packet_role_receipt_mismatch` | 0 |
| `secret_or_purged_relation_crossing` | 0 |
| `state_label_content_spoof_success` | 0 |

定义：

```text
requested_state_candidate_hit
  = 含有预期 target-state candidate 的 post-expansion query 数
    / 所有具有可验证 target-state 的 query 数

stale_primary_leakage
  = current/unspecified query 中 superseded/historical revision
    被作为 primary 注入的次数

future_state_intrusion
  = historical query 中仅在 target interval 之后生效的 revision
    被作为 primary 注入的次数

transition_chain_completeness
  = 含完整 old + typed relation + new packet 的 eligible change query 数
    / 所有具有完整 bank chain 的 eligible change query 数
```

#### 非空转与效用指标

为防止系统通过“全部 exclude / 全部 deferred / 完全不注入”获得零错误，另记录：

```text
bank_state_role_coverage
requested_state_candidate_hit
requested_state_final_packet_hit
transition_chain_completeness
expected_memory_probe_terminal_outcome
permanent_state_alignment_defer_rate
```

fixture corpus 上：

```text
requested_state_final_packet_hit = 100%
transition_chain_completeness = 100%
expected_memory_probe_terminal_outcome = 100%
permanent_state_alignment_defer_rate = 0
```

shadow production log 上的自然分布阈值在 Gate D/E 数据出现后校准，但不得用高 abstention 隐藏 regression。

#### QA 指标

`qa_state_resolution_error` 只统计：

```text
bank 正确
+ candidate 正确
+ packet 正确
+ receipt 正确
+ 最终回答仍使用错误状态
```

它用于区分回答模型 failure，不得反向篡改 bank、projection 或 packet trace。Gate E cutover 前要求：

- ghost-memory targeted suite 相比当前 baseline 有明确改善；
- ordinary non-temporal QA 不得出现预先声明阈值之外的回归；
- 不以 judged QA 单项提升抵消 deterministic correctness blocker。

## 10. Gate 修改

### Gate A：只增加合同与 fixtures

在父 Spec Gate A 增加：

- `RequestedStateView / TemporalTarget` 合同；
- ghost-memory fixture taxonomy；
- 分层 failure codes 与 deterministic metrics；
- 不运行 expansion，不改变 production recall。

Gate A/B 不返工 authority、capture 或 Mutation 总方向。

### Gate B：预留 relation 与 Inspector 字段

在父 Spec Gate B 增加：

- Candidate/Mutation trace 保留 relation type、scope、coexistence 与 revision target IDs；
- Inspector 能区分 `STATE_CHANGE / RETROACTIVE_CORRECTION / SCOPE_CLARIFICATION /
  EPISTEMIC_RETRACTION`；
- 不执行 query-relative projection。

### Gate C：建立 intrinsic state 基础

在父 Spec Gate C 增加退出条件：

- FactRevision lifecycle/epistemic/valid/txn 状态可在固定 snapshot 重建；
- FactRevisionRelation 足以表达 predecessor/successor、merge/split、scope clarification 与 retraction；
- unresolved contradiction 可被确定性枚举；
- relation/evidence edge 删除后历史 snapshot 与当前 snapshot 均可正确读取；
- 不在 Gate C 生成 query-relative role。

### Gate D：State Alignment 全 shadow

在父 Spec Gate D 增加：

- `TemporalTarget`；
- `RevisionExpansionArtifact`；
- `QueryStateProjection`；
- bounded state relation traversal；
- projection/expansion Inspector；
- RecallReceipt state extension；
- 全 shadow，不进入主 prompt。

推荐 flags 分离：

```text
memory_state_projection_shadow
memory_revision_expansion_shadow
memory_state_packet_shadow
```

### Gate E：State Packet 与 canary injection

在父 Spec Gate E 增加：

- complete `StateEvidencePacket`；
- atomic transition/dispute group；
- escaped deterministic renderer；
- receipt verifier state-role check；
- Owner-private canary；
- 独立注入 flag：

```text
memory_state_packet_inject
```

projection/expansion shadow 通过，不自动授权 packet injection。Gate E cutover 仍需 Owner 独立批准。

### Gate F/G

事实路径 Gate E 通过后，再分别复用于 Subject 与 Point；不得同时实施后用一个 aggregate QA score掩盖来源。

## 11. 不采用的 A-TMA 组件

本补充明确不授权：

1. Learned Sentry 作为 conflict candidate 资格门禁；
2. 无条件在线 Retrieval Controller；
3. 新增 Qwen 或其他论文模型依赖；
4. 复制论文阈值、训练集或 synthetic profile；
5. 将状态解释权交给回答模型；
6. 让 reranker 删除 deterministic revision floor；
7. unbounded predecessor/successor graph expansion；
8. 用自然语言标签代替 revision、evidence、packet 与 receipt 合同；
9. benchmark-only prompt、budget、threshold 或 policy path。

模型可以读取 Harness 生成的 state packet，但不能决定 candidate eligibility、requested view、revision relation、
query role、packet completeness 或 final receipt。

## 12. Codex 吸收与实现指令

Codex 先完成以下规范吸收，再在独立候选分支实现 Gate C-E：

1. 将本文件作为父 Spec 的 sibling addendum 保存，不把全部内容复制回主文件造成双真源；
2. 在父 Spec 的相关段落加入短引用：
   - §7 双时间事实链 -> 引用本补充 intrinsic state；
   - §9 Query Plan/Recall -> 引用本补充 expansion/projection/packet；
   - §10 RecallReceipt -> 引用 state extension；
   - §17 Gates -> 合并本补充 Gate 变更；
   - §18 Acceptance -> 合并 deterministic ghost-memory blockers；
3. 检查父 Spec 现有 `temporalIntent`、EvidenceBundle、RecallReceipt 与本补充字段名，不新增同义平行字段；
4. 输出 schema diff、gate diff、fixture manifest 与 unresolved questions；
5. Gate C-E 可以建立 additive candidate migration、纯函数实现与本地临时 SQLite verifier；
6. 未经 Owner 进一步授权，不合 main、不运行 remote migration、不调用模型、不运行 backlog、不部署，也不修改
   production flags。

建议文件名：

```text
2026-08-10-operia-memory-vnext-state-alignment-addendum.md
```

## 13. 当前停止点

本补充完成后：

- A-TMA 的有效启发已被收敛为一个缺失 artifact、一个有界 expansion pass、一个结构化 packet 和一套分层
  ghost-memory fixtures；
- authority、Owner governance、bitemporal revision、evidence lineage、secret/deletion 与 Point 反自激边界
  不变；
- Gate A/B 不返工；
- Gate C 只负责 intrinsic state；
- Gate D 负责 query-relative expansion/projection shadow；
- Gate E 负责 packet、render、receipt 与 canary injection；
- 生产授权只覆盖 additive migration 与 harness-owned shadow；没有授权 backfill、真实模型或 prompt injection。

Owner 已明确批准本补充进入 Gate A-E production shadow。`memory_state_packet_inject`、Owner-private canary 与
任何 recall cutover 继续需要独立授权。

## 14. Gate C-E 候选实现记录（2026-08-10）

### 14.1 Schema diff

- Gate C：新增 append-only `FactRevisionStateEvent`、固定 intrinsic snapshot/member/relation/contradiction
  artifacts，并为 relation/evidence edge 保留 transaction-time close-only 语义；
- Gate D：新增 `TemporalTarget`、bounded expansion/traversal/added/omitted artifacts、
  `QueryStateProjection` 与只读 Inspector view，全部 `shadow_only=1`；
- Gate E：新增 packet/group/member、deterministic render、receipt state extension 与 ordered injection artifacts；
  candidate policy 和 packet schema 均硬约束 `memory_state_packet_inject=0` / `injection_enabled=0`。

三份 migration 都是 additive schema；连同 Gate A/B migration 已于 2026-08-10 应用于 remote D1。由于 D1
`/query` 对真实 trigger DDL 的整段解析失败，生产使用官方可恢复 SQL import 路径逐文件执行，再逐项登记
`d1_migrations`；最终回读无待应用 migration，foreign key check 为空。

### 14.2 Gate diff

- Gate C 只重建 intrinsic state 和 evidence coverage，不生成 query role；
- Gate D 在同一 `txnSnapshotSeq` 下先扩展 revision/contradiction，再生成 query role，且不进入 prompt；
- Gate E 只渲染 `included=true + completeness=complete` 的原子组，并用 state-aware receipt verifier 对齐
  TemporalTarget、projection、packet membership、role placement、fragment hash 与 deterministic floor；
- Gate F Subject 与 Gate G Point 未提前实施。

### 14.3 Fixed fixture manifest

候选 verifier 覆盖：固定快照前后 lifecycle 变化、evidence/relation edge 关闭、unresolved dispute、current 与
historical target、unknown historical target、不匹配 future candidate、secret/privacy boundary、dense chain
hop/candidate cap、reranker 删除 floor、complete/incomplete transition、complete/incomplete dispute、byte budget
整组删除、正文伪造 state heading、receipt fragment/role/membership 篡改以及 append-only D1 约束。

固定 corpus 结果：state projection deterministic、target candidate hit、complete transition/dispute injection 和
receipt verification 均通过；stale primary、future-state intrusion、partial group injection、floor removal、privacy
crossing 与 label spoof 均为 0。验证没有调用模型、没有生产写入、没有 prompt injection。

### 14.4 后续校准与严格停止点

自然 shadow 分布的 hop/candidate cap、packet budget 与 recall latency 仍需在 vNext fact bank 产生自然样本后校准；
legacy `state_alignment_attestation=partial` 的 migration policy 仍未执行。当前版本已合入 main 并部署
harness-owned production shadow，但不运行 backfill、不做 Owner-private canary，也不启用任何 state packet
injection。`memory_txn_clock.last_seq=0` 时 runner 明确记录 `state_bank_empty` 并停止，不伪造空 packet。

### 14.5 Production shadow 发布记录

- canonical source：<COMMIT>；production version：`<UUID>`；
- remote migrations：`0054`–`0058` 全部登记；
- effective flags：projection shadow、revision expansion shadow、state packet shadow 均为 `true`；
- hard boundary：`MEMORY_STATE_PACKET_INJECT_ENABLED=false`，`MEMORY_THINK_CACHE_V3_MODE=anchored_v3`；
- harness 在普通 recall 完成后通过 `waitUntil` 写 shadow artifact，不增加模型调用、不修改 Assembler；
- 直接代码回滚点：`<UUID>`；迁移前 Time Travel bookmark：
  `0000013c-00035e9b-000050c3-fe104208d345964a9302e5ff2e7437ae`。
