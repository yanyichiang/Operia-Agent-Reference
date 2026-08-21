import type { JsonValue } from "./types";

const POINTER_KEY = "operia/current.json";
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_SEARCH_SHARD_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 256 * 1024;
const MAX_LIST_RESULTS = 100;
const MAX_SEARCH_RESULTS = 40;
const MAX_READ_LINES = 400;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_.@+\/-]{1,500}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const CONTENT_SHA = /^[a-f0-9]{64}$/;

type SourcePointer = {
  schemaVersion: 1;
  repoId: "operia";
  commitSha: string;
  treeHash: string;
  manifestObjectKey: string;
};

type SourceManifestFile = {
  path: string;
  bytes: number;
  sha256: string;
  objectKey: string;
};

type SourceManifestSearchObject = {
  objectKey: string;
  bytes: number;
  sha256: string;
};

type SourceManifest = {
  schemaVersion: 1;
  repoId: "operia";
  commitSha: string;
  treeHash: string;
  generatedAt: string;
  searchObjects: SourceManifestSearchObject[];
  files: SourceManifestFile[];
};

type SearchLine = { path: string; line: number; text: string };

export type SourceWorkspaceArgs = Record<string, unknown>;

export async function executeSourceWorkspaceRead(
  bucket: R2Bucket,
  toolName: string,
  args: SourceWorkspaceArgs,
): Promise<JsonValue> {
  const pointer = await readJsonObject<SourcePointer>(bucket, POINTER_KEY, MAX_MANIFEST_BYTES, "source_pointer");
  assertPointer(pointer);
  const manifest = await readJsonObject<SourceManifest>(
    bucket,
    pointer.manifestObjectKey,
    MAX_MANIFEST_BYTES,
    "source_manifest",
  );
  await assertManifest(pointer, manifest);
  if (toolName === "list") return listSource(manifest, args);
  if (toolName === "search") return await searchSource(bucket, manifest, args);
  if (toolName === "read") return await readSource(bucket, manifest, args);
  if (toolName === "inspect") return await inspectSource(bucket, manifest, args);
  throw new Error("source_workspace_tool_unavailable");
}

async function inspectSource(bucket: R2Bucket, manifest: SourceManifest, args: SourceWorkspaceArgs): Promise<JsonValue> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query || query.length > 200) throw new Error("source_workspace_query_invalid");
  const prefix = optionalSafePath(args.prefix, true);
  const maxFiles = boundedInteger(args.max_files, 1, 8, 4);
  const maxLines = boundedInteger(args.max_lines, 20, 400, 160);
  const search = await searchSource(bucket, manifest, {
    query,
    prefix,
    limit: Math.min(MAX_SEARCH_RESULTS, Math.max(maxFiles * 4, maxFiles)),
  }) as Record<string, JsonValue>;
  const matches = Array.isArray(search.matches) ? search.matches : [];
  const selectedPaths: string[] = [];
  for (const match of matches) {
    if (!match || typeof match !== "object" || Array.isArray(match)) continue;
    const path = (match as Record<string, JsonValue>).path;
    if (typeof path === "string" && !selectedPaths.includes(path)) selectedPaths.push(path);
    if (selectedPaths.length >= maxFiles) break;
  }
  const perFileLines = Math.max(20, Math.floor(maxLines / Math.max(1, selectedPaths.length)));
  const files: JsonValue[] = [];
  let consumedLines = 0;
  for (const path of selectedPaths) {
    const firstMatch = matches.find((item) => item && typeof item === "object" && !Array.isArray(item)
      && (item as Record<string, JsonValue>).path === path) as Record<string, JsonValue> | undefined;
    const matchLine = typeof firstMatch?.line === "number" ? firstMatch.line : 1;
    const remaining = Math.max(1, maxLines - consumedLines);
    const windowLines = Math.min(perFileLines, remaining);
    const startLine = Math.max(1, matchLine - Math.floor(windowLines / 3));
    const read = await readSource(bucket, manifest, {
      path,
      start_line: startLine,
      end_line: startLine + windowLines - 1,
    }) as Record<string, JsonValue>;
    if (read.commitSha !== manifest.commitSha || read.treeHash !== manifest.treeHash) {
      throw new Error("source_workspace_inspect_revision_drift");
    }
    const lines = Array.isArray(read.lines) ? read.lines : [];
    consumedLines += lines.length;
    files.push({
      path,
      fileSha256: read.fileSha256 ?? "",
      startLine: read.startLine ?? startLine,
      endLine: read.endLine ?? startLine,
      totalLines: read.totalLines ?? lines.length,
      lines,
    });
    if (consumedLines >= maxLines) break;
  }
  const matchedPathCount = new Set(matches.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    const path = (item as Record<string, JsonValue>).path;
    return typeof path === "string" ? path : "";
  }).filter(Boolean)).size;
  const truncated = search.truncated === true
    || selectedPaths.length < matchedPathCount
    || files.length < selectedPaths.length;
  return snapshotEnvelope(manifest, {
    query,
    prefix,
    matches,
    files,
    maxFiles,
    maxLines,
    truncated,
    terminalPlan: files.length > 0 && !truncated,
  });
}

