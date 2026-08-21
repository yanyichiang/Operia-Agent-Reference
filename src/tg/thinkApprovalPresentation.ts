import type { OpenAIChatResponse } from "../types";

export type ThinkApprovalProjection = {
  taskId: string;
  toolKey: string;
  billingClass: string;
  ticketId: string;
  summary: string;
  callbacks: Partial<Record<"once" | "task" | "reject" | "details" | "stop", string>>;
};

export type ThinkSdkActionProjection = {
  approvalRef: string;
  toolKey: string;
  billingClass: string;
  summary: string;
  callbacks: { approve: string; reject: string };
};

export type HarnessHeldProjection = {
  executionId: string;
  submissionId: string;
  acknowledgement: string;
};

export function hasHarnessPendingProjectionMarker(response: OpenAIChatResponse): boolean {
  const think = response.operia_think;
  return Boolean(think && typeof think === "object" && !Array.isArray(think)
    && (think as Record<string,unknown>).harness_pending_projection === true);
}

export function pendingHarnessProjection(response: OpenAIChatResponse): { executionId: string } | null {
  if (!hasHarnessPendingProjectionMarker(response)) return null;
  const record = response.operia_think as Record<string,unknown>;
  const executionId = typeof record.execution_id === "string" ? record.execution_id : "";
  return /^hrse_[a-f0-9]{40}$/.test(executionId) ? { executionId } : null;
}

export function pendingHarnessHeld(response: OpenAIChatResponse): HarnessHeldProjection | null {
  const think = response.operia_think;
  if (!think || typeof think !== "object" || Array.isArray(think)) return null;
  const record = think as Record<string,unknown>;
  if (record.harness_held !== true) return null;
  const executionId = typeof record.execution_id === "string" && /^hrse_[a-f0-9]{40}$/.test(record.execution_id)
    ? record.execution_id : "";
  const submissionId = typeof record.submission_id === "string" && /^think-prod-[a-f0-9]{48}$/.test(record.submission_id)
    ? record.submission_id : "";
  if (!executionId || !submissionId) return null;
  return {
    executionId,
    submissionId,
    acknowledgement: "任务已接收，完成后会自动继续回复。",
  };
}

export function pendingThinkSdkActions(response: OpenAIChatResponse): ThinkSdkActionProjection[] {
  const think = response.operia_think;
  if (!think || typeof think !== "object" || Array.isArray(think)) return [];
  const raw = (think as Record<string, unknown>).pending_sdk_approvals;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const callbacks = record.callbacks && typeof record.callbacks === "object" && !Array.isArray(record.callbacks)
      ? record.callbacks as Record<string, unknown> : {};
    const approvalRef = typeof record.approvalRef === "string" && /^tsa_[a-f0-9]{32}$/.test(record.approvalRef)
      ? record.approvalRef : "";
    const approve = typeof callbacks.approve === "string" && callbacks.approve === `sda:a:${approvalRef}` ? callbacks.approve : "";
    const reject = typeof callbacks.reject === "string" && callbacks.reject === `sda:r:${approvalRef}` ? callbacks.reject : "";
    if (!approvalRef || !approve || !reject) return [];
    return [{
      approvalRef,
      toolKey: typeof record.toolKey === "string" ? record.toolKey.slice(0, 180) : "unknown/tool",
      billingClass: typeof record.billingClass === "string" ? record.billingClass.slice(0, 40) : "unknown",
      summary: typeof record.summary === "string" ? record.summary.slice(0, 800) : "Operia 请求执行一项需要确认的只读工具。",
      callbacks: { approve, reject },
    }];
  });
}

export function pendingThinkApprovals(response: OpenAIChatResponse): ThinkApprovalProjection[] {
  const think = response.operia_think;
  if (!think || typeof think !== "object" || Array.isArray(think)) return [];
  const raw = (think as Record<string, unknown>).pending_approvals;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const presentation = record.presentation;
    if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return [];
    const projected = presentation as Record<string, unknown>;
    const callbacks = projected.callbacks;
    if (!callbacks || typeof callbacks !== "object" || Array.isArray(callbacks)) return [];
    const callbackRecord = callbacks as Record<string, unknown>;
    const ticketId = typeof projected.ticketId === "string" && /^apt_[a-f0-9]{24}$/.test(projected.ticketId) ? projected.ticketId : "";
    const taskId = typeof record.taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(record.taskId) ? record.taskId : "";
    const normalizedCallbacks: ThinkApprovalProjection["callbacks"] = {};
    for (const key of ["once", "task", "reject", "details", "stop"] as const) {
      const callback = callbackRecord[key];
      if (typeof callback === "string" && /^ap:[otrds]:apt_[a-f0-9]{24}$/.test(callback)) normalizedCallbacks[key] = callback;
    }
    if (!ticketId || !taskId || !normalizedCallbacks.once || !normalizedCallbacks.task || !normalizedCallbacks.reject) return [];
    return [{
      taskId,
      ticketId,
      toolKey: typeof record.toolKey === "string" ? record.toolKey.slice(0, 180) : "unknown/tool",
      billingClass: typeof record.billingClass === "string" ? record.billingClass.slice(0, 40) : "unknown",
      summary: typeof projected.summary === "string" ? projected.summary.slice(0, 800) : "Operia 请求调用一项需要审批的工具。",
      callbacks: normalizedCallbacks,
    }];
  });
}

export function thinkSystemNotice(response: OpenAIChatResponse): string | null {
  const think = response.operia_think;
  if (!think || typeof think !== "object" || Array.isArray(think)) return null;
  const notice = (think as Record<string, unknown>).channel_notice;
  if (notice === "tool_call_failed") return "系统提示：工具调用失败，未返回结果；系统没有自动重试。";
  if (notice === "tool_call_rejected") return "系统提示：工具调用已拒绝，未执行，也没有返回结果。";
  return null;
}
