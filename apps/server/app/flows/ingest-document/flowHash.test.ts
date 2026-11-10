import { flowContentHash } from "@loom/core";
import { describe, expect, it } from "vitest";
import { ingestDocumentFlow } from "./flow";

describe("the ingest-document flow identity", () => {
  /**
   * Loom's flow hash covers the flow id and version, the ordered steps (id, tool id, timeout, retry) and the deadline, and
   * nothing inside a step: not its prompt, its inputs' contents, its schemas or its code (packages/core/src/flowHash.ts;
   * DocMind sets no codeFingerprint). The tag suggestions change the summarize step's prompt and what its effect reads, so
   * the hash did not move and ingest stays 3.0.0 with no legacy definition. This literal is the hash on main before the
   * change: if you edit the step list, the ids, a retry policy or the version, this fails and you must follow the
   * visualize-document 1.0.0 to 1.1.0 treatment (a new version, the old one kept registered, a resume test, a rollback note).
   */
  it("is unchanged by the tag suggestions", () => {
    expect(ingestDocumentFlow.definition.version).toBe("3.0.0");
    expect(flowContentHash(ingestDocumentFlow.definition)).toBe(
      "sha256:e9c2819cd68e5b3d2bae57d5ef9e7d55af3067a99db66e225b00f0adfa864dc4",
    );
  });
});
