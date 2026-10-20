import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { MIN_PGVECTOR, PgChunkVectorStore, atLeast } from "./pg";
import { VectorSchemaError, VectorVersionError } from "./types";

describe("atLeast", () => {
  it("compares versions number by number, not as text", () => {
    for (const ok of ["0.8.0", "0.8.1", "0.10.0", "0.9.3", "1.0.0", "0.8.0-rc1"]) {
      expect(atLeast(ok, MIN_PGVECTOR)).toBe(true);
    }
    for (const old of ["0.7.4", "0.7.99", "0.0.9", "garbage", ""]) {
      expect(atLeast(old, MIN_PGVECTOR)).toBe(false);
    }
  });
});

/** A tenant transaction that answers the two boot queries, and nothing else. */
const storeWith = (column: string, version: string | undefined, dimensions = 768) =>
  new PgChunkVectorStore({
    modelId: "m",
    dimensions,
    tenant: async (_t, fn) =>
      fn({
        query: async (sql: string) => ({
          rows: sql.includes("pg_attribute")
            ? [{ t: column }]
            : version === undefined
              ? []
              : [{ v: version }],
        }),
      } as unknown as PoolClient),
  });

describe("PgChunkVectorStore.verify", () => {
  it("accepts the right column and pgvector 0.8.0 or newer", async () => {
    await expect(storeWith("vector(768)", "0.8.0").verify("t")).resolves.toBeUndefined();
    await expect(storeWith("vector(768)", "0.10.1").verify("t")).resolves.toBeUndefined();
  });

  it("refuses an older pgvector with VectorVersionError and a fixed message", async () => {
    const err = await storeWith("vector(768)", "0.7.4")
      .verify("t")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VectorVersionError);
    expect((err as Error).message).toBe("pgvector 0.8.0 or newer is required");
    await expect(storeWith("vector(768)", undefined).verify("t")).rejects.toBeInstanceOf(
      VectorVersionError,
    );
  });

  it("reports the column before the version", async () => {
    await expect(storeWith("vector(8)", "0.7.4").verify("t")).rejects.toBeInstanceOf(
      VectorSchemaError,
    );
  });
});
