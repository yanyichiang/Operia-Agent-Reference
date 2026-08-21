---
title: Operia MCP Owner Transfer and Durable Community Skills
date: 2026-07-15
status: implemented
scope: MCP Gateway owner registry, Agent read projection, durable and community Skills
execution_cutover: executor_ready
---

# Operia MCP Owner Transfer 与 Durable Community Skills

> 2026-07-16 implementation amendment: the original `registry_only` phase is retained below as migration history.
> Production execution now uses the dedicated Gateway Service Binding transport and the bounded Skill executor
> defined in section 7. The Gateway remains the catalog/provider owner; Agent remains the execution-policy owner.

## 1. 本轮目标

本轮只完成两件事：

1. 将 MCP provider 注册、工具启停和 authoritative catalog 的写 owner 收回
   `mcp.example.com`；Agent 只保存带 owner version 的只读执行投影。
2. 将静态 Skills 升级为版本化、可安装、可禁用、可审计、可恢复的 durable/community
   系统，并创建不执行工具的 run/checkpoint 骨架。

真实远程 MCP `tools/list/tools/call`、Skill executor、HA、Browser 或其它工具调用不在本轮执行。

## 2. 唯一真源

| 事实 | Owner | 消费者 |
|---|---|---|
| MCP provider、Gateway route、tool enabled、provider/tool risk | MCP Gateway D1 | Agent、TG、CLI |
| MCP observed schema、执行 policy、approval、cache、task | Agent | TG、未来渠道 |
| Agent direct providers：Browser、Grok、Voice、HA、Observer | Agent | Agent/TG |
| Skill version、installation、trust、run/checkpoint | Agent DO SQLite | TG、CLI |
| Skill 社区 registry 与 publisher public key | Agent owner allowlist | Agent trust verifier |

投影不得接受 mutation；owner 不可达时显示 stale/unavailable，不用旧副本伪装当前值。

## 3. MCP owner transfer

### 3.1 Gateway owner model

Gateway 新增：

- 单行 registry meta：`revision`、`cutover_state`、`updated_at`；
- 版本化 provider/tool owner snapshot；
- admin mutation 继续写现有 `custom_providers` 与 `tool_settings`，成功后递增 revision；
- 受独立 service bearer 保护的只读 `/service/owner/mcp-registry`；
- 浏览器 owner API 使用 Access/domain session、Origin/CSRF 与 `If-Match` CAS；
- snapshot 不包含 token、ciphertext、Cookie、authorization 或上游 bearer。

Owner API 读取 D1 失败必须返回 503，不能退回“空 custom provider + 默认工具全部启用”。

### 3.2 Agent projection

Agent 增加 `MCP_GATEWAY` Service Binding 与独立 read bearer，持久化：

- `owner_revision`、`owner_version`、`observed_at`、`status`；
- 脱敏 provider/tool snapshot；
- projection hash 与最近同步错误码。

Gateway-owned provider 的 Agent `/manage/mcp` 注册、catalog mutation 和 delete 全部冻结并返回
`409 mcp_registry_owned_by_gateway`。Browser、Grok、Voice、HA 与 Observer 仍由 Agent 管理。

本轮 cutover 为 `registry_only`：Gateway 没有完整、已观测 input schema 的工具只进入目录投影，
不进入 executable catalog。Agent 现有 remote executor 不做真实调用；后续必须单独通过 schema
attestation、delegated allowlist、secret reference 和 E2E 才能切执行。

### 3.3 回滚

- 不删除 Agent 旧 `mcp_registry`；标记为 `legacy_readonly`，保留明确观测窗口；
- Gateway migration 只增表/列，不 DROP；
- owner projection 同步失败不改变最后已验证快照，但状态必须变 stale；
- 回滚仅切 registry projection read path，不覆盖或删除 Gateway D1 历史。

## 4. Durable/community Skills

### 4.1 不可变版本

`skill_versions` 保存：

- `skill_key`、显式 `alias`、SemVer、kind；
- 完整 canonical manifest、schema/source/content/manifest hash；
- allowed tool keys、steps 与风险声明；
- source type/registry、publisher/key id/public-key fingerprint/signature；
- trust status、published/installed timestamps。

同一 `skill_key + version` 不可覆盖；相同版本不同 hash 拒绝。

### 4.2 安装状态

`skill_installations` 保存精确 pinned version/hash、enabled、scope、update policy、revision、
installed_by 与 disabled reason。禁用是软状态，不删除版本和审计。

更新若新增工具、扩大 scope、改变 publisher 或提高风险，必须安装为 disabled 并等待 owner 审核。
所有写操作要求 domain session、Origin、CSRF、幂等键与 `If-Match` revision。

### 4.3 社区信任

