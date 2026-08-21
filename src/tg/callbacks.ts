import { upsertMemoryByFactKey } from "../db/v2";
import type { Env } from "../types";
import { newId } from "../utils/ids";
import { TG_MODELS, handleCommand, handleMcpMenuCallback } from "./commands";
import { consumePendingCommand, getChatConfig, recordTgEvent, setChatModel } from "./settings";
import { answerCallbackQuery, sendMessageChunks } from "./telegram";
import { parseApprovalCallback, parseBrowserDomainCallback, type ApprovalAction, type BrowserDomainDecisionAction } from "../agent/approval";
import { controlAgentSandbox, decideAgentHeartbeatActivation, forwardApprovalToAgent, forwardBrowserDomainDecision, forwardMcpElicitationDecision, getAgentHeartbeatProjection, readApprovalDetailsFromAgent, resolveThinkSdkActionFromTelegram, stopThinkApprovalContinuationFromTelegram, stopThinkCodeModeContinuationFromTelegram, wakeThinkApprovalContinuation } from "./agentClient";
import { parseMcpElicitationCallback } from "../agent/mcpElicitation";
import { handleTaskControlCallback } from "./taskPresentation";
import { resetConversationState } from "./conversationClient";
import type { TelegramCallbackAuthority } from "./callbackAuthority";
import { sendSandboxControlMessage } from "./roomStatus";
import { deliverTgSystemReceipt } from "./systemReceipt";

export type ApprovalCallbackForward = { ticketId: string; action: ApprovalAction | "details" | "stop"; chatId: string };
export type BrowserDomainCallbackForward = { challengeId: string; action: BrowserDomainDecisionAction; chatId: string };

export function parseApprovalCallbackForward(chatId: string, data: string): ApprovalCallbackForward | null {
  const parsed = parseApprovalCallback(data);
  return parsed ? { ...parsed, chatId } : null;
}

export function parseBrowserDomainCallbackForward(chatId: string, data: string): BrowserDomainCallbackForward | null {
  const parsed = parseBrowserDomainCallback(data);
  return parsed ? { ...parsed, chatId } : null;
}

