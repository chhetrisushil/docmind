import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type ChunkVectorStore, VectorDimensionError, type VectorScope } from "../types";

export interface VectorHarness {
  store: ChunkVectorStore;
  /**
   * Makes `ids` exist as the chunk rows of `documentId` (ordinals in array order) for this
   * scope, and no others: the kit reuses the document across cases, so seed REPLACES the
   * document's chunks. Seeding fewer ids is how the kit deletes a chunk, and it must drop the
   * removed chunks' vectors and keep the vectors of surviving ids (Postgres: delete the chunks not in
   * `ids`, the cascade removes their vectors, and update the survivors' ordinals; Task 89, F02). No separate delete method exists on the harness.
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
export const DOC_A2 = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4"; // a second document of owner A
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
      // Which two of three exactly tied chunks fill a limit of 2 is unspecified (an index scan does
      // not break ties); the two returned are still ordered by id.
      const two = ids(await store.search(A, basis(d, 2), 2));
      expect(two).toHaveLength(2);
      expect(two).toEqual([...two].sort());
      expect(two.every((id) => (c as string[]).includes(id))).toBe(true);
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

    test("a value beyond float4 range rejects with VectorDimensionError, in a vector and in a query", async ({
      store,
      seed,
    }) => {
      const [id] = uuids(1) as [string];
      await seed(A, DOC_A, [id]);
      const d = store.dimensions;
      for (const big of [1e39, -1e39]) {
        const bad = basis(d, 0);
        bad[1] = big;
        await expect(store.upsert(A, DOC_A, [{ chunkId: id, vector: bad }])).rejects.toBeInstanceOf(
          VectorDimensionError,
        );
        await expect(store.search(A, bad, 5)).rejects.toBeInstanceOf(VectorDimensionError);
      }
      expect(await store.missing(A, DOC_A, 10)).toEqual([id]);
    });

    test("a chunk id of the same owner's other document is missing for this document and is not written", async ({
      store,
      seed,
    }) => {
      const [mine] = uuids(1) as [string];
      const [other] = uuids(1) as [string];
      await seed(A, DOC_A, [mine]);
      await seed(A, DOC_A2, [other]);
      const d = store.dimensions;
      expect(await store.upsert(A, DOC_A, [{ chunkId: other, vector: basis(d, 0) }])).toEqual({
        written: 0,
        missing: [other],
      });
      expect(await store.missing(A, DOC_A2, 10)).toEqual([other]);
      expect(await store.search(A, basis(d, 0), 10)).toEqual([]);
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

    const half = (d: number): number[] => {
      const v = new Array<number>(d).fill(0);
      v[0] = Math.SQRT1_2;
      v[1] = Math.SQRT1_2;
      return v;
    };
    // These cases seed several documents in the shared database; restore them so no other case sees the vectors.
    const ntest = (name: string, body: (h: VectorHarness) => Promise<void>) =>
      test(name, async (h) => {
        try {
          await body(h);
        } finally {
          await h.seed(A, DOC_A, []);
          await h.seed(A, DOC_A2, []);
          await h.seed(B, DOC_B, []);
          await h.seed(C, DOC_C, []);
        }
      });
    const hits = (r: { chunkId: string; neighbourId: string; score: number }[]) =>
      r.map((h) => [h.chunkId, h.neighbourId] as const);

    ntest(
      "neighbours finds only the owner's other documents, this model, and non-zero vectors",
      async ({ store, seed, withModel }) => {
        const [src, same, near, far, zero, theirs, foreign, otherModel] = uuids(8) as string[] as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        const d = store.dimensions;
        await seed(A, DOC_A, [src, same]);
        await seed(A, DOC_A2, [near, far, zero, otherModel]);
        await seed(B, DOC_B, [theirs]);
        await seed(C, DOC_C, [foreign]);
        await store.upsert(A, DOC_A, [
          { chunkId: src, vector: basis(d, 0) },
          { chunkId: same, vector: basis(d, 0) },
        ]);
        await store.upsert(A, DOC_A2, [
          { chunkId: near, vector: half(d) },
          { chunkId: far, vector: basis(d, 2) },
          { chunkId: zero, vector: new Array(d).fill(0) },
        ]);
        await withModel("another-model").upsert(A, DOC_A2, [
          { chunkId: otherModel, vector: basis(d, 0) },
        ]);
        await store.upsert(B, DOC_B, [{ chunkId: theirs, vector: basis(d, 0) }]);
        await store.upsert(C, DOC_C, [{ chunkId: foreign, vector: basis(d, 0) }]);
        const all = await store.neighbours(A, DOC_A, [src], 10, -1);
        expect(hits(all)).toEqual([
          [src, near],
          [src, far],
        ]);
        expect(all[0]?.score).toBeCloseTo(Math.SQRT1_2, 5);
        expect(all[1]?.score).toBeCloseTo(0, 5);
        expect(hits(await store.neighbours(A, DOC_A, [src], 10, 0.5))).toEqual([[src, near]]);
      },
    );

    ntest(
      "neighbours returns at most perChunk per source, best first, ties by neighbour id",
      async ({ store, seed }) => {
        const s = uuids(2).sort() as [string, string];
        const tied = uuids(3);
        const best = randomUUID();
        const d = store.dimensions;
        await seed(A, DOC_A, s);
        await seed(A, DOC_A2, [...tied, best]);
        await store.upsert(
          A,
          DOC_A,
          s.map((chunkId) => ({ chunkId, vector: basis(d, 0) })),
        );
        await store.upsert(A, DOC_A2, [
          ...tied.map((chunkId) => ({ chunkId, vector: half(d) })),
          { chunkId: best, vector: basis(d, 0) },
        ]);
        const sortedTied = [...tied].sort();
        const two = await store.neighbours(A, DOC_A, [s[1], s[0]], 2, 0.5);
        expect(hits(two)).toEqual([
          [s[0], best],
          [s[0], sortedTied[0] as string],
          [s[1], best],
          [s[1], sortedTied[0] as string],
        ]);
        expect(two.every((h) => h.score >= 0.5)).toBe(true);
        expect(hits(await store.neighbours(A, DOC_A, [s[0]], 100, 0.5))).toEqual([
          [s[0], best],
          ...sortedTied.map((n) => [s[0], n] as const),
        ]);
      },
    );

    ntest(
      "neighbours yields nothing for unknown, another document's, another owner's, or unembedded sources",
      async ({ store, seed }) => {
        const [mine, unembedded, other, theirs, target] = uuids(5) as string[] as [
          string,
          string,
          string,
          string,
          string,
        ];
        const d = store.dimensions;
        await seed(A, DOC_A, [mine, unembedded]);
        await seed(A, DOC_A2, [other, target]);
        await seed(B, DOC_B, [theirs]);
        await store.upsert(A, DOC_A, [{ chunkId: mine, vector: basis(d, 0) }]);
        await store.upsert(A, DOC_A2, [
          { chunkId: other, vector: basis(d, 0) },
          { chunkId: target, vector: basis(d, 0) },
        ]);
        await store.upsert(B, DOC_B, [{ chunkId: theirs, vector: basis(d, 0) }]);
        const ghost = randomUUID();
        expect(
          await store.neighbours(A, DOC_A, [ghost, unembedded, other, theirs, "not-a-uuid"], 5, -1),
        ).toEqual([]);
        expect(await store.neighbours(B, DOC_A, [mine], 5, -1)).toEqual([]);
        expect(await store.neighbours(A, DOC_B, [theirs], 5, -1)).toEqual([]);
        expect(await store.neighbours(A, DOC_A, [], 5, -1)).toEqual([]);
        const found = await store.neighbours(A, DOC_A, [ghost, mine], 5, -1);
        expect(found.map((h) => h.neighbourId)).toEqual([other, target].sort());
        expect(found.every((h) => h.chunkId === mine)).toBe(true);
      },
    );

    test("neighbours rejects a bad perChunk or minScore with a RangeError naming the parameter", async ({
      store,
    }) => {
      for (const n of [0, -1, 101, 1.5, Number.NaN]) {
        await expect(store.neighbours(A, DOC_A, [], n, 0)).rejects.toThrow(
          /^neighbours: perChunk /,
        );
      }
      for (const m of [-1.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(store.neighbours(A, DOC_A, [], 1, m)).rejects.toThrow(
          /^neighbours: minScore /,
        );
        await expect(store.neighbours(A, DOC_A, [], 1, m)).rejects.toBeInstanceOf(RangeError);
      }
    });

    ntest(
      "search with documentIds keeps only those documents, limits after the filter, and [] matches nothing",
      async ({ store, seed }) => {
        const [a1, a2, b1, other] = uuids(4) as [string, string, string, string];
        const d = store.dimensions;
        const tilted = basis(d, 0);
        tilted[1] = 0.1;
        await seed(A, DOC_A, [a1, a2]);
        await seed(A, DOC_A2, [b1]);
        await seed(B, DOC_B, [other]);
        await store.upsert(A, DOC_A, [
          { chunkId: a1, vector: tilted },
          { chunkId: a2, vector: half(d) },
        ]);
        await store.upsert(A, DOC_A2, [{ chunkId: b1, vector: basis(d, 0) }]);
        await store.upsert(B, DOC_B, [{ chunkId: other, vector: basis(d, 0) }]);
        const q = basis(d, 0);
        expect(ids(await store.search(A, q, 10))).toEqual([b1, a1, a2]);
        expect(ids(await store.search(A, q, 10, undefined, {}))).toEqual([b1, a1, a2]);
        expect(ids(await store.search(A, q, 10, undefined, { documentIds: [DOC_A] }))).toEqual([
          a1,
          a2,
        ]);
        expect(ids(await store.search(A, q, 1, undefined, { documentIds: [DOC_A] }))).toEqual([a1]);
        expect(
          ids(await store.search(A, q, 2, undefined, { documentIds: [DOC_A, DOC_A2] })),
        ).toEqual([b1, a1]);
        expect(ids(await store.search(A, q, 10, 0.9, { documentIds: [DOC_A] }))).toEqual([a1]);
        expect(await store.search(A, q, 10, undefined, { documentIds: [] })).toEqual([]);
        // a document of another owner or tenant, or one that does not exist, matches nothing
        expect(
          await store.search(A, q, 10, undefined, { documentIds: [DOC_B, DOC_C, randomUUID()] }),
        ).toEqual([]);
        expect(
          ids(await store.search(A, q, 10, undefined, { documentIds: [DOC_A2, DOC_B] })),
        ).toEqual([b1]);
      },
    );

    test("search rejects a minScore that is not finite or not in [-1, 1] with a RangeError", async ({
      store,
    }) => {
      const q = basis(store.dimensions, 0);
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1.5]) {
        await expect(store.search(A, q, 5, bad)).rejects.toBeInstanceOf(RangeError);
        await expect(store.search(A, q, 5, bad, { documentIds: [DOC_A] })).rejects.toBeInstanceOf(
          RangeError,
        );
      }
    });

    test("search rejects a document filter of more than 1000 ids with a RangeError", async ({
      store,
    }) => {
      const many = Array.from({ length: 1001 }, () => randomUUID());
      const query = basis(store.dimensions, 0);
      await expect(store.search(A, query, 5, undefined, { documentIds: many })).rejects.toThrow(
        /^search: filter\.documentIds is limited to 1000 ids$/,
      );
      await expect(
        store.search(A, query, 5, undefined, { documentIds: many }),
      ).rejects.toBeInstanceOf(RangeError);
    });

    ntest(
      "vectors returns the owner's stored vectors of this model, and leaves out everything else",
      async ({ store, seed, withModel }) => {
        const [mine, mine2, zero, unembedded, theirs, foreign, retired, ghost] = uuids(
          8,
        ) as string[] as [string, string, string, string, string, string, string, string];
        const d = store.dimensions;
        await seed(A, DOC_A, [mine, zero, unembedded, retired]);
        await seed(A, DOC_A2, [mine2]);
        await seed(B, DOC_B, [theirs]);
        await seed(C, DOC_C, [foreign]);
        const tilted = basis(d, 2);
        tilted[3] = 0.25;
        await store.upsert(A, DOC_A, [
          { chunkId: mine, vector: tilted },
          { chunkId: zero, vector: new Array(d).fill(0) },
          { chunkId: retired, vector: basis(d, 0) },
        ]);
        await store.upsert(A, DOC_A2, [{ chunkId: mine2, vector: half(d) }]);
        await store.upsert(B, DOC_B, [{ chunkId: theirs, vector: basis(d, 0) }]);
        await store.upsert(C, DOC_C, [{ chunkId: foreign, vector: basis(d, 0) }]);
        await withModel("another-model").upsert(A, DOC_A, [
          { chunkId: retired, vector: basis(d, 1) },
        ]);
        const got = await store.vectors(A, [
          mine,
          mine,
          mine2,
          zero,
          unembedded,
          theirs,
          foreign,
          retired,
          ghost,
        ]);
        expect([...got.keys()].sort()).toEqual([mine, mine2].sort());
        const close = (a: number[] | undefined, b: number[]) => {
          expect(a).toHaveLength(d);
          for (const [i, x] of b.entries()) expect(a?.[i]).toBeCloseTo(x, 5);
        };
        close(got.get(mine), tilted);
        close(got.get(mine2), half(d));
        expect((await store.vectors(B, [mine, theirs])).size).toBe(1);
        expect([...(await store.vectors(C, [mine, theirs, foreign])).keys()]).toEqual([foreign]);
        expect((await store.vectors(A, [])).size).toBe(0);
        await seed(A, DOC_A2, []); // the chunk is deleted: its vector goes with it
        expect([...(await store.vectors(A, [mine, mine2])).keys()]).toEqual([mine]);
      },
    );

    test("vectors rejects more than 1000 ids with a RangeError", async ({ store }) => {
      const many = Array.from({ length: 1001 }, () => randomUUID());
      await expect(store.vectors(A, many)).rejects.toThrow(/^vectors: at most 1000 ids$/);
      await expect(store.vectors(A, many)).rejects.toBeInstanceOf(RangeError);
    });
  });
}
