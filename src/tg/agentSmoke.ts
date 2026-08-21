import type { Env } from "../types";
import { agentScope, createAgentCapsule, submitAgentTask, waitForAgentTask } from "./agentClient";

export async function handleAgentSmoke(request: Request, env: Env): Promise<Response> {
  const expected = env.AGENT_SMOKE_API_KEY?.trim();
  const received = request.headers.get("x-<AGENT_SERVICE>-smoke")?.trim();
  if (!expected || !received || received !== expected) return new Response("not found", { status: 404 });
  const chatId = env.TG_AGENT_OWNER_CHAT_ID?.trim();
  if (!chatId) return Response.json({ error: "owner_not_configured" }, { status: 503 });

  const requestHash = crypto.randomUUID();
  const taskId = `smoke_${requestHash.replaceAll("-", "").slice(0, 24)}`;
  const scope = agentScope(env, chatId, taskId, "P1 read-only observer smoke", requestHash);
  const capsuleId = await createAgentCapsule(env, scope);
  await submitAgentTask(
    env,
    scope,
    capsuleId,
    "Call the operia-observer system_status tool once and return its sanitized result. Do not select any other tool."
  );
  const result = await waitForAgentTask(env, taskId);
  if (result.status !== "completed") return Response.json({ taskId, status: result.status, result: result.result });

  const chatApiKey = env.TG_CHAT_API_KEY?.trim() || env.IM_API_KEY?.trim();
  if (!chatApiKey || !env.MEMORY_SERVICE) return Response.json({ error: "smoke_chat_binding_misconfigured" }, { status: 503 });
  const toolCallId = `smoke_call_${crypto.randomUUID().replaceAll("-", "")}`;
  const finalResponse = await env.MEMORY_SERVICE.fetch("https://<MEMORY_SERVICE>.internal/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${chatApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.PUBLIC_MODEL_NAME || "companion",
      stream: false,
      max_tokens: 512,
      messages: [
        { role: "system", content: "你是 Telegram 助手。用工具结果简洁回答用户，不要再次调用工具。" },
        { role: "user", content: "请检查 Operia 当前模型、embedding 维度和运行状态。" },
        { role: "assistant", content: "", tool_calls: [{ id: toolCallId, type: "function", function: { name: "delegate_action", arguments: JSON.stringify({ task: "检查 Operia 当前系统状态", context_ref: capsuleId }) } }] },
        { role: "tool", tool_call_id: toolCallId, name: "delegate_action", content: JSON.stringify(result.result) },
      ],
    }),
  });
  if (!finalResponse.ok) return Response.json({ error: `smoke_final_http_${finalResponse.status}` }, { status: 502 });
  const final = await finalResponse.json<Record<string, unknown>>();
  const choice = Array.isArray(final.choices) ? final.choices[0] as Record<string, unknown> | undefined : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const finalText = typeof message?.content === "string" ? message.content.trim() : "";
  const finalToolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0;
  return Response.json({
    taskId,
    status: result.status,
    result: result.result,
    final: {
      textNonEmpty: finalText.length > 0,
      toolCallCount: finalToolCalls,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    },
  });
}
