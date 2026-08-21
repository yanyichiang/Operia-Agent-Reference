import { authenticate } from "../auth/apiKey";
import { PUBLIC_MODELS } from "../config/modelCatalog";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";

export async function handleModels(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  return json({
    object: "list",
    data: PUBLIC_MODELS.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: model.ownedBy
    }))
  });
}
