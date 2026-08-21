export type HtmlArtifactKind = "safe_document" | "interactive_capsule";
export type HtmlArtifactSensitivity = "private" | "sensitive" | "health";

export type HtmlArtifactScanInput = {
  artifactId: string;
  version: number;
  kind: HtmlArtifactKind;
  html: string;
  sensitivity: HtmlArtifactSensitivity;
  derivedHealthSummary?: boolean;
};

export type HtmlArtifactScanResult =
  | { ok: true; bundle: string; contentHash: string; bytes: number; policyVersion: "artifact-sandbox-v1" }
  | { ok: false; contentHash: string; bytes: number; category: string; policyVersion: "artifact-sandbox-v1" };

export const HTML_ARTIFACT_MAX_BYTES = 256 * 1024;
export const HTML_ARTIFACT_STATE_MAX_BYTES = 16 * 1024;
export const HTML_ARTIFACT_TOTAL_STATE_MAX_BYTES = 64 * 1024;
export const HTML_ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

function artifactFlag(value?: string): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function htmlArtifactKindEnabled(
  env: { AGENT_HTML_ARTIFACTS_ENABLED?: string; AGENT_INTERACTIVE_ARTIFACTS_ENABLED?: string },
  kind: HtmlArtifactKind,
): boolean {
  if (!artifactFlag(env.AGENT_HTML_ARTIFACTS_ENABLED)) return false;
  return kind === "safe_document" || artifactFlag(env.AGENT_INTERACTIVE_ARTIFACTS_ENABLED);
}

function bridgeScript(artifactId: string, version: number): string {
  const identity = JSON.stringify({ artifactId, version });
  return `<script>(function(){"use strict";const identity=${identity};let lastHeight=0;let timer=0;function send(type,extra){parent.postMessage(Object.assign({type,artifactId:identity.artifactId,version:identity.version},extra||{}),"*")}Object.defineProperty(window,"operiaArtifact",{value:Object.freeze({saveState:function(revision,value){send("artifact.state.save",{revision:revision,value:value})},request:function(requestType,payload){send("artifact.request",{requestType:requestType,payload:payload})}}),writable:false,configurable:false});function resize(){const height=Math.max(240,Math.min(4096,Math.ceil(document.documentElement.scrollHeight||document.body.scrollHeight||240)));if(height!==lastHeight){lastHeight=height;send("artifact.resize",{height})}}addEventListener("DOMContentLoaded",function(){send("artifact.ready");resize();try{new ResizeObserver(function(){clearTimeout(timer);timer=setTimeout(resize,80)}).observe(document.documentElement)}catch{}})})();</script>`;
}

export function buildHtmlArtifactBundle(input: HtmlArtifactScanInput): string {
  const interactive = input.kind === "interactive_capsule";
  const csp = [
    "default-src 'none'",
    `script-src ${interactive ? "'unsafe-inline'" : "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "media-src data: blob:",
    "connect-src 'none'",
    "font-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
  const bridge = interactive ? bridgeScript(input.artifactId, input.version) : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html{color-scheme:light;background:#fffefa}body{margin:0;min-width:0}img,video,canvas,svg{max-width:100%;height:auto}pre,table{max-width:100%;overflow:auto}</style></head><body>${input.html}${bridge}</body></html>`;
}

function blockedCategory(input: HtmlArtifactScanInput): string | null {
  const source = input.html;
  const interactive = input.kind === "interactive_capsule";
  if (!source.trim()) return "empty_bundle";
  if (encoder.encode(source).byteLength > HTML_ARTIFACT_MAX_BYTES) return "bundle_too_large";
  if (/\u0000|<!--[\s\S]*?<\s*script/i.test(source)) return "parser_ambiguity";
  if (/<\s*\/?\s*(?:html|head|body|base|meta|link|form|iframe|frame|frameset|object|embed|portal|template)\b/i.test(source)) return "forbidden_element";
  if (/\s(?:src|srcset|href|action|formaction|poster|ping)\s*=/i.test(source)) return "url_bearing_attribute";
  if (/(?:https?:|wss?:|ftp:|\/\/)[^\s<>'"]+/i.test(source)) return "external_url";
  if (/@import\b|url\s*\(\s*(?!["']?data:)|expression\s*\(|-moz-binding\s*:|behavior\s*:/i.test(source)) return "external_css_or_legacy_execution";
  if (/\b(?:fetch|WebSocket|EventSource|XMLHttpRequest|WebTransport|RTCPeerConnection)\s*\(?/i.test(source) || /navigator\s*\.\s*sendBeacon/i.test(source)) return "network_api";
  if (/\b(?:localStorage|sessionStorage|indexedDB|serviceWorker|SharedWorker|BroadcastChannel)\b/i.test(source)) return "ambient_storage_api";
  if (/document\s*\.\s*cookie|window\s*\.\s*(?:parent|top|opener)|\b(?:parent|top|opener)\s*\./i.test(source)) return "ambient_parent_or_credential_api";
  if (/\sdownload(?:\s|=|>)/i.test(source) || /window\s*\.\s*open|location\s*(?:\.|=)/i.test(source)) return "navigation_or_download";
  if (!interactive && (/<\s*script\b/i.test(source) || /\son[a-z]+\s*=/i.test(source) || /javascript\s*:/i.test(source))) return "script_in_safe_document";
  if (interactive && /<\s*script\b[^>]*\bsrc\s*=/i.test(source)) return "external_script";
  if (input.sensitivity === "health" && input.derivedHealthSummary !== true) return "raw_health_not_allowed";
  return null;
}

export async function scanHtmlArtifact(input: HtmlArtifactScanInput): Promise<HtmlArtifactScanResult> {
  const bytes = encoder.encode(input.html).byteLength;
  const rawHash = await sha256Hex(input.html);
  const category = blockedCategory(input);
  if (category) return { ok: false, contentHash: rawHash, bytes, category, policyVersion: "artifact-sandbox-v1" };
  const bundle = buildHtmlArtifactBundle(input);
  return {
    ok: true,
    bundle,
    contentHash: await sha256Hex(bundle),
    bytes: encoder.encode(bundle).byteLength,
    policyVersion: "artifact-sandbox-v1",
  };
}

export function artifactBundleObjectKey(artifactId: string, version: number, contentHash: string): string {
  return `artifacts/${artifactId}/v${version}-${contentHash}.html`;
}

export function artifactFrameSandbox(kind: HtmlArtifactKind): string {
  return kind === "interactive_capsule" ? "allow-scripts" : "";
}
