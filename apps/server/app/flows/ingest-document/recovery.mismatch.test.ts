import { flow$, step$ } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { foldIngestStatus } from "../../status/model";
import {
  type INGEST_STEPS,
  IngestOutput,
  IngestStartInput,
  ingestParseStep,
  runIngestSteps,
} from "./flow";
import { recoverIngest } from "./recovery";
import { boot, eventsOf, hanging, input, keptLog, start } from "./recoveryHarness";
import { fakeIngestDeps } from "./testing";

describe("recoverIngest: a flow whose identity changed", () => {
  it("an interruption across a flow-version change ends failed, not parsing", async () => {
    const log = keptLog();
    const ids = input();
    // The flow as an earlier deploy defined it: the same step with another retry policy (part of the flow hash).
    const oldStep = step$({ ...ingestParseStep, retry: { maxAttempts: 5 } });
    const oldSteps = [oldStep] as unknown as typeof INGEST_STEPS;
    const old = {
      runner: runIngestSteps(oldSteps) as never,
      definition: flow$({
        id: "ingest-document",
        name: "IngestDocument",
        version: "1.9.0",
        inputSchema: IngestStartInput,
        outputSchema: IngestOutput,
        steps: oldSteps,
      }),
    };
    const first = hanging();
    const before = boot(log, first.deps);
    before.runtime.registerFlow(old.definition, old.runner); // the deploy that is about to be replaced
    await start(before, ids, old);
    await first.inStep;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = await recoverIngest(boot(log, fakeIngestDeps()).runtime, log.kept, {
      graceMs: 0,
    });
    expect(summary).toMatchObject({ recovered: 0, failed: 1 });
    const all = await eventsOf(log, ids);
    expect(foldIngestStatus(all)).toMatchObject({ status: "failed", code: "internal" });
    expect(all.at(-1)).toMatchObject({ payload: { reason: "ingest-flow-mismatch" } });
    expect(errors).not.toHaveBeenCalled(); // a mismatch is expected, not an error
  });
});
