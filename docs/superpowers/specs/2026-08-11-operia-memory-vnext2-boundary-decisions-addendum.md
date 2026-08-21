---
date: 2026-08-11
status: owner-accepted boundary decision record; specification only
owner: Memory
repository: <OWNER>/Operia-Agent-Reference
repository_snapshot: <COMMIT>
spec_branch_parent_snapshot: <COMMIT>
implementation_authorized: false
production_deploy_authorized: false
database_migration_authorized: false
model_call_authorized: false
stable_cache_prefix_change_authorized: false
parent_specs:
  - 2026-08-08-operia-white-box-memory-and-dyadic-subject-model-design.md
  - 2026-08-10-operia-memory-vnext-authority-recall-point-design.md
  - 2026-08-10-operia-memory-vnext-state-alignment-addendum.md
  - 2026-08-11-operia-memory-vnext2-memory-need-admissibility-non-interference-addendum.md
source_decision_record: Operia Memory vNext.2：从证据型长期记忆到 Owner Cognitive Model 的完整研究与设计总纲
---

# Operia Memory vNext.2 Boundary Decisions Addendum

## 0. 文档定位

本文件冻结 `Operia Memory vNext.2：从证据型长期记忆到 Owner Cognitive Model 的完整研究与设计总纲` 进入 implementation spec 前必须唯一化的边界语义。

它不是新的 Memory 架构，也不替代上述总纲或 parent specs。它只解决这些文档之间可能导致两套真源、越权实现或错误 cutover 的歧义。

本文件只授权后续撰写 repository-bound implementation spec。它不授权：

```text
代码修改
数据库 migration / backfill
历史正文处理
外部模型调用或付费
Queue / Cron 变更
环境变量变更
稳定缓存前缀变更
生产部署或流量切换
```

若本文件与早期 vNext.2 Memory Need addendum 冲突，以本文件对该冲突点的明确裁决为准；早期文档中未冲突的 Need-before-Relevance、Admissibility、Better-Layer、Non-Interference 与 No-Memory 原则继续有效。

---

## 1. 决议摘要

本轮冻结十一项边界：

1. MB1 动态包可以设计与 shadow，但稳定 Codebook 仍需单独授权；
2. EvidenceUnit 与 ClaimAtom v2 都是版本化不可变对象，重新归一化不得原地改写；
3. Owner 的短确认不是对 assistant 新造命题的自动背书；
4. Recency Neutrality 禁止元数据新近性决定持久事实，但不抹掉表达中的真实语义时间；
5. DynamicRecallNeed 是现有 per-need plan 的派生总览，不建立第二套 Neededness 真源；
6. EvidenceBundle 先满足资格与证明完整性，再优化 token/byte；
7. OCM 只能帮助有限消歧，不能成为证据、权限或自身正确性的证明；
8. Night Review 必须 Blind First、lineage scrubbed、snapshot isolated，且模型永不直接提交；
9. HIDE、FORGET、PURGE 的对象、可恢复性与授权强度必须分开；
10. 反事实评估以四个 cutover 核心臂为准，旧 CURRENT 与 PLACEBO 仅保留为诊断臂；
11. Grok proposal lane、Night Reviewer、mutation cutover、read cutover 与 MB1 cutover 必须分别授权和回滚。

---

## 2. B-01｜MB1 与 Stable Prefix Integrity

### 决议

MB1 被拆成两个独立交付面：

```text
MB1 dynamic renderer / packet
  = cache breakpoint 后的动态载体

MB1 cached codebook
  = 稳定缓存前缀中的解释合同
```

当前只允许为二者编写规格，并允许未来在独立 flag 下实现 dynamic renderer 的 shadow。当前没有权限把 Codebook 加入稳定缓存前缀。

### 原因

Owner 同时冻结了：

```text
Stable Prefix Integrity
stable_cache_prefix_change_authorized: false
```

因此“在稳定缓存前缀内追加一个短 Codebook”是目标形态，不是本轮可执行动作。它不能借“只是几行解释”绕过 byte/order/cache-anchor 合同。

### 实施边界

在单独取得 Owner 授权前：

```text
不得改变 Persona / Identity
不得改变 Precious
不得改变 Subject Core
不得改变 Behavior Contracts
不得改变 Yesterday Log
不得改变 Full Glossary
不得改变 Client Stable System
不得改变上述 block 的顺序、内容、cache anchor 或 anchored_v3
```

未来 Codebook gate 必须至少证明：

