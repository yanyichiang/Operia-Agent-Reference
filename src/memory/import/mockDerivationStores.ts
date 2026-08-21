import type { ImportVectorManifest, ImportVectorStore } from "./derivationTypes";

export class InMemoryImportVectorStore implements ImportVectorStore {
  readonly vectors = new Map<string, { manifest: ImportVectorManifest; vector: number[] }>();
  inspectCalls = 0;
  putCalls = 0;
  deleteCalls = 0;
  inspectUnknown = false;
  failPutAfterPersist = false;
  failDeleteAfterDelete = false;

  async inspect(vectorId: string): Promise<{ status: "missing" | "matched" | "mismatch" | "unknown"; manifest?: ImportVectorManifest }> {
    this.inspectCalls += 1;
    if (this.inspectUnknown) return { status: "unknown" };
    const stored = this.vectors.get(vectorId);
    return stored ? { status: "matched", manifest: stored.manifest } : { status: "missing" };
  }

  async put(manifest: ImportVectorManifest, vector: number[]): Promise<void> {
    this.putCalls += 1;
    this.vectors.set(manifest.vectorId, { manifest: structuredClone(manifest), vector: vector.slice() });
    if (this.failPutAfterPersist) throw new Error("synthetic_vector_put_unknown");
  }

  async delete(vectorId: string): Promise<void> {
    this.deleteCalls += 1;
    this.vectors.delete(vectorId);
    if (this.failDeleteAfterDelete) throw new Error("synthetic_vector_delete_unknown");
  }
}
