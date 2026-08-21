---
date: 2026-07-13
status: approved
scope: Operia Agent, Browser Run, GLM tool worker, MCP, Skills, caching, approvals
---

# Operia Agent-Owned Browser 与工具运行时设计

## 实施状态（2026-07-15）

- P0 已落地：Quick Actions、DO tool cache/checkpoint/retention、作用域隔离、模型 usage、
  Browser 工作台和 owner-only 生产边界。
- P1 代码面已落地：Worker Loader、Code Mode、dynamic/reuse session、Live View、审批、拒绝/
  超时/crash recovery、recording opt-in 与 session sweep。通用 `browser_execute` 每次都必须
  先产生 human handoff；输入或外部副作用与批准的 proposed action 绑定。Live View URL
  由控制面按需签发，不作为 Code Mode 参数或重放日志持久化。2026-07-15 升级
  Workers Paid 后，生产已恢复 `LOADER` binding 并启用 interactive flag；部署版本
  `<UUID>` 已由控制页回读 `Browser Run ready`、
  `Worker Loader ready`、`browser_execute enabled`。Quick Action smoke 访问
  `developers.cloudflare.com` 完成；固定只读 E2E 已验证 Workflow、Browser、Code Mode 和
  side effect 全部完成。控制台只允许批准自身固定 E2E，通用 owner 审批仍走渠道边界。
- Opus prompt cache 已从单一 `5m` 改为混合 TTL：稳定 system/persona/tools prefix 使用
  `1h`，会话桥接与 rolling tail 使用 `5m`。AI Gateway full-response cache 继续显式 bypass，
  避免把个性化记忆或工具意图作为整段响应重放。
- P2 已落地：versioned Site Adapter、受限 Skills、Telegram `/tool`、`/skill`、`/browser`、
  `/think_*` 与 `/usage`，以及 fail-closed 远程 MCP executor。原版 OpenCLI remote executor
  仍按本 spec 的非目标保持未安装；Browser Run 覆盖不了的 Electron/本机登录态出现真实
  需求后再单独评估。
- 生产 planner 使用 `@cf/zai-org/glm-4.7-flash`，应用层每日硬上限 300 次；这里保留的
  “GLM-5.2”代表可替换的工具 worker 角色，不再是上线前置条件。
- 远程 MCP 只有在 registry、现场 observed catalog、精确 `server/tool` allowlist 和
  `AGENT_REMOTE_MCP_*` Wrangler secret 同时存在时才可执行；Operia memory MCP 继续只走
  Worker Service Binding，禁止经远程 executor 绕行。
- xAI、ElevenLabs 与 Home Assistant 代码面已接好但生产保持 disabled，直到对应凭据和
  allowlist 显式配置；禁用态不会回退到匿名或其它供应商。

## 1. 决策

Operia 增加一套不依赖用户本机在线的 Agent-owned cloud browser。浏览器运行在
Cloudflare Browser Run，由 Agent Durable Object 持有运行状态，并通过 CDP 完成
页面观察、导航、交互、截图、网络与控制台检查。

用户消息不经过前置 router。Opus 4.6 始终是唯一主对话模型、语义所有者与最终回答者。
GLM-5.2 只在 Opus 调用 `delegate_action` 后启动，负责低成本、多步骤工具编排和
Browser Run 执行循环。确定性命令、静态 policy、审批、幂等、投递和缓存决策不用模型。

原版 OpenCLI 不作为 P0 运行依赖。系统吸收其“将网站沉淀为稳定 CLI/adapter”的思想，
在 Cloudflare 运行时实现 Site Adapter Registry。未来如某些网站只能使用本地登录态，
OpenCLI bridge 可以作为可选 executor 接入，但不进入主 Agent Worker bundle。

P0 不新增 Workers KV binding。高频缓存、工具结果、任务 checkpoint 与浏览器 session
引用写入现有 SQLite-backed Agent Durable Object；公共、无身份的短期 GET 结果可选择
Workers Cache API；大对象继续进入私有 R2。

## 2. 用户体验目标

目标体验不是“遥控用户当前 Chrome”，而是：

> Agent 拥有一台自己的云端浏览器。它可以自主观察、点击、输入、等待和验证；用户能在
> 登录、MFA、CAPTCHA 或敏感动作前打开 Live View 观看或接管，任务随后从同一 session
> 继续。