```text
stable prefix byte/order diff 是已授权 diff
anchored_v3 仍是唯一生产策略
多轮真实 wire 中 cache breakpoint 与 provider-visible tools/instructions 未漂移
旧 packet 不会被新 Codebook 误读
新 packet 缺少 Codebook 时 fail closed，而非静默猜测
```

若 Codebook gate 未获授权，MB1 shadow 必须使用测试专用解释上下文，不得修改真实 stable prefix，也不得 cutover 为 production carrier。

---

## 3. B-02｜EvidenceUnit 与 ClaimAtom v2 的不可变性

### 决议

```text
Canonical Event
  = 对“表达真实发生”的不可变事件记录

EvidenceUnit
  = 对 canonical contentRevision 中精确证据范围的不可变引用

ClaimAtom v2
  = 在确定 predicateRegistryVersion 与 normalizationVersion 下生成的不可变规范主张

FactRevision
  = Harness 对一个或多个 ClaimAtom 作出的可修订事实状态投影
```

EvidenceUnit 的身份至少绑定：

```text
canonicalEventId
contentRevision
byteStart / byteEnd 或合法 composite members
spanHash
episodeId
```

ClaimAtom v2 的语义身份至少绑定：

```text
subjectRef
assertionKind
predicateId
objectRef
canonicalValue
scope / qualifiers
predicateRegistryVersion
normalizationVersion
```

### 重新归一化规则

当 predicate registry 或 normalization 版本变化时：

```text
旧 ClaimAtom 保留
→ 创建新 ClaimAtom
→ 写入 typed reinterpretation / renormalization relation
→ 由 Harness 决定 FactRevision 是否迁移、并存、争议或 defer
```

禁止：

```text
原地覆盖 canonicalValue
原地更换 predicateId
用新 normalization 让旧 evidence 看起来从未表达过旧语义
把 formatter / portrait render 重新抽取为新独立 evidence
```

### 原因

如果 ClaimAtom 可被静默重写，Inspector 无法回答“当时模型从哪段话归一化出了什么”；如果 FactRevision 与 ClaimAtom 合并为一个可变对象，belief revision 会反向篡改证据语义。

---

## 4. B-03｜Composite Confirmation 的 authority 上限

### 决议

以下对话不自动产生 OWNER/KNOWN：

```text
Assistant：你喜欢咖啡，对吗？
Owner：对。
```

如果该命题只是 assistant 首次提出、没有可追溯的 prior Owner root，它最多进入提案、待复审或低权威 confirmation，不得通过短答把 assistant proposal 洗成 Owner-known fact。

普通 OWNER/KNOWN 的强 CompositeConfirmation 必须同时满足：

```text
同一 conversation
明确 replyTo，或严格相邻且不存在插入事件
只有一个可判定命题
问题是对 prior Owner statement 的中性复述，或命题本身已由 Owner 提供
回答明确且无条件歧义
非 quotation / hypothetical / roleplay / sarcasm
无 protected / secret / permission 越权
question + answer 共同构成 ALL_REQUIRED support group
共同只计为一个 Owner root lineage
```

对于 assistant 首次提出的新命题，只有 Owner 的完整独立陈述，或后续明确重述命题，才能形成普通 Owner direct evidence。

### 复合问题

```text
“你喜欢咖啡、住在上海，而且明天要开会，对吗？”
“对。”
```

不得批量产生三个 facts。系统应拒绝自动拆分为强确认，保留为事件证据或 defer。

### 必需审计字段

未来 schema 至少应能表达：

```text
elicitationOrigin = OWNER_ROOTED | NEUTRAL_RESTATEMENT | ASSISTANT_NOVEL | TOOL_ROOTED
questionEvidenceUnitId
answerEvidenceUnitId
adjacency / reply binding
singleProposition verdict
authority verdict / reasonCode
```

---

## 5. B-04｜Recency Neutrality 与语义时间

### 决议

Recency Neutrality 禁止以下元数据单独授予持久替代权：

```text
created_at
learned_at
message order
revision number
向量库中的 current-version boost
“Owner correction”持久 ranking bonus
```

但它不禁止使用证据正文中的语义时间：

```text
“我以前喜欢咖啡，现在不喜欢了。”
“从三月开始我搬到上海。”
“上周那只是临时安排。”
```

这些明确的 temporal semantics、合法 tool observation 的 valid time，以及被验证的 event ordering，可以参与 STATE_CHANGE、historical、trajectory 或 coexist_by_time 判断。

### Request-scoped priority

Owner 在当前请求中的明确表达可获得本轮响应优先权，但该优先权：

```text
只作用于当前 request 的回答
必须在 trace 中标为 request-scoped
不能自动写成持久 mutation
不能让新表达仅因“刚说”而 supersede 旧 FactRevision
```

