import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type ChunkVectorStore, VectorDimensionError, type VectorScope } from "../types";

export interface VectorHarness {
  store: ChunkVectorStore;
  /**
   * Makes `ids` exist as the chunk rows of `documentId` (ordinals in array order) for this
   * scope, and no others: the kit reuses the document across cases, so seed REPLACES the
   * document's chunks. Seeding fewer ids is how the kit deletes a chunk, and it must drop the
   * removed chunks' vectors (Postgres: delete the document's chunks first, the cascade removes
   * the vectors; Task 89, F02). No separate delete method exists on the harness.
   */
  seed(scope: VectorScope, documentId: string, ids: string[]): Promise<void>;
  /** A second store over the same rows with another model id. */
  withModel(modelId: string): ChunkVectorStore;
}

// UUIDs, because the Postgres implementation's columns are uuid.
export const A: VectorScope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  ownerId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
};
export const B: VectorScope = {
  tenantId: A.tenantId,
  ownerId: "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2",
}; // same tenant, other user
export const C: VectorScope = {
  tenantId: "22222222-2222-4222-8222-222222222222",
  ownerId: "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3",
}; // other tenant
export const DOC_A = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
export const DOC_B = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
export const DOC_C = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3";

const basis = (d: number, i: number): number[] => {
  const v = new Array<number>(d).fill(0);
  v[i % d] = 1;
  return v;
};
const uuids = (n: number) => Array.from({ length: n }, () => randomUUID());
const ids = (hits: { chunkId: string }[]) => hits.map((h) => h.chunkId);

export function runChunkVectorStoreConformance(
  factory: () => Promise<VectorHarness>,
  label = "ChunkVectorStore",
): void {
  const test = (name: string, body: (h: VectorHarness) => Promise<void>) =>
    it(name, async () => {
      await body(await factory());
    });

  describe(`${label} conformance (ChunkVectorStore)`, () => {
    test("missing lists the chunks without a vector in ordinal order, honours the limit, and shrinks as vectors arrive", async ({
      store,
      seed,
    }) => {
      const c = uuids(3) as [string, string, string];
      await seed(A, DOC_A, c);
      const d = store.dimensions;
      expect(await store.missing(A, DOC_A, 2)).toEqual([c[0], c[1]]);
      expect(await store.missing(A, DOC_A, 0)).toEqual([]);
      expect(await store.upsert(A, DOC_A, [{ chunkId: c[1], vector: basis(d, 0) }])).toEqual({
        written: 1,
        missing: [],
      });
      expect(await store.missing(A, DOC_A, 10)).toEqual([c[0], c[2]]);
    });

    test("upsert is idempotent by chunk id: the second vector replaces the first", async ({
      store,
      seed,
    }) => {
      const [id] = uuids(1) as [string];
      await seed(A, DOC_A, [id]);
      const d = store.dimensions;
      await store.upsert(A, DOC_A, [{ chunkId: id, vector: basis(d, 0) }]);
      expect(await store.upsert(A, DOC_A, [{ chunkId: id, vector: basis(d, 1) }])).toEqual({
        written: 1,
        missing: [],
      });
      expect(ids(await store.search(A, basis(d, 1), 10, 0.9))).toEqual([id]);
      expect(await store.search(A, basis(d, 0), 10, 0.9)).toEqual([]);
    });

    test("upsert reports ids with no chunk row as missing, once each, and still writes the rest", async ({
      store,
      seed,
    }) => {
      const [real] = uuids(1) as [string];
      const ghost = randomUUID();
      await seed(A, DOC_A, [real]);
      const d = store.dimensions;
      expect(
        await store.upsert(A, DOC_A, [
          { chunkId: ghost, vector: basis(d, 0) },
          { chunkId: ghost, vector: basis(d, 0) },
          { chunkId: real, vector: basis(d, 1) },
        ]),
      ).toEqual({ written: 1, missing: [ghost] });
      expect(ids(await store.search(A, basis(d, 1), 10, 0.5))).toEqual([real]);
      expect(await store.search(A, basis(d, 0), 10, 0.5)).toEqual([]); // the ghost's vector was not written
    });

    test("a wrong-size or non-finite vector rejects with VectorDimensionError and writes none of the batch", async ({
      store,
      seed,
    }) => {
      const c = uuids(2) as [string, string];
      await seed(A, DOC_A, c);
      const d = store.dimensions;
      const good = { chunkId: c[0], vector: basis(d, 0) };
      for (const bad of [
        new Array(d + 1).fill(1),
        new Array(d - 1).fill(1),
        [],
        basis(d, 0).fill(Number.NaN),
        basis(d, 0).fill(Number.POSITIVE_INFINITY),
      ]) {
        await expect(
          store.upsert(A, DOC_A, [good, { chunkId: c[1], vector: bad }]),
        ).rejects.toBeInstanceOf(VectorDimensionError);
      }
      expect(await store.missing(A, DOC_A, 10)).toEqual(c);
      expect(await store.search(A, basis(d, 0), 10)).toEqual([]);
    });
  });
}
