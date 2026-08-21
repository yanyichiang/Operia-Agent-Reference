export type ThinkApprovalGrantPins = {
  thinkTaskId: string;
  ownerId: string;
  chatId: string;
  serverId: string;
  toolName: string;
  argsHash: string;
  schemaHash: string;
  policyVersion: string;
  pauseGeneration: number;
};

export function matchesThinkApprovalTaskGrant(
  grant: ThinkApprovalGrantPins,
  call: ThinkApprovalGrantPins,
): boolean {
  return grant.thinkTaskId === call.thinkTaskId
    && grant.ownerId === call.ownerId
    && grant.chatId === call.chatId
    && grant.serverId === call.serverId
    && grant.toolName === call.toolName
    && grant.argsHash === call.argsHash
    && grant.schemaHash === call.schemaHash
    && grant.policyVersion === call.policyVersion
    && grant.pauseGeneration === call.pauseGeneration;
}
