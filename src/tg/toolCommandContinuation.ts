import type { Env, OpenAIChatMessage, OpenAIChatRequest } from "../types";
import { nowIso } from "../utils/time";
import { sha256Hex } from "../utils/hash";
import type { AgentTelegramCommandResult } from "./agentClient";
import { buildConversationSummaryMessages, buildSystemPrompt } from "./process";
import { getChatConfig } from "./settings";
import { enqueueTgAgentResume } from "./agentResumeQueue";
import { startTaskPresentation } from "./taskPresentation";
import { getConversationProjection } from "./conversationClient";
import { persistTgCommandInferenceRun } from "./inferenceRun";
import { enqueueTgInferenceResume } from "../queue/producer";
import { selectedTgPublicationSourceAuthority } from "./publicationSource";
import { legacyToolCommandCompatibilityReason } from "./legacyPublicationCompatibility";

export type ToolCommandPublicationAdmission =
  | {kind:"native";batchKey:string}
  | {kind:"historical_compatibility";reason:"PRE_NATIVE_IN_FLIGHT";batchKey:null};

async function commandBatchKey(
  taskId:string,
):Promise<string> {
  // Agent task ids are the durable execution identity. Ingress request ids may
  // change across recovery/replay and therefore cannot create another source.
  return sha256Hex(["tg-tool-command-publication-v2",taskId].join("\0"));
}

export async function persistToolCommandWithOpus(
  env: Env,
  chatId: string,
  commandText: string,
  pending: NonNullable<AgentTelegramCommandResult["pending"]>,
  _requestId?:string,
): Promise<ToolCommandPublicationAdmission> {
  const batchKey = await commandBatchKey(pending.taskId);
  const compatibility = await legacyToolCommandCompatibilityReason(env.DB,{
    taskId:pending.taskId,nativeBatchKey:batchKey,
  });
  if (compatibility) {
    await startTaskPresentation(env,{taskId:pending.taskId,chatId});
    await enqueueTgAgentResume(env,pending.taskId);
    return {kind:"historical_compatibility",reason:compatibility,batchKey:null};
  }
  const [config, projected] = await Promise.all([getChatConfig(env.DB, chatId),
    getConversationProjection(env, { chatId, ownerText: commandText, requestStartedAtUtc: nowIso() })]);
  const { state, projection } = projected;
  const toolCallId = `tool_command_${pending.taskId}`;
  const request: OpenAIChatRequest = {
    model: config.model,
    stream: false,
    max_tokens: 4096,
    messages: [
      { role: "system", content: buildSystemPrompt(env) },
      ...(projection.mode === "legacy" ? buildConversationSummaryMessages(state.summary) : []),
      ...projection.recent,
      { role: "user", content: `用户显式调用了 ${commandText}。请等待当前真实工具任务完成，再只根据返回结果回答；不要再次调用工具。` },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: toolCallId,
          type: "function",
          function: { name: "delegate_action", arguments: JSON.stringify({ task: `执行 ${pending.toolKey}` }) },
        }],
      },
    ],
    ...(projection.summaryPatch ? { conversation_summary_patch: projection.summaryPatch } : {}),
  };
  await persistTgCommandInferenceRun(env.DB,{
    batchKey,taskId:pending.taskId,chatId,request,userText:commandText,priorState:state,initialStatus:"deferred",
    publicationAuthority:selectedTgPublicationSourceAuthority(env),
    deferredTask:{
      taskId:pending.taskId,
      ownerId:env.TG_AGENT_OWNER_ID?.trim() || chatId,
      toolCallId,
      toolName:"delegate_action",
    },
  });
  await startTaskPresentation(env, { taskId: pending.taskId, chatId });
  await enqueueTgAgentResume(env, pending.taskId);
  return {kind:"native",batchKey};
}

export async function completeToolCommandWithOpus(
  env: Env,
  chatId: string,
  commandText: string,
  handoff: NonNullable<AgentTelegramCommandResult["handoff"]>,
  _requestId?:string,
): Promise<ToolCommandPublicationAdmission> {
  const batchKey = await commandBatchKey(handoff.taskId);
  const compatibility = await legacyToolCommandCompatibilityReason(env.DB,{
    taskId:handoff.taskId,nativeBatchKey:batchKey,
  });
  if (compatibility) {
    return {kind:"historical_compatibility",reason:compatibility,batchKey:null};
  }
  const [config, projected] = await Promise.all([getChatConfig(env.DB, chatId),
    getConversationProjection(env, { chatId, ownerText: commandText, requestStartedAtUtc: nowIso() })]);
  const { state, projection } = projected;
  const toolCallId = `tool_command_${handoff.taskId}`;
  const userMessage = `用户显式调用了 ${commandText}。工具 ${handoff.toolKey} 已完成。请结合当前对话、Operia 记忆与工具结果，直接回答用户真正想知道的内容；不要输出 JSON 包装，也不要再次调用工具。`;
  const messages: OpenAIChatMessage[] = [
    { role: "system", content: buildSystemPrompt(env) },
    ...(projection.mode === "legacy" ? buildConversationSummaryMessages(state.summary) : []),
    ...projection.recent,
    { role: "user", content: userMessage },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: toolCallId,
        type: "function",
        function: {
          name: "delegate_action",
          arguments: JSON.stringify({ task: `解释已完成的 ${handoff.toolKey} 工具结果` }),
        },
      }],
    },
    { role: "tool", tool_call_id: toolCallId, name: "delegate_action", content: JSON.stringify(handoff.result) },
  ];
  const body: OpenAIChatRequest = { model: config.model, messages, stream: false, max_tokens: 4096,
    ...(projection.summaryPatch ? { conversation_summary_patch: projection.summaryPatch } : {}) };
  await persistTgCommandInferenceRun(env.DB,{
    batchKey,taskId:handoff.taskId,chatId,request:body,userText:commandText,priorState:state,initialStatus:"prepared",
    publicationAuthority:selectedTgPublicationSourceAuthority(env),
  });
  await enqueueTgInferenceResume(env,batchKey,0);
  return {kind:"native",batchKey};
}