用户应能从 Telegram、Operia、未来 HA 或 Agent 控制台发出同一类目标，例如：

- “打开这个网站，看看今天有什么变化。”
- “登录后检查我的订单，但不要修改任何内容。”
- “把表单填好，提交前给我确认。”
- “以后这个网站不要每次重新研究，做成一个可复用工具。”

普通聊天不得因为 Browser、GLM 或动态工具 catalog 增加额外模型调用。

## 3. 非目标

- 不让 GLM 接管人格、记忆、用户意图或最终回答风格。
- 不把完整 Operia 对话、人格或长期记忆复制到 GLM/Browser 上下文。
- 不让网页内容、MCP 描述、Skill 文本或模型生成代码改变系统 policy。
- 不为 Browser Run 创建第二套长期记忆数据库。
- 不在 P0 自动执行发送、发布、购买、删除、账号设置或设备控制。
- 不把动态 MCP tools、Skills 或网页 adapter 全量同步为 Telegram 原生命令。
- 不把用户 Cookie、页面正文、表单秘密或截图写入可公开日志。

## 4. 总体架构

```text
Telegram / Operia / HA / future channels
                    |
                    v
         Operia Memory + Opus 4.6
      persona / identity / recall / reply
                    |
        +-----------+------------+
        |                        |
        v                        v
 direct expressive tools   delegate_action
 search / image / voice           |
                                  v
                         GLM-5.2 Tool Worker
                                  |
                    +-------------+-------------+
                    |             |             |
                    v             v             v
              MCP executors    Skills      Browser Runtime
                                             |
                                    Quick Actions / CDP
                                             |
                                    Cloudflare Browser Run
                                             |
                         Policy -> approval -> result sanitizer
                                             |
                                  bounded evidence bundle
                                             |
                                             v
                                          Opus 4.6
```

物理部署继续保持 Memory、Agent、Channel 三个 Worker。Browser Run 是 Agent Worker 的
binding，不新建记忆服务，也不要求用户 Mac、Chrome 或 <HOME_BUILD_SERVER> 常驻。

## 5. 当前实现基线与约束

- Agent 当前固定路由到单个名为 `primary` 的 `<AgentRuntime>` Durable Object，
  并非旧设计中的 per-chat Agent。P0 不拆分或迁移 DO，但所有 Browser/cache/session key
  必须显式包含 `ownerId + serviceId + chatId + taskId/runId` 派生 scope，不能依赖对象名
  隔离。
- Opus 顶层只看到统一 Web 入口 `browse_web(task, starting_url?)`，不再在
  `browser_markdown` 与 `search_web` 之间做语义边界脆弱的二选一。Agent 先用确定性规则
  将明确单页读取路由到 Browser quick action、明确检索路由到 Grok；点击、导航、登录、
  表单、翻页、持续观察以及歧义目标统一进入 `delegate_action` 与 GLM planner。
  `browser_markdown`、`search_web` 保留为隐藏兼容接口；tool schema 变更必须版本化并接受
  prompt-cache prefix 重建。
- 现有 Agent capability registry 将 `tools.browser` 固定为 disabled，验证脚本也禁止
  Browser binding/import。实施必须先以测试驱动修改 capability 与验证合同，不能只加
  Wrangler binding。
- `agents` 当前精确固定为 `0.17.4`，`@cloudflare/codemode` 精确固定为 `0.4.3`，
  静态程序审查器使用直接依赖 `acorn@8.17.0`。Browser Run/Code Mode 是更新中的 beta API；P0
  必须先在独立 compatibility worktree 验证该版本是否具备目标 API。若必须升级 SDK，
  升级、Browser 功能和生产切流使用分离提交，并完整回归 MCP、Fiber、审批、DO 状态与
  Telegram continuation。
- GLM planner 当前运行在 `primary` DO 的 delegated task/Fiber 内。P0 保持这一物理
  结构，不额外部署 tool-worker Worker；只有 bundling、权限隔离或独立扩缩容出现可验证
  需求时才通过 Service Binding 拆分。
- 当前 Context Capsule 对 GLM 主要是 opaque reference。Browser task 若需要上下文，
  由 Agent 服务端根据 purpose/scope 解析成 redacted task context；不得让 GLM 直接解析
  capsule、调用 Memory SQL 或接收完整对话。
- 当前 Opus tool-call 中间轮在主 usage 记录前返回，GLM planner 也没有完整 token、耗时、
  fallback 与 cache 观测。P0 在评估 Browser/cache 收益前必须先补齐这两条 usage 记录。
