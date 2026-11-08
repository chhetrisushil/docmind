import { describe, expect, it } from "vitest";
import { IngestGate } from "../ingest-document/gate";
import { newVisualizeGate } from "./deps";

describe("the visualize gate", () => {
  it("is separate from ingest's: an ingest step runs while a visualize step holds its tenant's only slot", async () => {
    const ingest = new IngestGate({ concurrency: 1, tenantConcurrency: 1 });
    const visualize = newVisualizeGate();
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered = () => {};
    const inside = new Promise<void>((r) => {
      entered = r;
    });
    const visual = visualize.run("t", undefined, async () => {
      entered();
      await held;
    });
    await inside;
    expect(visualize.active).toBe(1);
    // A second visualize step of the same tenant queues; the tenant's ingest step does not.
    const second = visualize.run("t", undefined, async () => {});
    expect(visualize.waiting).toBe(1);
    expect(await ingest.run("t", undefined, async () => "ingested")).toBe("ingested");
    release();
    await Promise.all([visual, second]);
  });
});
