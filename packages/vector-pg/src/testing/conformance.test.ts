import { InMemoryChunkVectors } from "../inMemory";
import { runChunkVectorStoreConformance } from "./conformance";

runChunkVectorStoreConformance(async () => {
  const registry = new Map<string, string[]>(); // `${tenant}|${owner}|${doc}` -> ids
  const shared = new Map();
  const key = (s: { tenantId: string; ownerId: string }, d: string) =>
    `${s.tenantId}|${s.ownerId}|${d}`;
  const make = (modelId: string) =>
    new InMemoryChunkVectors({
      modelId,
      dimensions: 4,
      shared,
      chunkIds: async (s, d) => registry.get(key(s, d)) ?? [],
    });
  return {
    store: make("m1"),
    withModel: make,
    seed: async (s, d, ids) => void registry.set(key(s, d), [...ids]),
  };
}, "InMemoryChunkVectors");