- Agent DO 已有 delegated task checkpoint、幂等、side-effect 与 approval 表，但缺少
  browser/tool-result cache 和统一 retention。新增表必须同时定义 sweep/TTL，不能继续
  只增不删。

## 6. 职责边界

### 6.1 Opus 4.6

Opus 负责：

- 理解用户真正目标、限制、语气和完成标准；
- 读取 Operia 自动召回以及显式记忆工具；
- 判断使用直接工具还是 `delegate_action`；
- 为 GLM 构造最小 Context Capsule；
- 审阅工具 evidence bundle，处理歧义并生成最终回复；
- 决定何时使用生图或语音等表达型能力。

Opus 不接收原始 DOM、完整截图 base64、CDP traffic、逐步 tool trace 或完整网页正文。

### 6.2 GLM-5.2 Tool Worker

GLM 负责：

- 将目标编译成有界执行计划；
- 在 allowlisted capability 中选择 MCP、Skill、adapter 或 Browser Run；
- 进行观察、动作、验证、失败恢复和最多一次重新规划；
- 将原始网页状态压缩为结构化 evidence bundle；
- 在需要登录、MFA、CAPTCHA 或审批时暂停并返回明确 handoff。

GLM 不得直接读取 Operia 记忆数据库、修改 persona/profile、向渠道发送消息或覆盖 policy。

### 6.3 确定性层

以下能力始终不用模型：

- Telegram `/status`、`/cancel`、审批 callback 与开关；
- schema 校验、canonical args hash、风险分类和 allowlist 交集；
- 幂等、cache key、TTL、失效、预算和结果大小限制；
- approval ticket 生成、校验、消费和 replay 防护；
- outbox 投递、重试和未知外部副作用收口；
- 已有稳定 Site Adapter 的参数解析与结果映射。

### 6.4 Browser Runtime

Browser Runtime 只负责浏览器执行和 session 生命周期，不拥有用户意图。它由 Agent DO
创建，使用 Browser Run `BROWSER` binding、Worker Loader `LOADER` binding 与
`CodemodeRuntime` export。

## 7. 主模型工具面

Opus 顶层工具 schema 保持稳定，不因 MCP、Skills 或 Site Adapter 数量变化而改变。

### 7.1 Operia-owned tools

- `request_context`
- 显式 memory/profile 工具

这类工具继续由 Operia 直接执行，不经过 GLM。

### 7.2 Unified Web and direct expressive tools

- `browse_web`（Opus 唯一 Web 入口）
- `generate_image`
- `speak`

`browse_web` 内部保留 `browser_markdown` 与 `search_web` 的单步确定性 fast path，但不向
Opus 暴露 provider 选择。任务需要多来源串联、浏览器登录态、点击、复杂选择、动态恢复，
或路由语义不够确定时，fail toward `delegate_action`；升级只增加策略与审批检查，不绕过门禁。

### 7.3 `delegate_action`

```json
{
  "goal": "最终目标",
  "constraints": ["明确限制"],
  "context_ref": "purpose-bound capsule id",
  "allowed_capabilities": ["browser.read", "mcp.maps"],
  "success_criteria": ["可验证的完成条件"],
  "output_contract": "返回给 Opus 的结构",
  "risk_hint": "read"
}
```

服务端重新计算 capability 和风险；模型提供的 `allowed_capabilities` 与 `risk_hint` 只能
缩小权限，不能扩大权限或降低风险。

## 8. Capability Catalog 与 Skills

统一发现面使用以下只读投影：

```ts
type CapabilityEntry = {
  kind: "mcp_tool" | "skill" | "site_adapter" | "internal_tool";
  key: string;
  executorId: string;
  inputSchema: JSONSchema;
  riskLevel: "read" | "message" | "device" | "purchase" | "delete";
  sourceHash: string;
  requiredCapabilities: string[];
  allowedToolKeys?: string[];
  telegramAlias?: string;
  enabled: boolean;
};
```

有效权限为：

```text
owner/channel scope
  intersect global allowlist
  intersect task capsule scope
  intersect Skill allowlist
  intersect executor capability
```

Skills 第一阶段只支持：

- `prompt`: 给 Opus 或 GLM 增加受 hash 固定的任务指令；
- `deterministicWorkflow`: 调用一组固定 adapter/tool，仍逐项经过 policy；
- `reference`: 提供静态模板、schema 或领域参考。