若本轮表达和历史证据冲突但 mutation 关系不明确，响应可以以当前表达为条件作答，同时持久层进入 DISPUTE 或 DEFER。

### Relation verifier 要求

STATE_CHANGE 至少需要下列一种材料：

```text
明确 change marker
可验证且不重叠的 valid-time range
合法结构事件证明状态先后变化
Night Review 在完整证据下提出并经 Harness 验证的方向性关系
```

“文本不同”与“新消息在后”均不是充分条件。

---

## 6. B-05｜DynamicRecallNeed 只有一个真源

### 决议

现有 vNext.2 Need addendum 中的 `MemoryNeedPlan` 保留为详细、per-need、不可变的 canonical planning artifact。新总纲中的 `DynamicRecallNeed` 不是第二个 classifier 或第二套状态机，而是该 plan 的 turn-level 派生视图：

```ts
type DynamicRecallNeed = "BYPASS" | "OPTIONAL" | "REQUIRED";
```

派生规则：

```text
plan 中存在任一 REQUIRED approved need
  → REQUIRED

否则存在任一 BOUNDED_OPTIONAL approved need
  → OPTIONAL

否则
  → BYPASS
```

若 planSequence=1 的主模型 petition 被合法接受，则从新的 immutable `MemoryNeedPlan` 重新派生，旧 plan 不原地修改。

### Deterministic required floor

下列表达在 context-self-sufficiency guard 之后触发 REQUIRED floor：

```text
明确“上次 / 之前 / 你还记得 / 我们先前说过”
询问已知私人历史事件
询问先前承诺、关系连续性或 Owner-specific project decision
没有长期私人证据就无法诚实回答的请求
```

Live Context 已完整包含答案时，不得仅凭词面误判 REQUIRED。

### 执行位置

Need 必须在动态长期记忆 retrieval 前确定：

```text
Current Request + Live Context
→ deterministic floor / better-layer / admissibility planning
→ MemoryNeedPlan
→ DynamicRecallNeed projection
→ allowed lanes
```

BYPASS 不运行 FactRevision、Episodic、OCM 或 Point 动态 lanes，但不影响 stable prefix、Recent Turns 与 Rolling Summary。

### 不建立第二个 carrier

早期 addendum 提出的 `NeedBoundMemoryEnvelope` 不作为新的 production carrier。它的有效字段应绑定进：

```text
StateEvidencePacket / MB1 metadata
RecallReceipt
queryPlanId / needId / useScope
```

这避免 `NeedBoundMemoryEnvelope`、`StateEvidencePacket` 与 MB1 三层都成为“最终记忆包”的平行真源。

### 模型边界

第一版不增加 secondary LLM Neededness classifier。确定性 planning、现有主模型 petition 和 Harness 验证足够；以后如研究 secondary classifier，必须作为独立实验，不得替换 deterministic floor。

---

## 7. B-06｜EvidenceBundle 的选择目标

### 决议

EvidenceBundle Builder 使用按优先级排序的 lexicographic objective，而不是对所有信号混成一个可被 token 成本抵消的分数：

```text
1. privacy / authority / source-mode eligibility
2. 至少一条完整、存活的 support group
3. root-lineage 与 elicitation-episode 独立性
4. claim / scope / valid-time 的直接匹配
5. material contradiction 与 revision relation 完整性
6. structural context 的最小充分性
7. 在以上约束均满足后，最小 token / byte cost
```

### 完整性

`completeness=complete` 不是“读到了某段文本”，而是：

```text
支持路径所有 ALL_REQUIRED 成员齐全
必要 authority / attestation 齐全
material contradiction 未遗漏
相关 transition / dispute relation 齐全
精确 EvidenceUnit span 可读且 hash 一致
所需结构边未断裂
```

若预算不足以装下完整原子组：

```text
OPTIONAL → 整组不注入
REQUIRED → MISS + reasonCode
```

不得用不完整组或画像提示填补 REQUIRED 的证据缺口。

### 去重

同一 canonical event 的复制、摘要、重新抽取、recall echo 与 portrait render 均 collapse 到同一 root lineage；它们不能通过多次 materialization 形成“多数证据”。

---

## 8. B-07｜OCM 的有限影响面

### 决议

OCM 是可修订 projection，不是：

```text
Owner 本人
事实真源
OWNER/KNOWN authority
Subject Core
permission grant
task authorization
心理或健康诊断
```

OCM 不得进入 `FactRevisionEvidence`，不得组成 Support Group，不得增加 root evidence count。

