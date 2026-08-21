export interface PublicModel {
  id: string;
  upstream: string;
  ownedBy: string;
}

export const PUBLIC_MODELS: readonly PublicModel[] = [
  {
    id: "opus-4.5",
    upstream: "anthropic/claude-opus-4-5",
    ownedBy: "anthropic"
  },
  {
    id: "opus-4.6",
    upstream: "anthropic/claude-opus-4.6",
    ownedBy: "anthropic"
  },
  {
    id: "haiku-4.5",
    upstream: "anthropic/claude-haiku-4-5",
    ownedBy: "anthropic"
  },
  {
    id: "gemini-3-flash",
    upstream: "google-ai-studio/gemini-3-flash-preview",
    ownedBy: "google"
  },
  {
    id: "fable-5",
    upstream: "anthropic/claude-fable-5",
    ownedBy: "anthropic"
  }
] as const;

export function resolvePublicModelAlias(model: string | undefined): string | null {
  const requested = (model || "").trim().toLowerCase();
  if (!requested) return null;
  return PUBLIC_MODELS.find((entry) => entry.id.toLowerCase() === requested)?.upstream ?? null;
}