带 shell、任意脚本或任意网络请求的 Skill 默认 disabled，待独立 Sandbox spec。

Telegram 未来只增加两个稳定入口：

- `/tool <alias> key=value`
- `/skill <name> args`

BotFather 菜单只同步人工审核的 alias；动态 catalog 通过控制台或 `/help` 子菜单发现。

## 9. Browser 执行模式

### 9.1 Quick Actions

公共、只读、单页面任务优先使用 `browser_markdown`、`browser_extract`、
`browser_links`、`browser_scrape`。这类任务不需要 Worker Loader 或持久 session，
结果必须设置字符上限并经过 sanitizer。

### 9.2 Interactive Browser Run

多步骤、JavaScript 页面、登录态或需要截图/控制台/network 的任务使用
`browser_execute`。GLM 生成顺序 CDP 调用；禁止并行 CDP 操作和无限循环，设置总步骤、
单步、总 wall time、输出字节和 domain budget。

Session mode：

- `one-shot`: 默认；公共只读任务，结束后确定性销毁；
- `dynamic`: 登录或人工接管后才提升为持久 session；
- `reuse`: 仅给用户明确授权的稳定站点 profile，使用 owner + adapter 派生的固定 key。

持久 session 引用保存在 Agent DO，Cookie 由 Browser Run session 持有，不复制进 D1、
KV、日志或模型上下文。定时 `sweep()` 回收过期 session，`expirePaused()` 清理长期未批准
的 pause。

### 9.3 Site Adapter

稳定网站应从通用浏览器循环升级为 Site Adapter：

```text
goal -> typed adapter command -> deterministic browser/API steps -> typed result
```

Adapter 必须包含：

- 固定 domain allowlist；
- 输入/输出 schema；
- source hash 与版本；
- read/write 风险；
- 选择器或 API 解析合同；
- 登录态需求；
- 最大页面、步骤、结果和媒体大小；
- smoke fixture 与失效条件。

网页变化导致 source hash、关键 selector 或响应 schema 漂移时 fail closed，退回只读探索，
不得静默猜测并执行写操作。

## 10. 浏览器写操作与审批

Browser Run 的通用 CDP 面能力很大，因此 P0 自动路径只开放 Quick Actions 和只读
Site Adapter。通用 `browser_execute` 的交互任务至少需要 task-level approval。

外部副作用使用两阶段合同：

```text
prepare
  -> 导航、读取、填写草稿、生成预览
  -> 返回目标、变化摘要、截图引用与 canonical action hash
approve
  -> 单次 ticket 绑定 owner/task/session/domain/action hash/expiry
commit
  -> 在同一 Browser Run session 执行最终 click/submit
  -> 读取成功证据并消费 ticket
```

以下动作必须在最终一步单独批准，不能只批准“浏览这个网站”：

- 发送消息、邮件、评论或发布内容；
- 购买、付款、下单或兑换；
- 删除、取消、解绑或覆盖；
- 修改账号、安全、权限或共享设置；
- 上传私人文件、输入密码、OTP、支付或身份信息；
- 控制 HA 设备或产生现实世界动作。

CAPTCHA 只允许用户通过 Live View 完成。Agent 不自动绕过，也不把验证码图像交给其它模型。

## 11. Evidence Bundle

GLM 返回给 Opus 的结果必须是有界结构，不是原始执行 transcript：

```json
{
  "status": "completed",
  "summary": "完成了什么",
  "facts": [{"claim": "事实", "source": "页面 URL 或 artifact ref"}],
  "artifacts": [{"kind": "screenshot", "ref": "agent-media:uuid"}],
  "state_delta": [{"kind": "none", "target": "example.com"}],
  "approval": null,
  "cache": {"status": "miss", "key_prefix": "browser.read"},
  "timing": {"total_ms": 0, "browser_ms": 0},
  "warnings": []
}
```

最大返回大小由 output contract 限制。完整 rrweb recording、截图和大页面内容进入私有
R2 或 Browser Run recording，不进入 Opus prompt。

## 12. 缓存设计

缓存分层，不能把“模型 prompt cache”“工具结果 cache”“浏览器 session”混为一类。

