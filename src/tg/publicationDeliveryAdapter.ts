import type { Env } from "../types";
import type { PublicationPurpose, PublicationTextRole } from "../publication/types";
import { persistTgDeliveryBatch } from "./deliveryBatch";
import { enqueueTgOutbox, enqueueTgOutboxBatch } from "./outbox";
import {
  nativeInferencePublicationId,
  nativeInferenceRunId,
  nativeOutboxIdForIntent,
  publicationDeliveryAuthorityEnabled,
  stageNativePublicationBatch,
  type NativePublicationCommand,
} from "./publicationDeliveryAuthority";
import type { TgPublicationSourceAuthorityMode } from "./publicationSource";

export type InferencePublicationTextPayload = {
  payload:Record<string,unknown>;
  textRole:PublicationTextRole;
  visibleTextFragment:string | null;
};

function mediaTextProvenance(
  payload: Record<string,unknown>,
  purpose: PublicationPurpose,
): Pick<InferencePublicationTextPayload,"textRole"|"visibleTextFragment"> {
  const caption = typeof payload.caption === "string" ? payload.caption.trim() : "";
  if (!caption || (typeof payload.parse_mode === "string" && payload.parse_mode.trim())) {
    return {textRole:"none",visibleTextFragment:null};
  }
  return {
    textRole:purpose === "assistant_response" ? "assistant" : "system",
    visibleTextFragment:caption,
  };
}

export async function stageInferencePublicationDelivery(
  env: Env,
  input: {
    batchKey:string;
    chatId:string;
    deliverySeq:number | null;
    publicationCreatedAt:string;
    purpose:PublicationPurpose;
    consumedPrefixCount:number;
    resultPayloads:Record<string,unknown>[];
    textPayloads:InferencePublicationTextPayload[];
    mediaPayloads:Record<string,unknown>[];
    voiceOnce:boolean;
    hadAttention:boolean;
    publicationAuthority?:TgPublicationSourceAuthorityMode;
  },
): Promise<string[]> {
  const staged = [
    ...input.resultPayloads.map((payload,index) => ({
      intentKey:`tg-agent:${input.batchKey}:result:${index}`,
      payload,textRole:"none" as const,visibleTextFragment:null,
    })),
    ...input.textPayloads.map((item,index) => ({
      intentKey:`tg-agent:${input.batchKey}:text:${input.consumedPrefixCount+index}`,
      ...item,
    })),
    ...input.mediaPayloads.map((payload,index) => ({
      intentKey:`tg-agent:${input.batchKey}:media:${index}:0`,
      payload,...mediaTextProvenance(payload,input.purpose),
    })),
  ];
  const firstVoiceIndex = input.voiceOnce
    ? input.mediaPayloads.findIndex((intent) => intent.method === "sendVoice") : -1;

  const native = input.publicationAuthority
    ? input.publicationAuthority === "native"
    : publicationDeliveryAuthorityEnabled(env);
  if (!native) {
    const outboxIds = await enqueueTgOutboxBatch(env.DB,staged.map(({intentKey,payload}) => ({
      id:crypto.randomUUID(),intentKey,chatId:input.chatId,payload,deliveryBatchKey:input.batchKey,
    })));
    const voiceOnceOutboxId = firstVoiceIndex >= 0
      ? outboxIds[input.resultPayloads.length+input.textPayloads.length+firstVoiceIndex] : undefined;
    await persistTgDeliveryBatch(env.DB,{
      batchKey:input.batchKey,chatId:input.chatId,deliverySeq:input.deliverySeq,
      outboxIds,voiceOnceOutboxId,hadAttention:input.hadAttention,
    });
    return outboxIds;
  }
  if (!Number.isSafeInteger(input.deliverySeq) || Number(input.deliverySeq) <= 0) {
    throw new Error("tg_delivery_seq_missing");
  }
  const commands: NativePublicationCommand[] = await Promise.all(staged.map(async (item) => ({
    outboxId:await nativeOutboxIdForIntent(item.intentKey),
    intentKey:item.intentKey,
    chatId:input.chatId,
    payload:item.payload,
    required:true,
    textRole:item.textRole,
    visibleTextFragment:item.visibleTextFragment,
  })));
  const voiceOnceOutboxId = firstVoiceIndex >= 0
    ? commands[input.resultPayloads.length+input.textPayloads.length+firstVoiceIndex]?.outboxId
    : undefined;
  const nativeStageEnv = input.publicationAuthority === "native"
    ? {DB:env.DB,PUBLICATION_DELIVERY_AUTHORITY_ENABLED:"true"}
    : env;
  return stageNativePublicationBatch(nativeStageEnv,{
    publicationId:nativeInferencePublicationId(input.batchKey),
    inferenceRunId:nativeInferenceRunId(input.batchKey),
    recipientScope:input.chatId,
    purpose:input.purpose,
    publicationCreatedAt:input.publicationCreatedAt,
    deliveryBatchId:input.batchKey,
    commands,
    closeSequence:true,
    legacyDeliveryBatch:{
      batchKey:input.batchKey,
      chatId:input.chatId,
      deliverySeq:Number(input.deliverySeq),
      voiceOnceOutboxId,
      hadAttention:input.hadAttention,
    },
  });
}

export async function stageParagraphPublicationDelivery(
  env: Env,
  input: {
    batchKey:string;
    chatId:string;
    publicationCreatedAt:string;
    bubbleIndex:number;
    text:string;
    outboxId:string;
    payload:Record<string,unknown>;
    presentationKind?:"assistant_text"|"tool_status";
    canonicalBubbleIndex?:number;
    publicationAuthority?:TgPublicationSourceAuthorityMode;
  },
): Promise<string> {
  const presentationKind = input.presentationKind ?? "assistant_text";
  const canonicalBubbleIndex = input.canonicalBubbleIndex ?? input.bubbleIndex;
  const intentKey = presentationKind === "assistant_text"
    ? `tg-agent:${input.batchKey}:text:${canonicalBubbleIndex}`
    : `tg-agent:${input.batchKey}:presentation:tool:${input.bubbleIndex}`;
  const deliveryBatchId = `paragraph:${input.batchKey}`;
  const native = input.publicationAuthority
    ? input.publicationAuthority === "native"
    : publicationDeliveryAuthorityEnabled(env);
  if (!native) {
    return enqueueTgOutbox(env.DB,{
      id:input.outboxId,intentKey,chatId:input.chatId,payload:input.payload,deliveryBatchKey:deliveryBatchId,
    });
  }
  const nativeStageEnv = input.publicationAuthority === "native"
    ? {DB:env.DB,PUBLICATION_DELIVERY_AUTHORITY_ENABLED:"true"}
    : env;
  const [outboxId] = await stageNativePublicationBatch(nativeStageEnv,{
    publicationId:nativeInferencePublicationId(input.batchKey),
    inferenceRunId:nativeInferenceRunId(input.batchKey),
    recipientScope:input.chatId,
    purpose:"assistant_response",
    publicationCreatedAt:input.publicationCreatedAt,
    deliveryBatchId,
    commands:[{
      outboxId:input.outboxId,
      intentKey,
      chatId:input.chatId,
      payload:input.payload,
      required:true,
      textRole:presentationKind === "assistant_text" ? "assistant" : "none",
      visibleTextFragment:presentationKind === "assistant_text" ? input.text : null,
    }],
    closeSequence:false,
  });
  if (!outboxId) throw new Error("tg_paragraph_outbox_stage_failed");
  return outboxId;
}