### 允许的影响

在 Blind Pass 无法判定，且完成 lineage scrubbing 后，OCM 只可用于：

```text
LANGUAGE_DISAMBIGUATION
SCOPE_DISAMBIGUATION
非 material 的 TIE_BREAK_ONLY
```

它可以帮助解释 Owner 一贯如何使用一个词、如何界定范围，或两个均不影响权限/行动的等价候选哪个更自然。

### 禁止的影响

OCM 不得：

```text
推翻 Blind Pass 已由明确 evidence 得出的 verdict
替代 material contradiction
决定 protected identity / relationship / permission / constitution
决定健康、心理、财务、法律或行动关键结论
把 inferred_hypothesis 晋升为 Owner authority
以“她通常如此”证明本案也如此
```

Blind 与 Profile 发生 material conflict 时，最终结果必须 `KEEP_DISPUTED` 或 `DEFER`，不能让 reviewer 强行选择赢家。

### 高敏维度

高敏与 protected family 默认：

```text
inferencePolicy = explicit_only 或 never_infer
```

Owner 明确表达仍先进入 FactRevision / Subject Core 的相应 authority 流程；OCM 只能引用已提交结果，不能自己创建 protected state。

---

## 9. B-08｜Night Review Court 的封闭审理

### 决议

每日审理顺序固定为：

```text
Freeze Snapshot N
→ collect bounded cases
→ Blind Evidence Review
→ Harness verifies blind proposal
→ only if unresolved: build ConflictSafeOwnerContext
→ Profile-assisted Review
→ Harness verifies final proposal
→ commit ordinary mutation when separately authorized
→ build Snapshot N+1 from committed state
```

### Lineage scrubbing

Profile Pass 前必须删除：

```text
涉案 A/B root evidence closure
依赖这些 roots 的所有 dimension revisions
其 downstream descendants
same predicate family 的直接结论
sensitive / protected mirrors
```

Scrubber 的 included 与 removed revisions、root closure hash、policy version 必须写入 artifact。

### Snapshot isolation

禁止：

```text
当天新 evidence
→ 先更新 OCM
→ 再用新 OCM 批准同一 evidence
```

Snapshot N 审理当天案件，提交后才生成 N+1。

### 外部模型与隐私

Night Review Packet 必须先通过 privacy / secret / protected eligibility；reviewer 只读取 bounded packet，不读取整个私人历史。所有调用持久化 provider、model、prompt/schema/policy version、reasoning config、input/output hash 与 failure code。

模型只能写 proposal artifact，不能直接：

```text
写 FactRevision
写或改 Subject Core
创造 EvidenceUnit
关闭 contradiction
创建 permission / commitment / task
执行 HIDE / FORGET / PURGE
```

### 时间语义

文档中的 `04:00` 统一解释为 `<YOUR_TIMEZONE>`。它对应 `20:00 UTC`，与仓库当前 `20:10 UTC` 的 daily maintenance 是不同的未来 schedule。是否新增 schedule、是否合并队列、使用何种 reviewer，均需独立授权。

---

## 10. B-09｜HIDE / FORGET / PURGE

### 决议

三者作用对象不同：

|动作|默认作用|canonical conversation|支持传播|可恢复性|授权|
|---|---|---|---|---|---|
|HIDE|停止 recall / display|保留|不关闭证据，仅设置可见性|可撤销|Owner 普通明确指令|
|FORGET|关闭 retrieval 与 support edges，写 tombstone|默认保留|向下重算 descendants|可恢复|Owner 明确针对记忆影响力|
|PURGE|删除指定正文、索引与可还原 payload|删除指定范围|向下重算，receipt 仅保留 source_purged|不可恢复|Owner 明确 `Purge now` 或等价高强度确认|

### 自然语言默认

“别记这件事”“忘掉这个偏好”默认解释为 FORGET memory influence，不自动删除 canonical conversation body。

范围不明确、跨多个事件、涉及审计/交付真源或会造成不可逆删除时，Harness 必须停止并请求精确范围；Night Reviewer 或主模型不得替 Owner 扩大 purge scope。

### 传播方向

```text
Evidence → Claim / Fact → OCM Dimension → Portrait Render
```

关闭 source/evidence edge 后向下重算；删除 OCM dimension 不得反向删除 facts 或 canonical events。

---

## 11. B-10｜反事实评估臂统一

### Cutover 核心四臂

生产切换必须具备：

```text
BASE         无动态长期记忆
OPERIA       实际 Neededness + retrieval + packet
ORACLE       人工或 verifier 构造的最小正确证据包
ADVERSARIAL  高相关但错误、过期或近似 scope 的证据
```