| 层 | 数据 | 存储 | 写入频率 | P0 |
|---|---|---|---|---|
| Opus prompt cache | 稳定 system/persona/tools/history prefix | Anthropic/AI Gateway | provider 管理 | 保留现状 |
| Context Capsule | purpose-bound 上下文引用 | Operia/Agent 既有存储 | 每 delegated task 少量 | 保留现状 |
| Tool Result Cache | 只读工具的有界结果 | Agent DO SQLite | 命中时零写，miss 后一写 | 新增 |
| Browser checkpoint | task/session/approval 语义边界 | Agent DO SQLite | 每任务约 3-8 次 | 新增 |
| Site Adapter Registry | schema/hash/policy | 代码 bundle + 既有 registry | 部署或人工编辑 | 新增投影 |
| 公共 HTTP Cache | 匿名 GET/公开文档 | Workers Cache API | 按 TTL | 可选 |
| 大型 artifacts | screenshot/audio/image/record ref | 私有 R2 | 按任务 | 复用 |
| Workers KV | 低频全局 hint（如未来需要） | KV | 极低频 | 不绑定 |

### 12.1 为什么 P0 不用 KV

Workers KV Free 当前每个账户每日只有 1,000 key writes，且 dashboard、Wrangler 与 REST
写入也计数。浏览器任务若每一步写 KV，一次 30 步任务就会消耗 3% 日额度；多次会话、
日志、TTL 刷新和 adapter 更新会快速触顶。KV 也不是强一致任务 checkpoint 的正确位置。

SQLite-backed Durable Objects Free 当前提供每日 100,000 rows written、5,000,000 rows
read 和 5 GB 总存储。现有 Agent 已经是单 owner 的 SQLite DO，适合强一致、低延迟、
按 task 聚合写入的 cache/checkpoint。

因此：

- 不创建 `AGENT_CACHE_KV`；
- 不把 browser step、usage、session heartbeat 或 tool trace 写 KV；
- 只在 task 创建、计划完成、等待审批、commit 完成和 terminal 五类语义边界落盘；
- 连续浏览器观察保留在 durable Code Mode log，由 Browser Runtime 管理；
- 将同一事务内的 task、cache metadata、audit 变化批量写入 SQLite。

### 12.2 Tool Result Cache key

```text
sha256(
  tool_key
  + canonical_args
  + owner_scope_hash
  + provider_version
  + schema_hash
  + policy_version
  + adapter_source_hash
)
```

cache value 只保存 sanitizer 后结果或 R2 opaque ref。禁止保存 bearer、Cookie、OTP、
密码、完整私人页面、原始 DOM、表单 secret 和未经裁剪的模型输入。

### 12.3 TTL 默认值

| 类型 | TTL | 备注 |
|---|---:|---|
| 公共静态文档 | 30 分钟 | ETag/source hash 可延长 |
| 普通网页搜索 | 2 分钟 | 时效请求可强制 bypass |
| MCP 只读目录/metadata | 5 分钟 | schema hash 变化立即失效 |
| 系统健康 | 15 秒 | 错误结果不缓存 |
| HA 状态 | 0-3 秒 | 默认不缓存；同一执行 batch 可复用 |
| 登录后私人页面 | 0 | 仅显式 adapter 可按 owner scope 开启 |
| mutation/审批结果 | 0 | 永不作为可复用成功结果 |
| adapter exploration | 10 分钟 | 仅结构，不保存私人正文 |

用户可对单任务指定 `fresh=true`；高时效关键词不能由脚本单独决定，但 Opus 可在
`delegate_action` 中要求 bypass，服务端仍应用预算。

### 12.4 失效

以下任一变化立即 miss：

- tool/provider/schema/policy/adapter version 变化；
- owner、channel、recipient 或 context scope 变化；
- 同 namespace 完成 mutation；
- 用户要求刷新；
- 上游返回 ETag/Last-Modified 变化；
- 登录态或 Browser Run session reset；
- sanitizer 版本变化。

mutation 完成后按 tag 删除受影响 cache rows。删除计入 SQLite rows written，因此按
namespace 批量失效或标记 generation，不逐 key 大量删除。

### 12.5 Prompt cache 保护

Opus 的稳定 prefix 继续是 Operia-owned blocks、persona/profile、固定顶层 tool schema 和
稳定历史。以下内容只进入 GLM/tool task，不进入 Opus 主历史：

- 原始 DOM 与截图；
- CDP code 与 debug log；
- MCP 中间结果；
- adapter exploration；
- approval 前的临时表单值；
- Browser Run recording。

