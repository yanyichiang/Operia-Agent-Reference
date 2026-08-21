import { canonicalArgsHash } from "./contextBroker";

export type ApprovalAction = "once" | "task" | "reject";
export type ApprovalCallbackAction = ApprovalAction | "details" | "stop";
export type BrowserDomainDecisionAction = "once" | "task" | "reject";

export type ApprovalTicketBinding = {
  ownerId: string;
  chatId: string;
  taskId: string;
  serverId: string;
  toolName: string;
  argsHash: string;
  policyVersion: string;
  expiresAt: string;
  nonce: string;
};

export type ApprovalTicketRecord = ApprovalTicketBinding & {
  id: string;
  status: "pending" | "decision_reserved" | "consuming" | "approved" | "rejected" | "expired" | "cancelled" | "quarantined" | "attention_required";
};

const TICKET_ID = /^apt_[a-f0-9]{24}$/;
const BROWSER_DOMAIN_CHALLENGE_ID = /^[a-z0-9][a-z0-9_-]{0,58}$/;
const BROWSER_DOMAIN_CALLBACK_ACTION: Record<BrowserDomainDecisionAction, string> = {
  once: "o",
  task: "t",
  reject: "r",
};

export function newApprovalTicketId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `apt_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function newApprovalNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function encodeApprovalCallback(action: ApprovalCallbackAction | "approve", ticketId: string): string {
  if (!TICKET_ID.test(ticketId)) throw new Error("invalid_approval_ticket_id");
  const code = action === "approve" || action === "once" ? "o"
    : action === "task" ? "t"
    : action === "details" ? "d"
    : action === "stop" ? "s"
    : "r";
  const data = `ap:${code}:${ticketId}`;
  if (new TextEncoder().encode(data).byteLength > 64) throw new Error("telegram_callback_too_large");
  return data;
}

export function parseApprovalCallback(data: string): { action: ApprovalCallbackAction; ticketId: string } | null {
  const match = /^ap:([aotrds]):(apt_[a-f0-9]{24})$/.exec(data);
  if (!match) return null;
  const actions: Record<string, ApprovalCallbackAction> = {
    a: "once",
    o: "once",
    t: "task",
    r: "reject",
    d: "details",
    s: "stop",
  };
  return { action: actions[match[1]], ticketId: match[2] };
}

export function encodeBrowserDomainCallback(action: BrowserDomainDecisionAction, challengeId: string): string {
  if (!BROWSER_DOMAIN_CHALLENGE_ID.test(challengeId)) throw new Error("invalid_browser_domain_challenge_id");
  const data = `bd:${BROWSER_DOMAIN_CALLBACK_ACTION[action]}:${challengeId}`;
  if (new TextEncoder().encode(data).byteLength > 64) throw new Error("telegram_callback_too_large");
  return data;
}

export function parseBrowserDomainCallback(data: string): { action: BrowserDomainDecisionAction; challengeId: string } | null {
  const match = /^bd:([otr]):([a-z0-9][a-z0-9_-]{0,58})$/.exec(data);
  if (!match || new TextEncoder().encode(data).byteLength > 64) return null;
  const actions: Record<string, BrowserDomainDecisionAction> = { o: "once", t: "task", r: "reject" };
  return { action: actions[match[1]], challengeId: match[2] };
}

export async function validateApprovalBinding(
  ticket: ApprovalTicketRecord | null,
  input: Omit<ApprovalTicketBinding, "nonce" | "expiresAt" | "argsHash"> & { args: unknown; now: Date },
): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!ticket) return { ok: false, code: "approval_missing" };
  if (ticket.status !== "pending") return { ok: false, code: "approval_not_pending" };
  if (!Number.isFinite(input.now.getTime())) return { ok: false, code: "invalid_server_clock" };
  if (Date.parse(ticket.expiresAt) <= input.now.getTime()) return { ok: false, code: "approval_expired" };
  if (ticket.ownerId !== input.ownerId) return { ok: false, code: "approval_owner_mismatch" };
  if (ticket.chatId !== input.chatId) return { ok: false, code: "approval_chat_mismatch" };
  if (ticket.taskId !== input.taskId) return { ok: false, code: "approval_task_mismatch" };
  if (ticket.serverId !== input.serverId || ticket.toolName !== input.toolName) return { ok: false, code: "approval_tool_mismatch" };
  if (ticket.policyVersion !== input.policyVersion) return { ok: false, code: "approval_policy_mismatch" };
  return ticket.argsHash === await canonicalArgsHash(input.args)
    ? { ok: true }
    : { ok: false, code: "approval_args_mismatch" };
}
