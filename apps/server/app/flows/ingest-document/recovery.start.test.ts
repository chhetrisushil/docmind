import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestExecutionId } from "../../documents/ingest";
import { FULL_SCAN_EVERY, startRecovery } from "./recovery";
import { boot, hanging, input, keptLog, start } from "./recoveryHarness";
import { fakeIngestDeps } from "./testing";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("startRecovery", () => {
  it("runs the boot pass at once and a pass per interval, and stop ends the interval", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => []);
    const source = { listExecutions: run } as never;
    const log = keptLog();
    const app = boot(log, fakeIngestDeps());
    const recovery = startRecovery(app.runtime, source, { intervalMs: 1000 });
    await recovery.idle();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await recovery.idle();
    expect(run).toHaveBeenCalledTimes(2);
    recovery.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("logs a failing pass by class only and does not throw", async () => {
    class StoreDownError extends Error {}
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = boot(keptLog(), fakeIngestDeps());
    const recovery = startRecovery(app.runtime, {
      listExecutions: async () => {
        throw new StoreDownError(`postgres://user:secret@host/${randomUUID()}`);
      },
    } as never);
    await recovery.idle();
    recovery.stop();
    expect(errors).toHaveBeenCalledWith("ingest recovery failed", "StoreDownError");
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/secret|postgres/);
  });

  it("the boot pass has no grace: an execution interrupted a moment ago is recovered at once, a periodic pass would wait", async () => {
    const log = keptLog();
    const ids = input();
    const first = hanging();
    await start(boot(log, first.deps), ids);
    await first.inStep;
    const app = boot(log, fakeIngestDeps());
    const recovery = startRecovery(app.runtime, log.kept, { intervalMs: 3_600_000 });
    await recovery.idle();
    recovery.stop();
    const state = await app.runtime.loadState(ingestExecutionId(ids.userId, ids.documentId), {
      principal: { tenant: ids.tenantId, actor: ids.userId },
    });
    expect(state?.status).toBe("completed");
  });

  it("periodic passes scan expired leases, not the whole log; only the boot pass scans the log", async () => {
    vi.useFakeTimers();
    const listed = vi.fn(async () => []);
    const expired = vi.fn(async () => []);
    const leases = { store: { expired } as never, owner: "node-1" };
    const recovery = startRecovery(
      boot(keptLog(), fakeIngestDeps()).runtime,
      { listExecutions: listed } as never,
      { intervalMs: 1000, leases },
    );
    await recovery.idle();
    expect([listed.mock.calls.length, expired.mock.calls.length]).toEqual([1, 0]);
    await vi.advanceTimersByTimeAsync(1000);
    await recovery.idle();
    expect([listed.mock.calls.length, expired.mock.calls.length]).toEqual([1, 1]);
    recovery.stop();
  });

  it("every FULL_SCAN_EVERY-th periodic pass scans the whole log, the others the expired leases", async () => {
    vi.useFakeTimers();
    const listed = vi.fn(async () => []);
    const expired = vi.fn(async () => []);
    const leases = { store: { expired } as never, owner: "node-1" };
    const app = boot(keptLog(), fakeIngestDeps());
    const recovery = startRecovery(app.runtime, { listExecutions: listed } as never, {
      intervalMs: 1000,
      leases,
    });
    await recovery.idle(); // the boot pass: a full scan
    for (let tick = 1; tick <= FULL_SCAN_EVERY; tick++) {
      await vi.advanceTimersByTimeAsync(1000);
      await recovery.idle();
    }
    recovery.stop();
    // boot + the FULL_SCAN_EVERY-th periodic pass scanned the log; the other FULL_SCAN_EVERY - 1 read leases
    expect([listed.mock.calls.length, expired.mock.calls.length]).toEqual([2, FULL_SCAN_EVERY - 1]);
  });
});