Opus 只收到固定 schema 的 Evidence Bundle。这保证工具循环不会破坏主模型 prompt cache
形状，并限制 continuation token 成本。

生产请求使用两层 Anthropic cache breakpoint：稳定 system/persona/tool schema 为 `1h`，
会话历史桥接与最新可复用尾部为 `5m`。TTL 顺序若反转则 fail closed；工具续轮也必须把
`tool_use` / `tool_result` 纳入同一稳定 wire 形状。控制台指标的分母统一为
`input + cache_creation + cache_read`。

AI Gateway 的 response cache key 覆盖完整请求。Operia 每轮都含用户消息、召回记忆和可能
变化的工具状态，因此整段 response cache 命中既困难，也可能重放过期人格、记忆或动作
意图。生产继续发送 `cf-aig-skip-cache: true`；Dashboard 的 Gateway `MISS` 不等于
Anthropic prompt cache 失效。成本优化只看 provider 返回的 cache read/create tokens。

2026-07-15 上线前 24 小时基线为 12 个 Anthropic 请求，其中 7 个请求读到 prompt cache；
cache read share 为 `38,588 / (14,093 + 28,860 + 38,588) = 47.32%`。目标是稳定前缀充分
预热后的会话窗口达到 90% 以上；24 小时总盘能否达到 90-95% 取决于冷启动频率和每个
稳定前缀后的真实轮数，必须用后续生产观察证明，不能靠 keepalive 消耗额外 Opus token。

### 12.6 GLM cache

P0 不为 GLM 单独设计跨任务结果缓存。GLM prompt 使用稳定 policy、capability schema 与
Browser instruction prefix，记录 cache read/create 指标；只有观测到实际成本或延迟后再
决定是否增加 planner cache，不能为便宜模型提前引入一致性复杂度。

## 13. 数据模型

在现有 Agent DO SQLite 增量增加，不建立新 D1 或 KV 真源：

```sql
CREATE TABLE tool_result_cache (
  cache_key TEXT PRIMARY KEY,
  tool_key TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  result_json TEXT,
  result_ref TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  hit_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE browser_sessions (
  session_key TEXT PRIMARY KEY,
  owner_scope_hash TEXT NOT NULL,
  adapter_key TEXT,
  browser_session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  last_url_origin TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE browser_task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  artifact_ref TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
```

不得存储完整 URL query、Cookie、localStorage、密码、OTP、私人表单正文或完整 CDP payload。
`last_url_origin` 只保留 scheme + host + port。

Retention：

- expired tool cache：每日 sweep，先按 batch 标记 generation/expired，再分批删除；
- terminal browser task events：30 天；只保留计数与错误类别的聚合统计；
- closed/expired browser session refs：7 天；Browser Run session 本体立即 close/sweep；
- ordinary audit：沿用现有审计 retention，含 secret 的字段不允许进入表；
- R2 临时 screenshot/artifact：默认 24 小时 lifecycle；
- sweep 每批必须小于 SQLite bind/row budget，失败可幂等重试。

## 14. 安全模型

### 14.1 网页提示注入

网页正文始终标记为 untrusted evidence。任何页面中的“忽略规则”“复制 token”“上传文件”
或“执行命令”都只是网页内容，不能成为工具指令。GLM system policy、Context Capsule 和
server-side capability catalog 优先级不可由页面覆盖。

### 14.2 Egress 与 domain

- 每个 Browser task 都有 domain allowlist；
- `agent.browser.domain_allowlist` 由 Agent Durable Object 作为唯一真源持有；Wrangler 环境变量
  只在 state schema 迁移时 seed 一次，后续部署不得覆盖控制台修改；
- 首版只允许精确 HTTPS hostname，不接受 wildcard、URL、localhost、IP 或内部域名；
- 控制台 mutation 必须经过域会话、Origin/CSRF 与 `If-Match` revision CAS；冲突重新加载，
  清空列表需要二次确认并保持 deny-all；
- 显式导航 URL 在执行前校验；交互点击、脚本导航或重定向产生的越域 page target 会被关闭，
  当前执行失败，用户把目标 hostname 加入 allowlist 后重新发起；
- 禁止访问 link-local、metadata、localhost、私网 IP 和 Cloudflare 内部绑定；
- 下载默认拒绝；允许时进入私有 R2 quarantine，并限制 MIME、大小和文件名；
- 上传必须使用用户明确提供的 artifact ref，并在 action-time 审批。

