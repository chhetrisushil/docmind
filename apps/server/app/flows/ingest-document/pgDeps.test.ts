import { InMemoryChunkVectors } from "@docmind/vector-pg";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { FieldCrypto } from "../../crypto/fields";
import { IngestConfigError } from "./errors";
import { createIngestWiring } from "./limits";
import { pgIngestDeps } from "./pgDeps";

const env = {
  DOCMIND_LLM_PROVIDER: "off",
  DOCMIND_EMBED_MODEL: "a",
  DOCMIND_EMBED_DIMENSIONS: "8",
};
const args = (wiring: ReturnType<typeof createIngestWiring>, vectors: InMemoryChunkVectors) => ({
  pool: {} as Pool,
  fields: {} as FieldCrypto,
  keys: new InMemoryKeyStore(),
  blobs: () => ({ get: async () => null }),
  wiring,
  vectors,
});
const store = (modelId: string, dimensions: number) =>
  new InMemoryChunkVectors({ modelId, dimensions, chunkIds: async () => [] });

describe("pgIngestDeps embedder and vector store agreement", () => {
  it("refuses a different model at composition time", () => {
    const wiring = createIngestWiring(env);
    const run = () => pgIngestDeps(args(wiring, store("ollama/b", 8)));
    expect(run).toThrow(IngestConfigError);
    expect(run).toThrow(/^embedder and vector store modelId\/dimensions differ$/);
  });
  it("refuses different dimensions", () => {
    const wiring = createIngestWiring(env);
    expect(() => pgIngestDeps(args(wiring, store(wiring.embedder.modelId, 9)))).toThrow(
      IngestConfigError,
    );
  });
  it("accepts a store that matches the embedder", () => {
    const wiring = createIngestWiring(env);
    expect(() => pgIngestDeps(args(wiring, store(wiring.embedder.modelId, 8)))).not.toThrow();
  });
});