function listSource(manifest: SourceManifest, args: SourceWorkspaceArgs): JsonValue {
  const prefix = optionalSafePath(args.prefix, true);
  const limit = boundedInteger(args.limit, 1, MAX_LIST_RESULTS, 50);
  const files = manifest.files
    .filter((file) => !prefix || file.path.startsWith(prefix));
  const truncated = files.length > limit;
  const boundedFiles = files
    .slice(0, limit)
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  return snapshotEnvelope(manifest, { prefix, files: boundedFiles, truncated });
}

async function searchSource(bucket: R2Bucket, manifest: SourceManifest, args: SourceWorkspaceArgs): Promise<JsonValue> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query || query.length > 200) throw new Error("source_workspace_query_invalid");
  const prefix = optionalSafePath(args.prefix, true);
  const limit = boundedInteger(args.limit, 1, MAX_SEARCH_RESULTS, 20);
  const needle = query.toLocaleLowerCase("en-US");
  const matches: SearchLine[] = [];
  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  for (const searchObject of manifest.searchObjects) {
    if (matches.length > limit) break;
    const object = await bucket.get(searchObject.objectKey);
    if (!object) throw new Error("source_search_index_missing");
    const bytes = Number(object.size);
    if (!Number.isSafeInteger(bytes) || bytes !== searchObject.bytes || bytes < 1 || bytes > MAX_SEARCH_SHARD_BYTES) {
      throw new Error("source_search_index_size_invalid");
    }
    const raw = await object.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_SEARCH_SHARD_BYTES) throw new Error("source_search_index_size_invalid");
    if (await sha256Hex(raw) !== searchObject.sha256) throw new Error("source_search_index_integrity_invalid");
    for (const line of raw.split("\n")) {
      if (!line || matches.length > limit) break;
      let entry: SearchLine;
      try { entry = JSON.parse(line) as SearchLine; }
      catch { throw new Error("source_search_index_invalid"); }
      if (!safeManifestPath(entry.path) || !manifestPaths.has(entry.path) || !Number.isSafeInteger(entry.line) || entry.line < 1
        || typeof entry.text !== "string" || entry.text.length > 2000) {
        throw new Error("source_search_index_invalid");
      }
      if (prefix && !entry.path.startsWith(prefix)) continue;
      if (entry.text.toLocaleLowerCase("en-US").includes(needle)) {
        matches.push({ path: entry.path, line: entry.line, text: entry.text.slice(0, 500) });
      }
    }
  }
  return snapshotEnvelope(manifest, { query, prefix, matches: matches.slice(0, limit), truncated: matches.length > limit });
}

async function readSource(bucket: R2Bucket, manifest: SourceManifest, args: SourceWorkspaceArgs): Promise<JsonValue> {
  const path = optionalSafePath(args.path, false);
  const file = manifest.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error("source_workspace_file_not_found");
  if (file.bytes > MAX_SOURCE_FILE_BYTES) throw new Error("source_workspace_file_too_large");
  const object = await bucket.get(file.objectKey);
  if (!object || Number(object.size) !== file.bytes) throw new Error("source_workspace_file_snapshot_mismatch");
  const content = await object.text();
  if (new TextEncoder().encode(content).byteLength !== file.bytes) throw new Error("source_workspace_file_snapshot_mismatch");
  if (await sha256Hex(content) !== file.sha256) throw new Error("source_workspace_file_snapshot_mismatch");
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const startLine = boundedInteger(args.start_line, 1, Math.max(1, lines.length), 1);
  const endLine = boundedInteger(args.end_line, startLine, Math.min(lines.length, startLine + MAX_READ_LINES - 1), Math.min(lines.length, startLine + 199));
  const selected = lines.slice(startLine - 1, endLine).map((text, index) => ({ line: startLine + index, text }));
  return snapshotEnvelope(manifest, {
    path,
    fileSha256: file.sha256,
    startLine,
    endLine,
    totalLines: lines.length,
    lines: selected,
  });
}