### 14.3 账号态

- 每个 owner/site 使用独立 session key；
- Live View URL 短时有效，不进入聊天长期记忆；
- session 列表只显示站点、状态、最后使用时间和 expiry；
- 用户可在控制台单独 revoke/reset 某站点 session；
- Access 登录不能替代站点自身认证或应用层审批。

### 14.4 记录

默认记录结构化 audit，不默认录制完整 Browser Run session。只有用户打开调试录制或高风险
任务需要复盘时启用 recording；录制保留期采用供应商上限内的更短应用策略，并在控制台
可见。截图默认 24 小时 R2 lifecycle，明确收藏的 artifact 另行迁移。

## 15. 控制台

`agent.example.com` 工具目录新增 `Browser & Web`，点击进入独立工作台：

- Provider 状态：Browser Run、Worker Loader、GLM、R2；
- Sessions：站点、mode、状态、最后使用、过期、Live View、reset/close；
- Site Adapters：版本、source hash、风险、测试状态、启用开关；
- Policies：可编辑 domain allowlist、owner/source/revision、下载/上传、登录态、审批规则；
- Cache：Opus cache 指标、tool result hit/miss、DO rows read/write、R2 artifacts；
- Tasks：阶段、耗时、浏览器步骤、approval、evidence 与错误；
- Logs：结构化 audit 和可选 recording，不显示 secret 或完整私人内容。

工具目录首页仍只展示摘要；所有调参、session 与日志在 Browser 工作台内完成。

## 16. 可观测性与预算

每个任务至少记录：

- main model、GLM model 与 service tier；
- Opus input/output/cache read/cache create；
- GLM input/output/cache read/cache create；
- tool cache hit/miss/bypass/invalidated；
- Browser Run session mode、步骤数、browser time、Live View/approval 次数；
- DO rows read/written、R2 bytes 与 artifact count；
- 最终状态、错误类别和是否产生外部副作用。

P0 单 owner 预算：

- 每个 delegated task 最多 20 次工具调用；
- 每个 Browser task 最多 30 个顺序 CDP step；
- 最多一次 GLM replan；
- 最多 3 个 tabs；
- 默认最大 5 分钟，登录/审批暂停不计模型 loop；
- Evidence Bundle 默认 24 KiB；
- 自动 screenshot 最多 5 张；
- DO checkpoint 目标 3-8 rows/task，不按每个 CDP step 写业务表。

达到预算后返回 `attention_required`，不自动扩大限制。

## 17. 实施阶段

### P0：只读 Browser 与缓存底座

1. 在兼容性 worktree 验证当前 pinned Agents SDK 与 Browser Run API；必要升级单独提交。
2. 先修正 Browser-disabled 测试合同，并保持默认 flag 为 false。
3. 补齐 Opus tool-call 中间轮与 GLM planner 的 usage/cache/timing 观测。
4. 增加 `BROWSER` binding、Quick Actions 和 Browser capability registry。
5. 新增 DO SQLite `tool_result_cache`、`browser_sessions`、`browser_task_events`、cache
   metrics 与 retention；不新增 KV 或 D1 migration。
6. 为单个 `primary` DO 增加 owner/service/chat/task scope key 与碰撞测试。
7. GLM delegated task 支持公共只读网页，Opus 只接收 Evidence Bundle。
8. 控制台增加 Browser 工作台的 Provider、Tasks、Cache 和 Logs 只读页面。
9. 生产只开放 owner、read-only、allowlisted domains。

### P1：持久 session、Live View 与审批

1. 增加 Worker Loader、`CodemodeRuntime` 与 `browser_execute`。
2. 支持 dynamic/reuse session、sweep、expirePaused、reset 与 close。
3. 支持 Live View 登录/MFA/CAPTCHA handoff。
4. 实现 prepare/approve/commit，通用 interactive task 默认 task-level approval。
5. 增加 recording opt-in、R2 artifact lifecycle 与异常恢复。

### P2：Site Adapters、Skills 与渠道入口

1. 将高频网站沉淀为 typed Site Adapter。
2. 接入 prompt-only Skills 和 deterministicWorkflow。
3. 增加 allowlisted `/tool`、`/skill` 与 `/browser` 状态入口。
4. 评估 OpenCLI remote executor，只用于 Browser Run 无法覆盖的登录态或 Electron app。
5. 在真实使用数据基础上决定 GLM planner cache 与 Workers Paid 配额。

