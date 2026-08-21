import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { buildMusicSharePosterSvg, type MusicPosterVariant } from "./musicSharePosterTemplate";

export type { MusicPosterVariant } from "./musicSharePosterTemplate";
let wasmReady: Promise<void> | undefined;

export async function renderMusicSharePoster(cover: Uint8Array,contentType: string,variant: MusicPosterVariant): Promise<Uint8Array> {
  if (!wasmReady) wasmReady = initWasm(resvgWasm);
  await wasmReady;
  const svg = buildMusicSharePosterSvg(`data:${contentType};base64,${bytesToBase64(cover)}`,variant);
  const renderer = new Resvg(svg,{ fitTo:{ mode:"width",value:720 },font:{ loadSystemFonts:false } });
  try {
    const rendered = renderer.render();
    try { return rendered.asPng(); } finally { rendered.free(); }
  } finally { renderer.free(); }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset=0;offset<bytes.length;offset+=0x8000) binary += String.fromCharCode(...bytes.subarray(offset,Math.min(bytes.length,offset+0x8000)));
  return btoa(binary);
}
