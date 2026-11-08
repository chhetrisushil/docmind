import { describe, expect, it, vi } from "vitest";
import { lineageGcDeps } from "./pgLineageGc";

describe("lineageGcDeps", () => {
  it("keeps every version and reads two artifacts at a time", () => {
    const pins = vi.fn(async function* () {});
    const deps = lineageGcDeps(
      { lineage: { pins } as never, store: {} as never },
      {} as never,
      {} as never,
      86_400_000,
    );
    void deps.pins();
    // keepLast Infinity: the collector reclaims blobs nothing names, never history (the default keeps 20).
    // concurrency 2: a run must not hold most of the 10-connection app pool while it unseals artifacts.
    expect(pins).toHaveBeenCalledWith({ keepLast: Number.POSITIVE_INFINITY }, { concurrency: 2 });
    expect(deps.schedule).toMatchObject({ name: "lineage-gc", everyMs: 86_400_000 });
  });
});