### 迁移诊断臂

早期 Need addendum 中的两臂继续保留，但不作为架构真源或必备在线路径：

```text
LEGACY_CURRENT
  = 当前生产 recall / <memories> carrier 的迁移基线

PLACEBO
  = token、位置与显著性近似，但没有有效私人证据的注意力控制
```

因此离线实验最多可运行六臂，但 cutover blocker 仍由四个核心臂和以下指标决定：

```text
Needful Gain
Memory-Induced Regression
Oracle Gap
Evidence Utilization Failure
Unnecessary Injection Rate
Neededness False Negative
Safe Marginal Utility
```

PLACEBO 用于区分“证据帮助”与“多给了一段显眼文本”；LEGACY_CURRENT 用于确认迁移是否真实优于旧链，二者不能替代 BASE 或 ADVERSARIAL。

---

## 12. B-11｜模型、mutation、read 与 carrier 分权 cutover

### 决议

以下不是一次“大版本开关”，而是互不替代的授权面：

```text
proposal provider genericization
Grok proposal shadow
Grok proposal primary
EvidenceUnit / ClaimAtom dual-write shadow
Mutation relation shadow
ordinary mutation commit
support recomputation / deletion propagation
OCM shadow
Night Review model calls
read-path shadow
Neededness enforcement
MB1 renderer shadow
stable Codebook change
MB1 production injection
production cutover
```

任何一个面通过，都不自动授权下一个面。

### Grok

目标 proposal lane 可以配置为 `xai/grok-4.5`，但第一步必须先把 artifact metadata 从 DeepSeek 专名改为 provider/model 中性结构。禁止为了换模型继续把 Grok 结果写成 `producer="deepseek"`。

模型更换先 shadow，不能与 mutation commit 同时切换，否则无法区分错误来自 normalization、relation semantics 还是 provider behavior。

### Night Reviewer

第一版可优先评估与 Grok 独立、已在 Operia 中验证稳定的 Opus 系 reviewer，但具体 model ID、reasoning budget 与 provider 是配置，不是永久架构常量；模型调用和成本须另行授权。

### 旧 writer 的 containment

implementation 开始前必须先 read back 实际生产 flag。若当前 ordinary writer 正在把 `text-different` 写成 STATE_CHANGE，则后续获授权的首个生产动作应是 bounded containment：对无法确定关系的不同值停止破坏性 supersede，转为 DEFER / shadow。本文档本身不授权执行该动作。

---

## 13. Parent Spec 解释优先级

对同一概念采用以下解释：

|概念|canonical 解释|
|---|---|
|稳定长期背景|stable cache prefix；不受 DynamicRecallNeed 控制|
|实时对话材料|Recent Turns / Rolling Summary；不受 BYPASS 关闭|
|per-need planning|`MemoryNeedPlan`|
|turn-level need|由 plan 派生的 `DynamicRecallNeed`|
|事实 carrier|`StateEvidencePacket`，未来由 MB1 紧凑渲染|
|OCM carrier|`OwnerModelHint`；非证据|
|Operia 连续性|`PointContext`；非 Owner fact|
|最终动态包|一个 need-bound packet/receipt chain；不再新增 envelope 真源|
|持久事实状态|`FactRevision` over immutable ClaimAtoms|
|Owner protected definition|`Subject Core`；OCM 不得替代|

---

## 14. Hard Stop Conditions

后续 implementation spec 或实现出现以下任一情况时必须停止：

```text
把本 addendum 解释为代码或部署授权
未经授权修改 stable prefix 或 anchored_v3
创建第二套 Neededness / final carrier 真源
assistant novel proposition + 短答自动升级 OWNER/KNOWN
原地重写 ClaimAtom canonical semantics
用 created_at / revision number 决定持久 winner
EvidenceBundle 先按最短文本选、再宣称完整
OCM 进入 FactRevision support group
Night Reviewer 直接写事实或权限
PURGE 从模糊“忘记”自动触发
模型切换与 mutation/read/carrier cutover 捆绑
用 PLACEBO / LEGACY_CURRENT 取代 BASE 或 ADVERSARIAL
```

---

## 15. 本轮授权结论

Owner 已接受上述边界作为 implementation spec 的写作前提。

授权状态保持：

```text
boundary decision record：authorized
repository-bound implementation spec：authorized to draft
implementation：not authorized
database migration / backfill：not authorized
model call / provider switch：not authorized
stable prefix change：not authorized
production deploy / cutover：not authorized
```
