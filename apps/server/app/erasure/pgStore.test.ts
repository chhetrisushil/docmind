import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PgErasureStore } from "./pgStore";

describe("PgErasureStore page size", () => {
  const pool = {} as Pool;

  it("accepts the function's bounds, 1 and 1000", () => {
    expect(() => new PgErasureStore(pool, 1)).not.toThrow();
    expect(() => new PgErasureStore(pool, 1000)).not.toThrow();
    expect(() => new PgErasureStore(pool)).not.toThrow();
  });

  it.each([0, -1, 1001, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects %s with an error that names the variable",
    (bad) => {
      expect(() => new PgErasureStore(pool, bad)).toThrow(/pageSize/);
    },
  );
});
