import { flowContentHash } from "@loom/core";
import { describe, expect, it } from "vitest";
import { suggestTagsFlow } from "./flow";

describe("the suggest-tags flow identity", () => {
  /**
   * Loom's flow hash covers the flow id and version, the ordered steps (id, tool id, timeout, retry) and the deadline, and nothing
   * else: no execution id, no input, no handler (packages/core/src/flowHash.ts at Loom 4af27eaa; DocMind sets no codeFingerprint).
   * The opaque execution ids (R14) therefore change no hash and no version. This literal is the hash on main before the change,
   * computed with `flowContentHash`.
   */
  it("is unchanged by the opaque execution ids", () => {
    expect(suggestTagsFlow.definition.version).toBe("1.0.0");
    expect(flowContentHash(suggestTagsFlow.definition)).toBe(
      "sha256:3d99db0fdaf88f4bbeb69d371610811f5fcf57d208ff31494e2235d81490189b",
    );
  });
});
