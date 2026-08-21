export const TG_ORDINARY_MAX_TOKENS = 2048;

export function ordinaryTelegramGenerationLimit(
  agentRoom: boolean,
): { max_tokens?: number } {
  return agentRoom ? {} : { max_tokens: TG_ORDINARY_MAX_TOKENS };
}