## 18. 验收标准

### 普通聊天

- 不调用 GLM、Browser 或 MCP；
- 顶层 tool schema 与 prompt cache anchor 不因 catalog 变化；
- TG/PWA 延迟不回退。

### 只读浏览

- Opus 调用一次 `browse_web`；
- 明确单页读取不调用 GLM，交互或歧义目标才由 GLM 完成浏览并返回 bounded Evidence Bundle；
- 原始 DOM/CDP/screenshot 不进入 Opus 历史或记忆提取；
- 同 args/scope/version 在 TTL 内命中 tool result cache；
- `fresh=true` 可验证 bypass。

### 登录与人工接管

- 控制面按需生成短期 Live View URL，Code Mode 只持久化 reason/proposed action；
- 用户登录后任务从同一 session、tabs 和 Cookie 继续；
- Live View URL 过期后可刷新，但不进入日志正文；
- session reset 后旧 cache/session ref 失效。

### 写操作

- 未批准不能执行最终 submit/click；
- Code Mode 的危险全局、`cdp.send` 方法、literal navigation URL 与真实
  `cdp.humanHandoff(...)` 必须基于 AST 节点校验，不得扫描原始字符串；普通页面文案、注释、
  模板 raw text 不得误触，模板插值与真实调用仍须 fail-closed。`Runtime.evaluate` 的页面表达式
  另做第二层 AST 审查，并继续禁止网络全局、动态代码、Cookie 与 Web Storage。
- ticket 绑定 owner/task/session/domain/action hash/expiry；
- replay、参数变化、过期、错误 owner 或 session reset 均被拒绝；
- 外部结果未知时进入 `attention_required`，不得自动重放。

### 缓存与额度

- 生产无 Agent cache KV binding；
- browser step 不产生 KV write；
- DO 业务 checkpoint 平均不超过 8 rows/task；
- 控制台可见 DO rows read/write、cache hit/miss 和 R2 artifact；
- mutation 永不命中可复用成功结果，并使相关 generation 失效。
- Opus tool-call 中间轮和 GLM planner 均能显示 model、tokens、cache read/create、
  TTFT/total 或 planner duration、fallback 与 error category。
- 同一 `primary` DO 内，不同 owner/service/chat/task 不能互读 cache、session 或 artifact。

### 安全

- 页面 prompt injection 不能扩大 capability；
- 新 domain、下载、上传、支付、删除、消息发送与设备动作按规则暂停；
- audit、错误、Evidence Bundle 和 memory 中无 secret、Cookie、OTP 或完整私人页面。

## 19. 回滚

- `BROWSER_ENABLED=false`：隐藏 Browser capability，不影响 MCP、Voice、Grok 或普通聊天；
- `BROWSER_INTERACTIVE_ENABLED=false`：保留 Quick Actions，关闭 `browser_execute`；
- `SITE_ADAPTERS_ENABLED=false`：退回通用只读浏览；
- `TOOL_RESULT_CACHE_ENABLED=false`：旁路 cache，不删除表；
- 删除 `BROWSER/LOADER` binding 前先关闭并 sweep session；
- DO 新表为附加状态，不需要迁移或修改 Operia Memory D1/Vectorize；
- TG `TG_AGENT_ENABLED=false` 仍可回退现有直连 Operia 普通聊天。

## 20. 当前外部限制基线

以下数值于 2026-07-13 根据 Cloudflare 官方文档复核，实施前仍需再次核验：

- Workers KV Free：100,000 reads/day、1,000 writes/day、1,000 deletes/day、
  1,000 list/day、1 GB；任一日限额超出后相应操作失败。
- SQLite Durable Objects Free：100,000 requests/day、5,000,000 rows read/day、
  100,000 rows written/day、5 GB total storage。
- Browser Run：Browser session 运行在 Worker isolate 外；Quick Actions 可无 Loader；
  interactive `browser_execute` 需要 Browser + Loader 和 durable runtime；dynamic/reuse session
  可跨 hibernation/approval 保留 tabs 和 Cookie。
- Workers Cache API 为数据中心本地 cache，不作为强一致、全局或任务 checkpoint 存储。

参考：

- https://developers.cloudflare.com/agents/tools/browser/
- https://developers.cloudflare.com/kv/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workers/runtime-apis/cache/
