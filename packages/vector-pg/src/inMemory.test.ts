import { describe, expect, it } from "vitest";
import { InMemoryChunkVectors, VectorDimensionError } from "./index";

const SCOPE = { tenantId: "t1", ownerId: "u1" };
const OTHER = { tenantId: "t1", ownerId: "u2" };
const ids = ["c0", "c1", "c2"];
// The stand-in chunks table: only u1 owns document d.
const owned = async (s: { ownerId: string }, d: string) =>
  s.ownerId === "u1" && d === "d" ? ids : [];
const twin = (over = {}) =>
  new InMemoryChunkVectors({ modelId: "m", dimensions: 3, chunkIds: owned, ...over });

describe("InMemoryChunkVectors", () => {
  it("lists the chunks without a vector in ordinal order, limited, and shrinks as vectors arrive", async () => {
    const s = twin();
    expect(await s.missing(SCOPE, "d", 2)).toEqual(["c0", "c1"]);
    expect(await s.upsert(SCOPE, "d", [{ chunkId: "c0", vector: [1, 0, 0] }])).toEqual({
      written: 1,
      missing: [],
    });
    expect(await s.missing(SCOPE, "d", 10)).toEqual(["c1", "c2"]);
  });

  it("reports ids with no chunk row as missing and writes nothing for them", async () => {
    const s = twin();
    expect(
      await s.upsert(SCOPE, "d", [
        { chunkId: "ghost", vector: [1, 0, 0] },
        { chunkId: "c1", vector: [0, 1, 0] },
      ]),
    ).toEqual({ written: 1, missing: ["ghost"] });
    expect((await s.search(SCOPE, [1, 1, 0], 5)).map((h) => h.chunkId)).toEqual(["c1"]);
  });

  it("refuses a wrong-size or non-finite vector with VectorDimensionError and writes nothing", async () => {
    const s = twin();
    await expect(s.upsert(SCOPE, "d", [{ chunkId: "c0", vector: [1, 0] }])).rejects.toBeInstanceOf(
      VectorDimensionError,
    );
    await expect(
      s.upsert(SCOPE, "d", [
        { chunkId: "c1", vector: [1, 0, 0] },
        { chunkId: "c0", vector: [1, Number.POSITIVE_INFINITY, 0] },
      ]),
    ).rejects.toThrow(/vector has the wrong size or a non-finite value/);
    expect(await s.missing(SCOPE, "d", 10)).toEqual(ids);
    await expect(s.search(SCOPE, [Number.NaN, 0, 0], 1)).rejects.toBeInstanceOf(
      VectorDimensionError,
    );
  });

  it("writes a repeated id once, last vector wins", async () => {
    const s = twin();
    expect(
      await s.upsert(SCOPE, "d", [
        { chunkId: "c0", vector: [0, 1, 0] },
        { chunkId: "c0", vector: [1, 0, 0] },
        { chunkId: "ghost", vector: [1, 0, 0] },
        { chunkId: "ghost", vector: [1, 0, 0] },
      ]),
    ).toEqual({ written: 1, missing: ["ghost"] });
    expect(await s.search(SCOPE, [1, 0, 0], 5)).toEqual([{ chunkId: "c0", score: 1 }]);
  });

  it("ranks by cosine similarity and applies the floor", async () => {
    const s = twin();
    await s.upsert(SCOPE, "d", [
      { chunkId: "c0", vector: [1, 0, 0] },
      { chunkId: "c1", vector: [0.9, 0.1, 0] },
      { chunkId: "c2", vector: [0, 1, 0] },
    ]);
    expect((await s.search(SCOPE, [1, 0, 0], 3)).map((h) => h.chunkId)).toEqual(["c0", "c1", "c2"]);
    expect((await s.search(SCOPE, [1, 0, 0], 3, 0.5)).map((h) => h.chunkId)).toEqual(["c0", "c1"]);
    expect(await s.search(SCOPE, [1, 0, 0], 1)).toHaveLength(1);
  });

  it("hides another owner's chunks from upsert, missing and search, and never writes them", async () => {
    const s = twin();
    expect(await s.upsert(OTHER, "d", [{ chunkId: "c0", vector: [1, 0, 0] }])).toEqual({
      written: 0,
      missing: ["c0"],
    });
    expect(await s.missing(OTHER, "d", 10)).toEqual([]);
    expect(await s.missing(SCOPE, "d", 10)).toEqual(ids);
    await s.upsert(SCOPE, "d", [{ chunkId: "c0", vector: [1, 0, 0] }]);
    expect(await s.search(OTHER, [1, 0, 0], 5)).toEqual([]);
    expect(await s.search({ tenantId: "t2", ownerId: "u1" }, [1, 0, 0], 5)).toEqual([]);
    expect((await s.search(SCOPE, [1, 0, 0], 5)).map((h) => h.chunkId)).toEqual(["c0"]);
  });

  it("treats a row embedded by another model as missing and does not search it", async () => {
    const shared = new Map();
    const old = twin({ modelId: "old", shared });
    const next = twin({ modelId: "new", shared });
    await old.upsert(SCOPE, "d", [{ chunkId: "c0", vector: [1, 0, 0] }]);
    expect(await next.missing(SCOPE, "d", 10)).toEqual(ids);
    expect(await next.search(SCOPE, [1, 0, 0], 5)).toEqual([]);
    await next.upsert(SCOPE, "d", [{ chunkId: "c0", vector: [0, 1, 0] }]);
    expect(await next.missing(SCOPE, "d", 10)).toEqual(["c1", "c2"]);
    expect(await old.missing(SCOPE, "d", 10)).toEqual(ids);
  });
});
