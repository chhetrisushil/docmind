import { flowContentHash } from "@loom/core";
import { describe, expect, it } from "vitest";
import { chatTitleFlow } from "./flow";

describe("the chat-title flow identity", () => {
  /**
   * Loom's flow hash reads no execution id (packages/core/src/flowHash.ts at Loom 4af27eaa), so the opaque execution ids (R14) change
   * no hash and no version. This literal is the hash on main before the change, computed with `flowContentHash`.
   */
  it("is unchanged by the opaque execution ids", () => {
    expect(chatTitleFlow.definition.version).toBe("1.0.0");
    expect(flowContentHash(chatTitleFlow.definition)).toBe(
      "sha256:f56568832761a1d68e89a5daf6b8edcf299eeadce26c916438f5f83a2cfa2007",
    );
  });
});
