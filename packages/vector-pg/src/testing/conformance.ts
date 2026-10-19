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

    test("a repeated id in one call is written once (the last vector wins) and counted once", async ({
      store,
      seed,
    }) => {
      const [id] = uuids(1) as [string];
      await seed(A, DOC_A, [id]);
      const d = store.dimensions;
      expect(
        await store.upsert(A, DOC_A, [
          { chunkId: id, vector: basis(d, 0) },
          { chunkId: id, vector: basis(d, 1) },
        ]),
      ).toEqual({ written: 1, missing: [] });
      expect(ids(await store.search(A, basis(d, 1), 10, 0.9))).toEqual([id]);
      expect(await store.search(A, basis(d, 0), 10, 0.9)).toEqual([]);
    });

    test("search ranks by cosine similarity, best first, applies the floor and the limit", async ({
      store,
      seed,
    }) => {
      const [x, near, y] = uuids(3) as [string, string, string];
      await seed(A, DOC_A, [y, near, x]);
      const d = store.dimensions;
      const nearVec = basis(d, 0);
      nearVec[1] = 0.1;
      await store.upsert(A, DOC_A, [
        { chunkId: x, vector: basis(d, 0) },
        { chunkId: near, vector: nearVec },
        { chunkId: y, vector: basis(d, 1) },
      ]);
      const all = await store.search(A, basis(d, 0), 10);
      expect(ids(all)).toEqual([x, near, y]);
      expect(all[0]?.score).toBeCloseTo(1, 5);
      expect(all[2]?.score).toBeCloseTo(0, 5);
      expect(ids(await store.search(A, basis(d, 0), 10, 0.5))).toEqual([x, near]);
      expect(ids(await store.search(A, basis(d, 0), 2))).toEqual([x, near]);
      expect(await store.search(A, basis(d, 0), 0)).toEqual([]);
    });

    test("equal scores are ordered by chunk id", async ({ store, seed }) => {
      const c = uuids(3);
      await seed(A, DOC_A, c);
      const d = store.dimensions;
      await store.upsert(
        A,
        DOC_A,
        c.map((chunkId) => ({ chunkId, vector: basis(d, 2) })),
      );
      expect(ids(await store.search(A, basis(d, 2), 10))).toEqual([...c].sort());
      expect(ids(await store.search(A, basis(d, 2), 2))).toEqual([...c].sort().slice(0, 2));
    });

    test("a zero-length vector is never a hit, for a stored vector or a query", async ({
      store,
      seed,
    }) => {
      const [zero, real] = uuids(2) as [string, string];
      await seed(A, DOC_A, [zero, real]);
      const d = store.dimensions;
      await store.upsert(A, DOC_A, [
        { chunkId: zero, vector: new Array(d).fill(0) },
        { chunkId: real, vector: basis(d, 0) },
      ]);
      expect(ids(await store.search(A, basis(d, 0), 10, -1))).toEqual([real]);
      expect(await store.search(A, new Array(d).fill(0), 10, -1)).toEqual([]);
    });

    test("a query of the wrong dimension or with a non-finite value rejects with VectorDimensionError", async ({
      store,
      seed,
    }) => {
      const [id] = uuids(1) as [string];
      await seed(A, DOC_A, [id]);
      const d = store.dimensions;
      await store.upsert(A, DOC_A, [{ chunkId: id, vector: basis(d, 0) }]);
      for (const bad of [
        new Array(d - 1).fill(1),
        new Array(d + 1).fill(1),
        [],
        basis(d, 0).fill(Number.NaN),
        basis(d, 0).fill(Number.NEGATIVE_INFINITY),
      ]) {
        await expect(store.search(A, bad, 5)).rejects.toBeInstanceOf(VectorDimensionError);
      }
    });

    test("never reads or writes across users or tenants", async ({ store, seed }) => {
      const [mine, theirs, other] = uuids(3) as [string, string, string];
      await seed(A, DOC_A, [mine]);
      await seed(B, DOC_B, [theirs]);
      await seed(C, DOC_C, [other]);
      const d = store.dimensions;
      await store.upsert(A, DOC_A, [{ chunkId: mine, vector: basis(d, 0) }]);
      // another scope's document and chunk ids are reported missing and never written
      expect(await store.upsert(B, DOC_A, [{ chunkId: mine, vector: basis(d, 1) }])).toEqual({
        written: 0,
        missing: [mine],
      });
      expect(await store.upsert(C, DOC_A, [{ chunkId: mine, vector: basis(d, 1) }])).toEqual({
        written: 0,
        missing: [mine],
      });
      expect(await store.upsert(A, DOC_B, [{ chunkId: theirs, vector: basis(d, 1) }])).toEqual({
        written: 0,
        missing: [theirs],
      });
      expect(await store.upsert(A, DOC_A, [{ chunkId: theirs, vector: basis(d, 1) }])).toEqual({
        written: 0,
        missing: [theirs],
      });
      expect(await store.missing(B, DOC_A, 10)).toEqual([]);
      expect(await store.missing(C, DOC_A, 10)).toEqual([]);
      expect(await store.missing(A, DOC_B, 10)).toEqual([]);
      expect(await store.missing(B, DOC_B, 10)).toEqual([theirs]);
      expect(await store.missing(C, DOC_C, 10)).toEqual([other]);
      // the attempts wrote nothing: each scope searches only its own vectors
      expect(await store.search(B, basis(d, 0), 10)).toEqual([]);
      expect(await store.search(B, basis(d, 1), 10)).toEqual([]);
      expect(await store.search(C, basis(d, 0), 10)).toEqual([]);
      expect(await store.search(C, basis(d, 1), 10)).toEqual([]);
      expect(ids(await store.search(A, basis(d, 0), 10))).toEqual([mine]);
      expect(await store.search(A, basis(d, 1), 10, 0.5)).toEqual([]);
    });

    test("search and missing never return a chunk that no longer exists", async ({
      store,
      seed,
      withModel,
    }) => {
      const [x, y] = uuids(2) as [string, string];
      await seed(A, DOC_A, [x, y]);
      const d = store.dimensions;
      await store.upsert(A, DOC_A, [
        { chunkId: x, vector: basis(d, 0) },
        { chunkId: y, vector: basis(d, 0) },
      ]);
      await seed(A, DOC_A, [y]); // x is deleted
      expect(ids(await store.search(A, basis(d, 0), 10))).toEqual([y]);
      expect(await store.missing(A, DOC_A, 10)).toEqual([]);
      expect(await store.upsert(A, DOC_A, [{ chunkId: x, vector: basis(d, 1) }])).toEqual({
        written: 0,
        missing: [x],
      });
      await seed(A, DOC_A, [x, y]); // x comes back as a new row: no vector
      expect(await store.missing(A, DOC_A, 10)).toEqual([x]);
      expect(ids(await store.search(A, basis(d, 0), 10))).toEqual([y]);
      expect(await withModel("another-model").search(A, basis(d, 0), 10)).toEqual([]);
      await seed(A, DOC_A, []); // the whole document goes
      expect(await store.search(A, basis(d, 0), 10)).toEqual([]);
      expect(await store.missing(A, DOC_A, 10)).toEqual([]);
    });

    test("a store with another model id sees the chunks as unembedded and finds nothing until they are rewritten", async ({
      store,
      seed,
      withModel,
    }) => {
      const [id] = uuids(1) as [string];
      await seed(A, DOC_A, [id]);
      const d = store.dimensions;
      await store.upsert(A, DOC_A, [{ chunkId: id, vector: basis(d, 0) }]);
      const other = withModel("another-model");
      expect(await other.missing(A, DOC_A, 10)).toEqual([id]);
      expect(await other.search(A, basis(d, 0), 10)).toEqual([]);
      await other.upsert(A, DOC_A, [{ chunkId: id, vector: basis(d, 0) }]);
      expect(await other.missing(A, DOC_A, 10)).toEqual([]);
      expect(ids(await other.search(A, basis(d, 0), 10))).toEqual([id]);
      expect(await store.missing(A, DOC_A, 10)).toEqual([id]); // one vector per chunk: the first model's is gone
      expect(await store.search(A, basis(d, 0), 10)).toEqual([]);
    });
  });
}
