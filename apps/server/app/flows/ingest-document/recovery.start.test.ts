import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startRecovery } from "./recovery";
import { boot, keptLog } from "./recoveryHarness";
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
});
