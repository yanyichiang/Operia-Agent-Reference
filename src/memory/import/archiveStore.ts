export interface RawArchiveManifest {
  blobSha256: string;
  byteCount: number;
  adapterId: string;
  adapterVersion: string;
  storageVersion: "private-r2/v1";
}

export type RawArchiveInspection =
  | { status: "missing" }
  | { status: "matched" }
  | { status: "mismatch" };

export interface ConversationImportRawArchiveStore {
  put(opaqueRef: string, bytes: Uint8Array, manifest: RawArchiveManifest): Promise<void>;
  inspect(opaqueRef: string, expected: RawArchiveManifest): Promise<RawArchiveInspection>;
  delete(opaqueRef: string): Promise<void>;
}

export interface ConversationImportStreamingRawArchiveStore extends ConversationImportRawArchiveStore {
  putStream(opaqueRef: string, stream: ReadableStream<Uint8Array>, manifest: RawArchiveManifest): Promise<void>;
}

function hex(value: ArrayBuffer | undefined): string | undefined {
  return value ? [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("") : undefined;
}

function manifestMatches(
  metadata: Record<string, string> | undefined,
  expected: RawArchiveManifest,
  actualSize?: number,
  actualSha256?: ArrayBuffer,
): boolean {
  return (actualSize === undefined || actualSize === expected.byteCount)
    && actualSha256 !== undefined
    && hex(actualSha256) === expected.blobSha256
    && metadata?.blob_sha256 === expected.blobSha256
    && metadata.byte_count === String(expected.byteCount)
    && metadata.adapter === `${expected.adapterId}@${expected.adapterVersion}`
    && metadata.storage_version === expected.storageVersion;
}

export class R2ConversationImportRawArchiveStore implements ConversationImportRawArchiveStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(opaqueRef: string, bytes: Uint8Array, manifest: RawArchiveManifest): Promise<void> {
    await this.putValue(opaqueRef, bytes, manifest);
  }

  async putStream(opaqueRef: string, stream: ReadableStream<Uint8Array>, manifest: RawArchiveManifest): Promise<void> {
    await this.putValue(opaqueRef, stream, manifest);
  }

  private async putValue(opaqueRef: string, value: Uint8Array | ReadableStream<Uint8Array>, manifest: RawArchiveManifest): Promise<void> {
    await this.bucket.put(opaqueRef, value, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        blob_sha256: manifest.blobSha256,
        byte_count: String(manifest.byteCount),
        adapter: `${manifest.adapterId}@${manifest.adapterVersion}`,
        storage_version: manifest.storageVersion,
      },
      sha256: manifest.blobSha256,
    });
  }

  async inspect(opaqueRef: string, expected: RawArchiveManifest): Promise<RawArchiveInspection> {
    const object = await this.bucket.head(opaqueRef);
    if (!object) return { status: "missing" };
    return { status: manifestMatches(object.customMetadata, expected, object.size, object.checksums.sha256) ? "matched" : "mismatch" };
  }

  async delete(opaqueRef: string): Promise<void> {
    await this.bucket.delete(opaqueRef);
  }
}
