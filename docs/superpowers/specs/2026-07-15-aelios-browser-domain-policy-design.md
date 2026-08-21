---
date: 2026-07-15
status: accepted
scope: Operia Agent Browser, Telegram approvals, domain policy, control plane
---

# Operia Browser 域策略、临时授权与恢复设计

## 1. 决策

Browser 域权限继续由 `agent.example.com` 单独拥有。现有永久精确 hostname allowlist
保留，但不再把未知跨域导航直接升级为不确定工具副作用。系统增加确定性的域策略预检、
任务级临时 grant、Telegram 域挑战和同一 Agent task 的恢复路径。

最终优先级为：

```text
协议与 SSRF 硬拒绝
  > owner denylist
  > 永久 allowlist
  > 同注册站点规则
  > task / once 临时 grant
  > 未授权跨站挑战
  > 默认拒绝
```

黑名单是 deny override，不是安全主线。未知恶意域不能依赖黑名单穷举；HTTPS、无
userinfo、无显式端口、非 IP、非 localhost/local/internal 与精确 scope 仍是基础门禁。

## 2. 用户体验

当 `openpsychometrics.org` 导航到 `ojts.com`：

1. Browser 报告来源和目标，不把它记作 `uncertain_tool_side_effect`；
2. Telegram 提供“仅这一次”“本任务允许”“永久允许”“拒绝”；
3. 批准后 grant 写入 Agent owner store，原始 Browser call 在同一 Agent task 中重试；
4. 若页面随后需要点击、输入或提交，再生成独立的人机 handoff 审批；
5. 多张审批票串行存在，不覆盖、不复用旧 callback，也不要求 Opus重新发起用户任务。

普通同站跳转自动继续。已在永久 allowlist 的跨站目标自动继续。未授权跨站目标必须暂停。

## 3. 域名语义

### 3.1 永久 allowlist

Canonical key：`agent.browser.domain_allowlist`。

- owner：Agent；
- 存储：Agent Durable Object state；
- 输入：精确 hostname；
- wildcard：继续禁止；
- 修改：Agent Browser 工作台 CAS mutation 或一次明确的“永久允许”审批；
- Telegram 只提交 owner-scoped 决定，不保存名单副本。

### 3.2 Denylist

Canonical key：`agent.browser.domain_denylist`。

- deny 优先于永久和临时 allow；
- P0 支持 owner-managed 精确 hostname；
- P0 不接第三方威胁情报 feed，避免不可审计的远端自动封禁；
- 硬拒绝 hostname 与危险 URL 不能通过从 denylist 移除而放开。

### 3.3 同站

“同站”使用 Public Suffix List 和 private suffix 数据判断 registrable domain，不用字符串
后缀猜测。例如 `www.example.com` 与 `account.example.com` 同站；两个不同的
`*.github.io` 租户不是同站；`openpsychometrics.org` 与 `ojts.com` 是跨站。

同站自动允许只扩大到当前 Browser call 的有效 domain scope，不写入永久名单。

### 3.4 临时 grant

Agent DO SQLite 保存：

```ts
type BrowserDomainGrant = {
  id: string;
  taskId: string;
  ownerId: string;
  chatId: string;
  hostname: string;
  scope: "once" | "task";
  status: "active" | "consumed" | "expired" | "revoked";
  usesRemaining: number | null;
  expiresAt: string;
};
```

- `once`：一次 Browser provider invocation，15 分钟失效；
- `task`：只对同一 `taskId + ownerId + chatId` 生效，30 分钟失效；
- task 终止、取消、过期或 heartbeat sweep 后不可再使用；
- grant 不进入模型 prompt，不包含 Cookie、URL path、query 或页面正文。

## 4. 策略状态机

```text
planned browser call
  -> hard deny / denylist       -> policy_denied (terminal, no side effect)
  -> fully allowed             -> executing
  -> unknown cross-site host   -> policy_approval_required
                                  -> reject / timeout -> policy_denied
                                  -> once/task/always -> grant + retry pending call
                                                         -> human handoff if needed
                                                         -> result
```

`uncertain_tool_side_effect` 只允许表示：调用已经越过 provider dispatch 边界，而结果是否生效
无法确认。参数校验、域策略拒绝、allowlist 缺失、schema 拒绝和 Browser 预检失败均是
definitive，不得写入 uncertain ledger。

