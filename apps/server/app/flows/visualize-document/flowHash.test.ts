import { flowContentHash } from "@loom/core";
import { describe, expect, it } from "vitest";
import { visualizeDocumentFlow } from "./flow";

describe("the visualize-document flow identity", () => {
  /**
   * Loom's flow hash covers the flow id and version, the ordered steps (id, tool id, timeout, retry) and the deadline, and
   * nothing inside a step: not its prompt, its output schema or its code (packages/core/src/flowHash.ts at Loom 4af27eaa;
   * DocMind sets no codeFingerprint). The timeline and relations change only the extract step's prompt and what its effect
   * reads and writes, so the hash did not move and the flow stays 1.1.0 with no new legacy definition. This literal is the
   * 1.1.0 hash on main before the change (computed with `flowContentHash`; the same method reproduces the 1.0.0 pin in
   * `flow.test.ts`). If you edit the step list, the ids, a retry policy or the version, this fails and you must follow the
   * 1.0.0 to 1.1.0 treatment (a new version, the old one kept registered, a resume test, a rollback note).
   */
  it("is unchanged by the timeline and relations extraction", () => {
    const flow = visualizeDocumentFlow();
    expect(flow.definition.version).toBe("1.1.0");
    expect(flow.definition.steps.map((s) => s.id)).toEqual([
      "visualize-extract",
      "visualize-structure",
      "visualize-load",
      "visualize-commit",
    ]);
    expect(flowContentHash(flow.definition)).toBe(
      "sha256:d3bfb104f3d015ab8165a9784f5f958bd46a347f3a2fb66f4d0d7be6c4e25f9e",
    );
  });
});
