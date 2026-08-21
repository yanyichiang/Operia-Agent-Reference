---
date: 2026-07-12
status: proposed
scope: Operia Agent, Telegram, cache, tools, control plane, reasoning trace, voice
---

# Operia Agent Control Plane 设计

> Control-plane ownership、跨域参数、override、manifest、双向深链接和后续页面分流以
> `2026-07-14-operia-federated-control-plane-design.md` 为唯一权威。本文件保留 Agent
> runtime、主模型工具面、缓存实验和早期控制台需求的历史设计；第 8-10 节不得作为新增
> 控制面配置或数据归属的实现依据。

## 1. 目标

在不复制人格、记忆或会话真源的前提下，将现有 Cloudflare Agent 收敛为
Operia 的统一编排内核，并逐步接入 Telegram、PWA、Home Assistant、搜索、
生图与语音。

核心目标：

1. Opus 4.6 保持唯一主对话模型与最终回答者。
2. Operia 继续独占人格、身份、短期上下文与长期记忆。
3. Agent 负责工具编排、审批、耐久任务、渠道投递、审计与可观测性。
4. 能用脚本或确定性路由完成的动作不调用 GLM。
5. GLM 只把复杂目标编译成工具计划，不承担主对话或记忆职责。
6. 普通 Telegram 与 PWA 对话尽快出现可见输出，不再整段空等。
7. 所有新增能力均可单独关闭，不破坏当前 Opus 普通聊天。

## 2. 当前基线

- Memory Worker：Operia 人格、记忆、模型代理与 768 维 Vectorize 真源。
- Agent Worker：Durable Object、静态 Policy、GLM planner、耐久工具任务、审批
  Workflow、取消、审计与私有 Service Binding 已上线。
- Telegram Worker：owner-only webhook、Queue、rolling state、可靠 outbox、耐久
  continuation 与审批 callback 已上线。
- `agent.example.com` 当前只有运行时入口页，不是完整控制台。
- `tgbot.example.com/admin` 已有 Command Ledger，但尚未完整展示 Agent、
  Tokens、Cache、Reasoning 与 Voice。
- Agent 与 Telegram workers.dev 均关闭。
- 生产 Agent delegated tool allowlist 初始为 0，默认 fail-closed。
- TG Queue `max_batch_timeout` 已从 30 秒降为 1 秒；Operia boot、recall、persona
  已并行。
- 当前 Telegram 仍等待完整非流式 Opus 响应后一次性发送。
- Cloudflare partner-model 兼容路径目前剥离 `cache_control`，usage 未返回可验证的
  cache read/create tokens。

## 3. 总体架构

```text
Telegram / PWA / HA / future devices
                 |
                 v
       Operia Agent Orchestrator
                 |
                 v
      Opus 4.6 + Operia Memory Core
                 |
     +-----------+------------+
     |           |            |
 built-ins   media/search  delegate_action
 memory      voice/image        |
                                  v
                           GLM Tool Compiler
                                  |
                                  v
                    MCP / HA / multi-step tools
```

物理部署继续保持三个 Worker，逻辑上构成一个后端：

- Memory Worker 是 cognitive core。
- Agent Worker 是 orchestration core。
- Channel Worker 是 transport adapter。

Worker 间只使用 Service Binding 与独立应用 bearer，不恢复公开 workers.dev 回源。

## 4. 主模型工具面

Opus 固定看到以下稳定工具。供应商、MCP catalog 与 HA 设备变化不得改变这些
顶层 schema。

### 4.1 `request_context`

申请受限 Context Capsule。Capsule 绑定 owner、chat、task、purpose、policy version
与过期时间，不包含通用数据库访问能力。

### 4.2 `memory`

统一的显式记忆工具，使用 action enum：

- `recall`
- `propose_write`
- `profile_update`
- `persona_update`

自动召回仍由 Operia 管线完成。写入以 proposal 开始；删除、批量覆盖、身份与人格
关键字段修改继续经过 Policy 和审批，不暴露通用 SQL 或通用删除原语。

### 4.3 `search_web`

Opus 给出检索目标、时效要求、来源要求与输出契约。Agent 使用确定性 provider
adapter 调用搜索服务，返回带 URL、标题、时间和摘要的 evidence bundle。

### 4.4 `generate_image`

Opus 直接给出创意 brief、参考图、比例、质量与输出数量。Agent 默认路由到
Grok Imagine；provider model ID 不进入主模型工具 schema。

### 4.5 `speak`

渠道无关的语音投递工具：

```json
{
  "text": "要说的话",
  "voice_profile": "operia-default",
  "style": "温柔、轻快、略带得意",
  "target": "current_channel",
  "quality": "realtime"
}
```

Agent 根据 quality 和 channel 选择模型、音频格式和投递 adapter。

### 4.6 `delegate_action`

仅用于复杂、多步、动态或高风险任务：

```json
{
  "goal": "最终目标",
  "constraints": ["限制条件"],
  "context_ref": "capsule id",
  "output_contract": "返回给 Opus 的结构"
}
```