function snapshotEnvelope(manifest: SourceManifest, payload: Record<string, JsonValue>): JsonValue {
  return {
    repoId: manifest.repoId,
    commitSha: manifest.commitSha,
    treeHash: manifest.treeHash,
    generatedAt: manifest.generatedAt,
    readOnly: true,
    ...payload,
  };
}

async function readJsonObject<T>(bucket: R2Bucket, key: string, maxBytes: number, label: string): Promise<T> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`${label}_missing`);
  const size = Number(object.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) throw new Error(`${label}_size_invalid`);
  try { return JSON.parse(await object.text()) as T; }
  catch { throw new Error(`${label}_invalid`); }
}

function assertPointer(pointer: SourcePointer): void {
  if (pointer?.schemaVersion !== 1 || pointer.repoId !== "operia" || !COMMIT_SHA.test(pointer.commitSha)
    || !CONTENT_SHA.test(pointer.treeHash)
    || pointer.manifestObjectKey !== `operia/${pointer.commitSha}/manifest.json`) {
    throw new Error("source_pointer_invalid");
  }
}

async function assertManifest(pointer: SourcePointer, manifest: SourceManifest): Promise<void> {
  if (manifest?.schemaVersion !== 1 || manifest.repoId !== pointer.repoId || manifest.commitSha !== pointer.commitSha
    || manifest.treeHash !== pointer.treeHash || !Array.isArray(manifest.searchObjects)
    || manifest.searchObjects.length < 1 || manifest.searchObjects.length > 64
    || typeof manifest.generatedAt !== "string" || !Array.isArray(manifest.files) || manifest.files.length > 2000) {
    throw new Error("source_manifest_invalid");
  }
  const paths = new Set<string>();
  const searchKeys = new Set<string>();
  for (const search of manifest.searchObjects) {
    if (!search || !safeObjectKey(search.objectKey) || !search.objectKey.startsWith(`operia/${manifest.commitSha}/search-`)
      || searchKeys.has(search.objectKey) || !Number.isSafeInteger(search.bytes) || search.bytes < 1
      || search.bytes > MAX_SEARCH_SHARD_BYTES || !CONTENT_SHA.test(search.sha256)) throw new Error("source_manifest_invalid");
    searchKeys.add(search.objectKey);
  }
  for (const file of manifest.files) {
    if (!safeManifestPath(file.path) || paths.has(file.path)
      || file.objectKey !== `operia/${manifest.commitSha}/files/${file.path}`
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_SOURCE_FILE_BYTES
      || !CONTENT_SHA.test(file.sha256)) throw new Error("source_manifest_invalid");
    paths.add(file.path);
  }
  const recomputedTreeHash = await sha256Hex([...manifest.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${file.sha256}\0${file.bytes}`).join("\n"));
  if (recomputedTreeHash !== manifest.treeHash) throw new Error("source_manifest_tree_hash_invalid");
}

function optionalSafePath(value: unknown, allowEmpty: boolean): string {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path && allowEmpty) return "";
  if (!safeManifestPath(path)) throw new Error("source_workspace_path_invalid");
  return path;
}

function safeManifestPath(path: unknown): path is string {
  return typeof path === "string" && SAFE_PATH.test(path) && !path.includes("//")
    && !/(?:^|\/)(?:\.git|\.env(?:\.|$)|secrets?|credentials?|private[-_.]?keys?)(?:\/|$)/i.test(path);
}

function safeObjectKey(key: unknown): key is string {
  return typeof key === "string" && SAFE_PATH.test(key) && key.startsWith("operia/") && !key.includes("//");
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
