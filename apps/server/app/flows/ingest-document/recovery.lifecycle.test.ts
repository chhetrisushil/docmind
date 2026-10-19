import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestExecutionId, loomIngest } from "../../documents/ingest";
import { foldIngestStatus } from "../../status/model";
import { DocumentGoneError } from "./errors";
import { type IngestStartInput, ingestDocumentFlow } from "./flow";
import { recoverIngest } from "./recovery";
import { boot, eventsOf, hanging, input, keptLog, start, types } from "./recoveryHarness";
import { fakeIngestDeps } from "./testing";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("recoverIngest: resuming executions", () => {
  it("never resurrects a deleted document's execution", async () => {
    const log = keptLog();
    const ids = input();
    const first = hanging();
    await start(boot(log, first.deps), ids);
    await first.inStep;
    const second = boot(log, fakeIngestDeps());
    await loomIngest(second.runtime).cancel(
      { tenantId: ids.tenantId, userId: ids.userId },
      ids.documentId,
    );
    expect(await recoverIngest(second.runtime, log.kept, { graceMs: 0 })).toMatchObject({
      recovered: 0,
      candidates: 0,
    });
    const all = await eventsOf(log, ids);
    expect(all.at(-1)).toMatchObject({ eventType: "EXECUTION_CANCELLED" });
    expect(foldIngestStatus(all).status).not.toBe("failed"); // a user's delete is not a failure
  });

  it("a document deleted by another process is document_gone when recovery re-runs the step", async () => {
    const log = keptLog();
    const ids = input();
    const first = hanging();
    await start(boot(log, first.deps), ids);
    await first.inStep;
    const gone = fakeIngestDeps({
      guard: {
        begin: async () => {
          throw new DocumentGoneError();
        },
      },
    });
    const app = boot(log, gone);
    expect(await recoverIngest(app.runtime, log.kept, { graceMs: 0 })).toMatchObject({
      recovered: 1,
    });
    const done = (await eventsOf(log, ids)).find((e) => e.eventType === "STEP_COMPLETED");
    expect(done?.payload).toMatchObject({ output: { outcome: "document_gone" } });
    expect(await types(log, ids)).not.toContain("EXECUTION_FAILED");
  });

  it("restores the original principal: the re-run step runs for the owner and tenant that started it", async () => {
    const log = keptLog();
    const ids = input();
    const first = hanging();
    await start(boot(log, first.deps), ids);
    await first.inStep;
    const seen: { ref: IngestStartInput; step: string }[] = [];
    const app = boot(
      log,
      fakeIngestDeps({ guard: { begin: async (ref, step) => void seen.push({ ref, step }) } }),
    );
    await recoverIngest(app.runtime, log.kept, { graceMs: 0 });
    expect(seen).toEqual([
      { ref: ids, step: "parse" },
      { ref: ids, step: "chunk" },
      { ref: ids, step: "embed" },
    ]); // the hung parse is re-run, then chunk and embed, all for the recorded principal
    const state = await app.runtime.loadState(ingestExecutionId(ids.userId, ids.documentId), {
      principal: { tenant: ids.tenantId, actor: ids.userId },
    });
    expect(state?.status).toBe("completed");
    // an intruder in the same tenant is still refused: recovery did not widen access
    await expect(
      app.runtime.loadState(ingestExecutionId(ids.userId, ids.documentId), {
        principal: { tenant: ids.tenantId, actor: randomUUID() },
      }),
    ).rejects.toMatchObject({ name: "ExecutionDeniedError" });
  });

  it("leaves an execution alone until its log has been quiet for the grace period", async () => {
    const log = keptLog();
    const ids = input();
    const first = hanging();
    await start(boot(log, first.deps), ids);
    await first.inStep;
    const [head] = (await eventsOf(log, ids)).slice(-1);
    const app = boot(log, fakeIngestDeps());
    const at = (ms: number) => ({ graceMs: 1000, now: () => (head?.timestamp ?? 0) + ms });
    expect(await recoverIngest(app.runtime, log.kept, at(999))).toMatchObject({
      candidates: 1,
      recovered: 0,
    });
    expect(await recoverIngest(app.runtime, log.kept, at(1000))).toMatchObject({ recovered: 1 });
  });

  it("leaves an execution that is not an ingest alone, even one recovery could re-drive", async () => {
    const log = keptLog();
    const ids = input();
    const first = hanging();
    const other = `u_${ids.userId}:chat-${ids.documentId}`;
    await boot(log, first.deps).runtime.start(ingestDocumentFlow, ids, {
      executionId: other,
      principal: { tenant: ids.tenantId, actor: ids.userId },
    });
    await first.inStep;
    const app = boot(log, fakeIngestDeps());
    expect(await recoverIngest(app.runtime, log.kept, { graceMs: 0 })).toMatchObject({
      candidates: 1,
      recovered: 0,
    });
    expect((await log.store.read(other)).map((e) => e.eventType)).not.toContain(
      "EXECUTION_RECOVERED",
    );
  });
});