## 5. 审批模型

域挑战不是工具执行审批的别名。它使用独立 challenge 记录和独立 callback namespace：

```text
bd:o:<challenge_id>  once
bd:t:<challenge_id>  task
bd:p:<challenge_id>  permanent
bd:r:<challenge_id>  reject
```

每个 callback 绑定 owner、chat、task、候选 hostname、原始 args hash、过期时间和一次性状态。
批准后由 Agent 原子地 claim challenge；重放返回原决定，不会把旧 callback 应用到下一阶段。

通用 human handoff 继续使用现有 `ap:*` approval ticket 与 Workflow。域挑战完成后，如果
Browser execution 内的 `humanHandoff` 暂停，系统创建新的 `ap:*` ticket。两类审批共享
task/run correlation，但不共享 nonce 或生命周期。

## 6. 恢复语义

`ToolTaskCheckpoint` 在域挑战期间保留原始 `pendingCall`。批准后把 checkpoint 标成可恢复，
Fiber 优先重试该 pending call，再继续 planner；不要求 Opus重发任务，也不让 GLM消耗一个
额外规划轮来猜测刚刚发生了什么。

如果重试返回 `deferred_tool_approval`，checkpoint 转入下一张 human handoff ticket；如果返回
结果，按正常 sanitizer、call count、completed call key 和 planner continuation 处理。

## 7. 控制面

`/tools/browser` 增加四个 owner view：

- 永久允许域名；
- 永久拒绝域名；
- 活跃临时 grants，显示 scope、task、有效期并支持撤销；
- 最近域挑战，显示 `source -> target`、决定、时间和 task locator。

所有 mutation 保持应用会话、Origin、CSRF、CAS、审计和 secret redaction。TG 控制台只显示
审批与执行投影，并深链接到 Agent 工作台，不复制编辑器。

## 8. 测试与验收

P0 合同测试必须覆盖：

1. exact allowlist、same-site、cross-site、denylist 与 SSRF precedence；
2. Public Suffix List private suffix，避免 `github.io` 租户串权；
3. 未知跨站产生 challenge，而不是 uncertain side effect；
4. once/task/permanent/reject/timeout 与 callback replay；
5. grant 绑定 owner/chat/task，跨任务不可使用；
6. grant 后重试原 pending call；
7. domain challenge 后仍可产生独立 human handoff ticket；
8. Telegram 四按钮、工具轨迹、最终回复恰好一次；
9. 控制页 CAS、撤销、审计与无 secret 输出；
10. 现有 Browser E2E、MCP、Voice、Grok、Memory 与 TG regression 全绿。

生产验收使用公开无账号测试页，不提交真实账号、付款、发布或删除动作。最终自然消息验收：

```text
openpsychometrics.org -> ojts.com
  -> 域挑战
  -> 本任务允许
  -> Browser 恢复
  -> human handoff（若页面交互需要）
  -> 最终回答恰好一次
```

## 9. 实施分期

### P0 本轮

- 域策略模块、PSL 同站判断与 owner denylist；
- domain challenge/grant SQLite ledger；
- pending call 恢复；
- Telegram callback 与四按钮；
- Agent Browser 工作台投影、撤销和 permanent deny editor；
- 完整测试、部署与真实链路验收。

### P1

- 对 HTTP 3xx、JavaScript navigation、window.open 与表单 action 提供更细的 redirect evidence；
- 控制页按 site family 展示授权建议；
- challenge 与 Browser Live View 的统一 task timeline。

### P2

- 可选外部威胁情报，只作为可审计 deny signal；
- 经过观察后为稳定 Site Adapter 建议永久域集合，但永不自动永久放行；
- CLI 消费同一 owner contract，不创建第二名单。

## 10. 回滚

- feature flag 关闭 domain challenge 后恢复现有 exact allowlist fail-closed 行为；
- 临时 grant 表可停止读取而不影响永久 allowlist；
- denylist 可回退为空，但协议与 SSRF 硬拒绝始终保留；
- 不删除现有 `agent.browser.domain_allowlist`、审批 Workflow 或 Browser session 数据。