GLM 读取受限工具 catalog，输出结构化执行计划；Policy 与唯一执行门在执行前重新
校验。GLM 不得读写 Operia 记忆，不得直接向渠道发送消息。

## 5. Telegram 延迟优化与 PWA 流式响应

### 5.1 Telegram

Telegram 保持完整回答后再发送最终气泡，不创建草稿消息，也不反复编辑消息。延迟优化集中在模型调用之前和 Worker 间链路：

1. webhook 入站后立即 `sendChatAction(typing)`。
2. debounce 从 3 秒降为 1 秒；仍合并短时间内连续发送的半句请求。
3. Telegram 通过 `MEMORY_SERVICE` Binding 调用 Operia，不再走 workers.dev URL。
4. Operia 继续并行准备 boot、recall 与 persona，并记录各阶段耗时。
5. 最终文本经过现有 regex、气泡规则和 archive 语义后整段或分泡发送。
6. 工具调用期间只保留 Telegram typing 状态与明确的审批消息，不发送中间推理或工具 JSON。

验收目标：

- 普通短回答完成 p50 <= 8 秒，p95 <= 16 秒。
- Telegram 入站到 Operia 请求发出的调度耗时 p50 <= 2 秒。
- 不出现重复最终消息、重复 archive 或工具 JSON 泄漏。

### 5.2 PWA

- Operia SSE 直接向前端透传可见 token。
- 前端必须显示首 token，而非先缓冲完整响应。
- 断开时 abort 上游请求；重连不得重复 archive。
- 工具续轮仍只 archive 最终 assistant。

## 6. 缓存实验

不得在没有 cache token 证据时宣称命中。

实验组：

1. 当前 Cloudflare Unified Opus 路径。
2. 对 Cloudflare endpoint 保留 `cache_control` 的兼容性探针。
3. Anthropic BYOK 经 Cloudflare AI Gateway。
4. 如有必要，对比支持原生 prefix cache 的 Cloudflare-hosted模型。

每组使用相同稳定 system/tools/history 和不同 user tail，连续运行至少三轮，记录：

- model 与 service tier
- TTFT 与 total latency
- input/output tokens
- cache read/create tokens

AI Gateway 完整请求缓存不用于私人连续对话。实验不得把 prompt、persona、memory
正文写入可公开日志。

## 7. 工具调用验收矩阵

### 7.1 确定性路径

- `/status`、取消、批准与开关零模型调用。
- `search_web`、`generate_image`、`speak` 单步调用不经过 GLM。
- provider adapter 使用稳定幂等键与预算限制。

### 7.2 GLM 路径

- 单个只读 MCP。
- 多工具串联。
- catalog/schema 漂移。
- GLM 判断无需执行工具。
- Opus 与 GLM 判断冲突。
- 失败后最多重新规划一次，禁止递归循环。

### 7.3 高风险路径

- 写操作批准、拒绝、超时。
- cancel 与在途 fetch 竞态。
- Workflow、Queue 与 Worker 崩溃恢复。
- 外部副作用未知时进入 `attention_required`，不得自动重放。
- HA 动作不能仅凭危险关键词触发。

## 8. 控制台与 Mini App

### 8.1 `agent.example.com`

升级为统一控制台，沿用暖白底、黑字、灰分割线、`#CC7D5E` accent、Anthropic
Serif 与 Noto Serif SC。保持左侧导航、主内容、右侧控制页入口，不使用卡片套卡片。

页面：

- 总览
- Agent 与工具
- MCP / HA Providers
- 任务与审批
- 模型路由
- Reasoning Trace
- Tokens & Cache
- Usage 与费用
- Voice Studio
- 延迟与错误

### 8.2 `tgbot.example.com/admin`

保留渠道专用控制：

- 消息入口、处理中、需要关注、已完成
- 斜杠命令
- 会话与模型
- Voice / Thinking 模式
- Telegram outbox
- webhook 与安全状态

Agent 状态改为通过 `AGENT_SERVICE` Binding 读取。旧 `AGENT_RUNTIME_BASE_URL`
不得恢复。

### 8.3 Telegram Mini App

同一后端提供移动视图：

- Reasoning 书架
- 当前任务和审批
- Voice 快捷设置
- Usage 摘要

使用 Telegram WebApp `initData` HMAC、owner ID 和 Cloudflare Access/应用层策略
联合认证。

## 9. Reasoning Trace

只保存 API 主动返回给客户端的 reasoning summary 或可见 reasoning text，不推断、
恢复或伪造未暴露的隐藏思维链。

模式：

- `off`
- `summary`
- `debug_trace`

debug trace 可包含：

- Opus 工具请求
- GLM 计划
- Context Capsule 脱敏摘要
- 工具与参数摘要
- 审批、取消、重试
- 分阶段耗时
- 最终状态

控制面：

- `/think-on`
- `/think-off`
- `/think-debug`
- 会话级面板开关
- 全局默认策略