export async function handleCallback(
  env: Env,
  input: { callbackQueryId: string; ownerId: string; chatId: string; data: string; messageId?: string; authority: TelegramCallbackAuthority }
): Promise<void> {
  const { callbackQueryId, ownerId, chatId, data, messageId, authority } = input;
  if (authority.ownerId !== ownerId || authority.chatId !== chatId) {
    await answerCallbackQuery(env, callbackQueryId, "此操作只允许 Owner 在已绑定会话中执行");
    return;
  }

  const heartbeatActivation = /^hba:([ar]):(hba_[a-f0-9]{24})$/.exec(data);
  if (heartbeatActivation) {
    const action = heartbeatActivation[1] === "a" ? "approve" as const : "reject" as const;
    const requestId = heartbeatActivation[2];
    try {
      const projection = await getAgentHeartbeatProjection(env);
      const requests = Array.isArray(projection.activationRequests) ? projection.activationRequests : [];
      const pending = requests.find((value) => value && typeof value === "object" && !Array.isArray(value)
        && (value as Record<string,unknown>).requestId === requestId) as Record<string,unknown> | undefined;
      const nonce = typeof pending?.nonce === "string" ? pending.nonce : "";
      if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error("heartbeat_activation_not_pending");
      const result = await decideAgentHeartbeatActivation(env,requestId,{ action,nonce,ownerId,chatId });
      await answerCallbackQuery(env,callbackQueryId,action === "approve" ? "Heartbeat Active 已授权" : "已保持 Observe");
      await deliverTgSystemReceipt(env,chatId,{
        idempotencyKey:`heartbeat-activation:${requestId}:${action}`,
        actionId:requestId,ownerDomain:"agent.example.com",actorId:ownerId,requester:ownerId,
        authorizedBy:ownerId,operation:`heartbeat.activation.${action}`,
        outcome:"Succeeded",target:{ type:"heartbeat_activation",id:requestId },
        completed:[action === "approve" ? "standing grant created" : "activation request rejected"],
        text:action === "approve"
          ? `Heartbeat 已进入 Active。standing grant 到期时间：${String(result.expiresAt || "以 Agent 状态页为准")}。`
          : "Heartbeat 保持 Observe，没有建立 standing grant。",
        canonicalLink:"https://agent.example.com/tools/heartbeat",
      });
    } catch {
      await answerCallbackQuery(env,callbackQueryId,"这个 Heartbeat 请求已过期、已处理或暂时无法确认");
    }
    return;
  }

  const codeModeStop = /^cmst:(tcm_[a-f0-9]{32})$/.exec(data);
  if (codeModeStop) {
    try {
      await stopThinkCodeModeContinuationFromTelegram(env, {
        codemodeRef: codeModeStop[1], ownerId, chatId,
        scopeKind: authority.binding === "private_owner" ? "private" : "qa_room",
        threadKey: authority.threadKey,
      });
      await answerCallbackQuery(env, callbackQueryId, "已停止沙盒任务");
      await recordTgEvent(env.DB, { chatId, eventType: "think.codemode", status: "stopped",
        metadata: { codemodeRef: codeModeStop[1], ownerId } });
    } catch {
      await answerCallbackQuery(env, callbackQueryId, "沙盒任务已经结束或暂时无法停止");
    }
    return;
  }

  const taskControl = /^taskctl:(pause|resume|step|read_only|stop):(tg_[a-z0-9]+)$/i.exec(data);
  if (taskControl) {
    try {
      const message = await handleTaskControlCallback(env, {
        action: taskControl[1] as "pause" | "resume" | "step" | "read_only" | "stop",
        taskId: taskControl[2],
        ownerId,
        chatId,
      });
      if (taskControl[1] === "stop") {
        await stopThinkApprovalContinuationFromTelegram(env, {
          taskId: taskControl[2],
          ownerId,
          chatId,
          scopeKind: authority.binding === "private_owner" ? "private" : "qa_room",
          threadKey: authority.threadKey,
        });
      }
      await answerCallbackQuery(env, callbackQueryId, message);
    } catch {
      await answerCallbackQuery(env, callbackQueryId, "任务控制暂时不可用");
    }
    return;
  }

  const sandboxResume = /^sandboxctl:resume:([a-f0-9]{32})$/.exec(data);
  if (sandboxResume) {
    try {
      const result = await controlAgentSandbox(env, {
        ownerId,
        chatId,
        threadKey: authority.threadKey,
        authorityBinding: authority.binding,
      }, "confirm_resume", { nonce: sandboxResume[1] });
      await answerCallbackQuery(env, callbackQueryId, result.ok ? "已恢复全局工具闸门" : "恢复失败");
      await sendSandboxControlMessage(env, chatId, authority.threadKey,
        "Operia 的全局工具闸门已恢复。旧任务仍保持暂停，不会悄悄续跑；需要时请重新发起或逐项继续。");
    } catch {
      await answerCallbackQuery(env, callbackQueryId, "确认已过期，请重新发送 /resume");
    }
    return;
  }

  const sdkAction = /^sda:([ar]):(tsa_[a-f0-9]{32})$/.exec(data);
  if (sdkAction) {
    const decision = sdkAction[1] === "a" ? "approve" as const : "reject" as const;
    const result = await resolveThinkSdkActionFromTelegram(env, {
      approvalRef: sdkAction[2],
      decision,
      ownerId,
      chatId,
      scopeKind: authority.binding === "private_owner" ? "private" : "qa_room",
      threadKey: authority.threadKey,
    }).catch(() => ({ ok: false, status: 503, message: "审批暂时无法处理。" }));
    await answerCallbackQuery(env, callbackQueryId, result.message);
    await recordTgEvent(env.DB, { chatId, eventType: "think.sdk_action", status: result.ok ? decision : "denied",
      metadata: { approvalRef: sdkAction[2], decision, ownerId, httpStatus: result.status } });
    return;
  }

  const approval = parseApprovalCallbackForward(chatId, data);
  if (approval) {
    if (approval.action === "details") {
      const result = await readApprovalDetailsFromAgent(env, { ticketId: approval.ticketId, ownerId, chatId });
      await answerCallbackQuery(env, callbackQueryId, result.ok ? "详情已发送" : result.message);
      if (result.ok) await sendMessageChunks(env, chatId, result.message);
      await recordTgEvent(env.DB, { chatId, eventType: "approval.details", status: result.ok ? "read" : "denied",
        metadata: { ticketId: approval.ticketId, ownerId, httpStatus: result.status } });
      return;
    }
    if (approval.action === "stop") {
      const result = await forwardApprovalToAgent(env, {
        ticketId: approval.ticketId,
        action: "stop",
        chatId: approval.chatId,
        ownerId,
      });
      if (result.ok || result.status === 409) {
        await stopThinkApprovalContinuationFromTelegram(env, {
          ticketId: approval.ticketId,
          ownerId,
          chatId,
          scopeKind: authority.binding === "private_owner" ? "private" : "qa_room",
          threadKey: authority.threadKey,
        });
      }
      await answerCallbackQuery(env, callbackQueryId, result.message);
      await recordTgEvent(env.DB, { chatId, eventType: "approval", status: result.ok ? "stopped" : "denied",
        metadata: { ticketId: approval.ticketId, action: "stop", ownerId, httpStatus: result.status } });
      return;
    }
    let wake: { found: boolean; status: number };
    try {
      wake = await wakeThinkApprovalContinuation(env, {
        ticketId: approval.ticketId,
        decisionScope: approval.action,
        ownerId,
        chatId,
        scopeKind: authority.binding === "private_owner" ? "private" : "qa_room",
        threadKey: authority.threadKey,
      });
    } catch {
      await answerCallbackQuery(env, callbackQueryId, "审批状态暂时无法确认，请稍后重试。");
      return;
    }
    if (wake.status === 409) {
      await answerCallbackQuery(env, callbackQueryId, "系统提示：此审批已不可执行，没有产生新的工具结果。");
      await recordTgEvent(env.DB, { chatId, eventType: "approval", status: "terminal",
        metadata: { ...approval, ownerId, memoryStatus: wake.status } });
      return;
    }
    const result = await forwardApprovalToAgent(env, {
      ticketId: approval.ticketId,
      action: approval.action,
      chatId: approval.chatId,
      ownerId,
    });
    await answerCallbackQuery(env, callbackQueryId, result.message);
    await recordTgEvent(env.DB, { chatId, eventType: "approval", status: result.ok ? "forwarded" : "denied", metadata: { ...approval, ownerId, httpStatus: result.status } });
    return;
  }

  const elicitation = parseMcpElicitationCallback(data);
  if (elicitation) {
    const result = await forwardMcpElicitationDecision(env, { ...elicitation, ownerId, chatId });
    await answerCallbackQuery(env, callbackQueryId, result.message);
    await recordTgEvent(env.DB, {
      chatId,
      eventType: "mcp.elicitation",
      status: result.ok ? "forwarded" : "denied",
      metadata: { ticketId: elicitation.ticketId, action: elicitation.action, ownerId, httpStatus: result.status },
    });
    return;
  }

  const browserDomain = parseBrowserDomainCallbackForward(chatId, data);
  if (browserDomain) {
    const result = await forwardBrowserDomainDecision(env, { ...browserDomain, ownerId });
    await answerCallbackQuery(env, callbackQueryId, result.message);
    await recordTgEvent(env.DB, {
      chatId,
      eventType: "browser.domain_decision",
      status: result.ok ? "forwarded" : "denied",
      metadata: { ...browserDomain, ownerId, httpStatus: result.status },
    });
    return;
  }
  if (data.startsWith("m1:")) {
    if (!ownerId || ownerId !== chatId) {
      await answerCallbackQuery(env, callbackQueryId, "此菜单只允许 owner 私聊操作");
      return;
    }
    await answerCallbackQuery(env, callbackQueryId, "正在载入");
    try {
      await handleMcpMenuCallback(env, chatId, data, callbackQueryId, messageId);
    } catch (error) {
      console.error("tg: MCP menu callback failed", { error: String(error).slice(0, 200) });
      await sendMessageChunks(env, chatId, "MCP 菜单暂时无法读取，请重新打开 /mcp。");
    }
    return;
  }
  if (data.startsWith("cap:") && ["search","browser","image","voice"].includes(data.slice(4))) {
    await answerCallbackQuery(env,callbackQueryId,"已选择");
    await handleCommand(env,chatId,{ name:"use",args:data.slice(4) });
    return;
  }
  const pendingAction = /^pac:(new|remember|cancel):(pa_[a-f0-9]{16}):([a-f0-9]{16}):(\d+)$/.exec(data);
  if (pendingAction) {
    const config = await getChatConfig(env.DB,chatId);
    const expectedCommand = pendingAction[1] === "cancel" ? config.pendingCommand : pendingAction[1];
    if (!expectedCommand || !config.pendingActionId || !config.pendingNonce
      || config.pendingActionId !== pendingAction[2] || config.pendingNonce !== pendingAction[3]
      || config.pendingRevision !== Number(pendingAction[4])) {
      await answerCallbackQuery(env,callbackQueryId,"这个操作已经失效，请重新发起。");
      return;
    }
    const claimed = await consumePendingCommand(env.DB,chatId,{
      command:expectedCommand,actionId:pendingAction[2],nonce:pendingAction[3],revision:Number(pendingAction[4]),
      payload:config.pendingPayload,expiresAt:config.pendingExpiresAt ?? undefined,
    });
    if (!claimed) {
      await answerCallbackQuery(env,callbackQueryId,"这个操作已经过期或已被消费。");
      return;
    }
    await answerCallbackQuery(env,callbackQueryId,pendingAction[1] === "cancel" ? "已取消" : "正在处理");
    if (pendingAction[1] === "cancel") {
      await sendMessageChunks(env,chatId,"已取消。旧按钮不会再执行。");
      return;
    }
    if (pendingAction[1] === "new") {
      await resetConversationState(env,chatId);
      await recordTgEvent(env.DB,{ chatId,eventType:"session",status:"reset",metadata:{ actionId:claimed.actionId } });
      await sendMessageChunks(env,chatId,"新的短期会话已开始，长期记忆保持不变。");
      return;
    }
    if (!claimed.payload) {
      await sendMessageChunks(env,chatId,"待写入内容已经失效，请重新发送 /remember。");
      return;
    }
    await upsertMemoryByFactKey(env,{
      namespace:"default",factKey:`telegram:remember:${newId("fact")}`,content:claimed.payload,
      type:"note",importance:0.8,confidence:1,tags:["telegram","explicit"],source:"telegram-command",
    });
    await recordTgEvent(env.DB,{ chatId,eventType:"memory",status:"written",metadata:{ actionId:claimed.actionId } });
    await sendMessageChunks(env,chatId,"已写入 Operia 长期记忆。");
    return;
  }
  await answerCallbackQuery(env, callbackQueryId);

  if (data === "cancel" || data === "confirm:new" || data === "confirm:remember") {
    await sendMessageChunks(env,chatId,"这个旧按钮不再可执行，请重新发起操作。");
    return;
  }
  if (data === "menu:new") return handleCommand(env, chatId, { name: "new", args: "" });
  if (data === "menu:model") return handleCommand(env, chatId, { name: "model", args: "" });
  if (data === "menu:memory") return handleCommand(env, chatId, { name: "memory", args: "" });
  if (data === "menu:status") return handleCommand(env, chatId, { name: "status", args: "" });
  if (["voice:once", "voice:auto", "voice:off"].includes(data)) {
    return handleCommand(env, chatId, { name: "voice", args: data.slice("voice:".length) });
  }
  if (data.startsWith("voice:model:") && ["realtime", "quality", "expressive"].includes(data.slice("voice:model:".length))) {
    return handleCommand(env, chatId, { name: "voice", args: `model ${data.slice("voice:model:".length)}` });
  }

  if (data.startsWith("model:")) {
    const model = data.slice("model:".length);
    if (!(TG_MODELS as readonly string[]).includes(model)) return;
    await setChatModel(env.DB, chatId, model);
    await recordTgEvent(env.DB, { chatId, eventType: "model", status: "updated", metadata: { model } });
    await sendMessageChunks(env, chatId, `Telegram 模型已切换为 ${model}。`);
    return;
  }

}