- canonical JSON + SHA-256 manifest hash；
- Ed25519 publisher signature；
- 精确 source registry allowlist 与 publisher key allowlist；
- revoked、unsigned、未知 key、签名错误、manifest/hash 漂移均 fail-closed；
- 内置 Skill 使用 `builtin_release` trust，但仍遵循同一 manifest/hash 契约；
- 社区 prompt 始终是 task-level untrusted content，不能进入 system policy。

### 4.4 Durable run

`skill_runs` pin：installation revision、skill key/version/hash、owner/service/channel/chat、request
hash、input、permission snapshot、status、current step、completed step ids 与 planned call。

`skill_run_events` 追加 install/verify/enable/disable/update/plan/blocked/cancel/complete 事件；不保存
token、Cookie、原始工具秘密或未清洗工具结果。

本轮 `/skill` 只能：

1. 列出已安装且 enabled 的 alias；
2. 校验 pinned version/hash、信任、input schema、alias 唯一性和权限交集；
3. 创建或幂等复用 run；
4. 生成下一步 `planned_call` 或 `blocked`；
5. 返回 run id、状态和计划摘要。

它不得调用 `executeTelegramReadTool`、`invokeMcpTool`、Browser、fetch 或模型。真实 executor 以后另接。

## 5. 控制面

Agent 增加 `/tools/skills`：

- Installed：版本、hash、source、trust、enabled、revision；
- Updates：权限差异与是否需要重新审核；
- Publishers：key fingerprint、registry、revoked；
- Runs：planned/blocked/cancelled/completed 与 checkpoint；
- Audit：安装、验证、状态变化和 run events。

`/tools/browser` 只保留 Browser/Site Adapter，不继续承载 Skills 管理。TG 只列目录和创建 run。

## 6. 验收

- Registry 中 MCP provider/tool 只有 Gateway 一个写 owner；Agent direct providers 例外明确列出。
- Gateway owner snapshot 有 revision/ETag、严格 D1 错误和 secret redaction。
- Agent 对 Gateway-owned `/manage/mcp` mutation 返回 409，projection owner version 可回读。
- 未 attested schema 的 Gateway tool 不进入 executable catalog；本轮网络测试不发生 MCP 调用。
- Skill 签名篡改、未知 registry/key、撤销、alias 冲突、版本覆盖和权限扩大全部 fail-closed。
- `/skill` 创建 durable planned/blocked run，重放同 request hash 不创建第二 run，且 executor 调用数为 0。
- Agent/TG/MCP Gateway typecheck、合同测试和 Wrangler dry-run 全绿。
- Access、domain session、service bearer、CSRF/Origin、owner scope 与审计不放宽。

## 7. 2026-07-16 execution cutover

### 7.1 Gateway MCP transport

- Gateway owner snapshot advertises `cutoverState=executor_ready` and one fixed Service Binding route template.
- Registry reads and execution use different bearer credentials.
- Agent first reads the owner snapshot, then obtains live `tools/list` schemas through the private executor route.
- A tool enters Agent execution only when the provider and tool are enabled by Gateway, the live schema is current,
  the exact `provider/tool` key exists in `AGENT_DELEGATED_TOOL_ALLOWLIST`, and Agent policy accepts its risk.
- Gateway credentials remain at Gateway. Agent never receives provider keys, encrypted token fields, public client
  credentials or upstream URLs.
- Owner/schema projection older than one hour fails closed. Disabled, stale, missing or drifted tools do not execute.

### 7.2 Skill executor

- `deterministicWorkflow` advances the existing pure state machine one step at a time and converts every planned
  call into an idempotent Agent delegated task.
- Tool execution reuses the same catalog attestation, policy, cache, side-effect ledger, cancellation and sanitizer
  as ordinary delegated tools. The state machine itself still performs no I/O.
- Telegram replays reuse the existing run and step idempotency keys; completed results are handed to Opus for the
  final user-facing response.
- Prompt and Reference Skills never become system instructions. They are returned as bounded, untrusted tool
  results to Opus. Script, shell, arbitrary network and permission expansion remain forbidden.
- The first cutover permits only read-risk workflow steps. Non-read steps continue through the ordinary delegated
  approval task rather than a synchronous Skill shortcut.

### 7.3 Browser planner regression

- `browser_task` is in the default executable allowlist and is the planner's first choice for typed multi-step work.
- `browser_execute` remains a compatibility fallback and retains strict Acorn AST, literal URL/method, domain and
  human-handoff validation.
- Invalid generated JavaScript is a definitive pre-execution failure, not an uncertain side effect.
- Typed action results retain a bounded final payload so questionnaire submission and result inspection can return
  the actual result to the planner and ultimately to Opus.