默认保留 7 天。不得保存 secret、cookie、完整敏感上下文、未经脱敏的工具结果或
隐藏 CoT。

## 10. 指标与费用展示

普通消息不显示工程指标。Reasoning/请求详情中的 expandable block 只显示四组：

1. model 与 service tier
2. TTFT / total latency
3. input/output tokens
4. cache read/create tokens

费用只出现在：

- 域名控制台 Usage 页面
- Telegram `/usage`

费用统计标记 provider、模型、日期与估算/账单来源；不得混入普通聊天气泡。

## 11. Grok 搜索与生图

- `search_web` 返回 evidence bundle，最终结论始终由 Opus 生成。
- `generate_image` 默认使用 `xai/grok-imagine-image`。
- 高质量模式使用 `xai/grok-imagine-image-quality`。
- 支持参考图、编辑、比例、1K/2K 和多图。
- 图像任务进入耐久任务与 outbox；失败不得丢失文字回答。

## 12. 双向语音

### 12.1 入站语音

```text
Telegram OGG/Opus -> STT -> text + metadata -> Operia / Opus
```

优先测试 ElevenLabs Scribe v2 与 Cloudflare-hosted Deepgram Nova-3。原始音频默认在
处理完成后删除；转写文本按普通会话规则处理。

### 12.2 出站语音

```text
Opus speak -> Agent Voice Tool -> ElevenLabs -> channel adapter
```

默认行为：

- 平时只发文字。
- `/voice` 让下一次回复使用语音。
- Opus 可在确实适合时偶尔主动调用 `speak`。
- `/voice-off` 禁止主动语音。
- 不默认每条同时发送文字和语音。

模型映射：

- `realtime` -> `eleven_flash_v2_5`
- `quality` -> `eleven_multilingual_v2`
- `expressive` -> `eleven_v3`

Telegram 使用 OGG/Opus voice note；格式不兼容时文本仍须先成功投递，音频进入可重试
任务或降级为 `sendAudio`。

### 12.3 Voice Studio

使用 `eleven_ttv_v3` 或当前可用 Voice Design 模型，根据年龄感、音域、速度、口音、
气声与情绪描述生成 3-5 个预览。用户选中后只保存 `voice_id` 和非敏感参数。

同一 voice profile 可供 TG、PWA 与未来 HA `media_player` 使用。

## 13. 安全、预算与失败恢复

- Cloudflare Access 仅是入口认证，不能替代应用权限。
- Worker 间使用 Service Binding 与独立 bearer。
- 所有能力绑定 owner/chat/task/policy/idempotency key。
- 记忆写入、HA 动作与高风险付费调用继续经过审批。
- 搜索、生图和语音设置单次大小、并发和每日预算上限。
- TTS 失败不得阻止文字回答。
- STT 失败应要求用户重发或选择文字，不生成猜测转写。
- PWA streaming 失败时显示明确错误，不重复 archive。
- 外部调用未知进入 `attention_required`。
- 管理面板与日志不得返回 bearer、token、cookie、原始语音或敏感 prompt。

独立回滚开关：

- `TG_FAST_PATH_ENABLED`
- `REASONING_TRACE_ENABLED`
- `DIRECT_MEDIA_TOOLS_ENABLED`
- `VOICE_ENABLED`
- `GROK_TOOLS_ENABLED`
- `AGENT_ORCHESTRATOR_ENABLED`

## 14. 实施阶段

### P0 秒回

- 自适应 debounce
- TG -> Operia Service Binding
- Operia 前处理与 TG 端到端分段耗时
- Telegram 保持最终整段/分泡发送
- PWA SSE 检查
- 真实 total 与调度耗时验收

### P1 缓存与工具验收

- cache A/B/C 实验
- 确定性工具 contract
- GLM 复杂规划
- 审批、取消、崩溃与未知态测试

### P1 Agent 与控制台收敛

- 稳定主模型工具面
- Agent 统一入口
- Command Ledger 私有 Agent Binding
- Reasoning Trace
- Tokens & Cache / Usage

### P2 Grok 与语音

- Grok 搜索和生图
- ElevenLabs Voice Studio
- Telegram 双向语音
- `/voice` 与偶发主动 `speak`

### P2 HA

- HA MCP provider
- 设备级 Policy 与审批
- `speak` 投递到 HA media player

## 15. 完成定义

本项目完成需同时满足：

1. 普通聊天不开启任何新增工具时行为与记忆语义不回归。
2. TG 最终消息、断线与重试均无重复发送或重复 archive。
3. 缓存面板只报告可验证数据，不把 null 解释为命中。
4. 直接工具与 GLM 工具边界可由测试证明。
5. Reasoning 不包含隐藏 CoT 或敏感上下文。
6. TG 入站语音、偶发出站语音和文字 fallback 均通过真实设备验收。
7. 所有新入口逐 hostname/path 验证 DNS、route、Access 与应用门禁。
8. 运维记录、根目录总表与私有 GitHub 同步完成。
