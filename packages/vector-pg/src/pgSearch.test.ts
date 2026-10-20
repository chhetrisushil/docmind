import { describe, expect, it } from "vitest";
import { PgChunkVectorStore, searchSql } from "./pg";

describe("searchSql", () => {
  it("orders the CTE by the bare distance operator and filters documents only when asked", () => {
    expect(searchSql(false)).toContain("ORDER BY c.embedding <=> $1::vector\n   LIMIT $4)");
    expect(searchSql(false)).not.toContain("$6");
    expect(searchSql(true)).toContain("c.document_id = ANY($6::uuid[])");
    expect(searchSql(true)).not.toContain("vector_norm"); // a filter on the distance or norm blocks the index
  });
});

describe("PgChunkVectorStore efSearch", () => {
  it("accepts 10 to 1000 and refuses anything else with a RangeError", () => {
    const make = (efSearch: number) =>
      new PgChunkVectorStore({
        modelId: "m",
        dimensions: 4,
        efSearch,
        tenant: async () => undefined as never,
      });
    expect(() => make(10)).not.toThrow();
    expect(() => make(1000)).not.toThrow();
    for (const bad of [9, 1001, 50.5, Number.NaN]) {
      expect(() => make(bad)).toThrow(
        /^PgChunkVectorStore: efSearch must be an integer from 10 to 1000$/,
      );
    }
  });
});
