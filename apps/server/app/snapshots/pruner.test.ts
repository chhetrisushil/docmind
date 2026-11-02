import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLock } from "../db/sessionLock";
import { StartupConfigError } from "../startupError";
import {
  DEFAULT_SNAPSHOT_PRUNE_INTERVAL_MS,
  type SnapshotPruneDeps,
  loadSnapshotPruneIntervalMs,
  startSnapshotPruner,
  sweepChatSnapshots,
} from "./pruner";

const U = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const CHAT = `u_${U}.c-${C}`;
const CHAT_GEN2 = `${CHAT}~2`;
const INGEST = `u_${U}:ingest-33333333-3333-4333-8333-333333333333`;

function lockFake() {
  const release = vi.fn(async () => {}) as unknown as SessionLock & ReturnType<typeof vi.fn>;
  const lost = new AbortController();
  release.lost = lost.signal;
  return { release, lost };
}

function deps(ids: string[][], over: Partial<SnapshotPruneDeps> = {}) {
  const { release, lost } = lockFake();
  const pages = ids.map((executionIds, i) => ({
    executionIds,
    ...(i < ids.length - 1 && { nextCursor: `p${i + 1}` }),
  }));
  const d = {
    listExecutionsPage: vi.fn(async ({ cursor }: { cursor?: string }) => {
      const i = cursor === "u_" ? 0 : Number(String(cursor).slice(1));
      return pages[i] ?? { executionIds: [] };
    }),
    prune: vi.fn(async (_id: string) => 2),
    lock: vi.fn(async () => release),
    ...over,
  };
  return { d, release, lost };
}

describe("loadSnapshotPruneIntervalMs", () => {
  it("defaults to an hour and reads 0 as off", () => {
    expect(loadSnapshotPruneIntervalMs({})).toBe(DEFAULT_SNAPSHOT_PRUNE_INTERVAL_MS);
    expect(DEFAULT_SNAPSHOT_PRUNE_INTERVAL_MS).toBe(3_600_000);
    expect(loadSnapshotPruneIntervalMs({ DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS: " 0 " })).toBe(0);
    expect(loadSnapshotPruneIntervalMs({ DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS: "60000" })).toBe(
      60_000,
    );
    expect(loadSnapshotPruneIntervalMs({ DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS: "604800000" })).toBe(
      604_800_000,
    );
  });

  it.each(["-1", "1.5", "abc", "59999", "604800001", "1e6"])(
    "fails the boot on %s, naming the variable only",
    (value) => {
      const load = () => loadSnapshotPruneIntervalMs({ DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS: value });
      expect(load).toThrow(StartupConfigError);
      expect(load).toThrow(/DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS/);
      expect(() => load()).not.toThrow(new RegExp(`\\b${value.replace(/[.]/g, "\\.")}\\b`));
    },
  );
});

describe("sweepChatSnapshots", () => {
  it("prunes every chat conversation (every generation) and nothing else, from the u_ range only", async () => {
    const { d, release } = deps([
      [CHAT, INGEST],
      [CHAT_GEN2, "v_after-the-user-range", `u_${U}.c-late`],
    ]);
    const report = await sweepChatSnapshots(d);
    expect(d.listExecutionsPage).toHaveBeenNthCalledWith(1, { cursor: "u_", limit: 500 });
    expect(vi.mocked(d.prune).mock.calls.map(([id]) => id)).toEqual([CHAT, CHAT_GEN2]);
    expect(report).toEqual({
      executions: 2,
      deleted: 4,
      failed: 0,
      failedByClass: {},
      skipped: false,
      stopped: false,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("does nothing when another replica holds the lock", async () => {
    const { d } = deps([[CHAT]], { lock: vi.fn(async () => null) });
    const report = await sweepChatSnapshots(d);
    expect(report.skipped).toBe(true);
    expect(d.listExecutionsPage).not.toHaveBeenCalled();
    expect(d.prune).not.toHaveBeenCalled();
  });

  it("counts failures by class, logs nothing per execution, and carries on", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const prune = vi
      .fn()
      .mockRejectedValueOnce(new RangeError(`secret ${CHAT}`))
      .mockRejectedValueOnce(new RangeError(`secret ${CHAT_GEN2}`))
      .mockResolvedValueOnce(3);
    const { d, release } = deps([[CHAT, CHAT_GEN2, `${CHAT}~3`]], { prune });
    const report = await sweepChatSnapshots(d);
    expect(report).toMatchObject({
      executions: 3,
      deleted: 3,
      failed: 2,
      failedByClass: { RangeError: 2 },
    });
    expect(JSON.stringify(report)).not.toContain(U);
    expect(error).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("stops before the next execution once aborted or once the lock is lost, and still releases", async () => {
    const stop = new AbortController();
    const { d, release } = deps([[CHAT, CHAT_GEN2]], {
      prune: vi.fn(async () => {
        stop.abort();
        return 1;
      }),
    });
    expect(await sweepChatSnapshots(d, stop.signal)).toMatchObject({
      executions: 1,
      stopped: true,
    });
    expect(release).toHaveBeenCalledOnce();

    const second = deps([[CHAT, CHAT_GEN2]]);
    second.d.prune = vi.fn(async () => {
      second.lost.abort();
      return 1;
    });
    expect(await sweepChatSnapshots(second.d)).toMatchObject({ executions: 1, stopped: true });
  });

  it("releases the lock when the listing throws, and rethrows", async () => {
    const { d, release } = deps([], {
      listExecutionsPage: vi.fn(async () => {
        throw new TypeError("down");
      }),
    });
    await expect(sweepChatSnapshots(d)).rejects.toThrow(TypeError);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("startSnapshotPruner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sweeps one interval after start, not at start, and logs counts only", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { d } = deps([[CHAT]]);
    const pruner = startSnapshotPruner(d, 60_000);
    expect(d.lock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.prune).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      "snapshot prune",
      expect.objectContaining({ executions: 1, deleted: 2, failed: 0 }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(U);
    await pruner.stop();
    info.mockRestore();
  });

  it("logs a store-wide failure as one line carrying the class counts", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d } = deps([[CHAT, CHAT_GEN2]], {
      prune: vi.fn(async () => {
        throw new TypeError(`down ${CHAT}`);
      }),
    });
    const pruner = startSnapshotPruner(d, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      "snapshot prune",
      expect.objectContaining({ failed: 2, failedByClass: { TypeError: 2 } }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(U);
    await pruner.stop();
    info.mockRestore();
    error.mockRestore();
  });

  it("never overlaps sweeps", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let finish!: () => void;
    const { d } = deps([[CHAT]], {
      prune: vi.fn(
        () =>
          new Promise<number>((r) => {
            finish = () => r(1);
          }),
      ),
    });
    const pruner = startSnapshotPruner(d, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000); // a tick while the first sweep runs: skipped
    expect(d.lock).toHaveBeenCalledOnce();
    finish();
    await pruner.stop();
    info.mockRestore();
  });

  it("stop() waits for the sweep in progress and nothing runs afterwards", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let finish!: () => void;
    let done = false;
    const { d } = deps([[CHAT, CHAT_GEN2]], {
      prune: vi.fn(
        () =>
          new Promise<number>((r) => {
            finish = () => r(1);
          }),
      ),
    });
    const pruner = startSnapshotPruner(d, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    const stopped = pruner.stop().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    finish();
    await stopped;
    expect(d.prune).toHaveBeenCalledOnce(); // the abort stopped it before the second execution
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(d.lock).toHaveBeenCalledOnce();
    info.mockRestore();
  });

  it("logs a sweep that failed as a whole by class, and keeps the timer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d } = deps([], {
      listExecutionsPage: vi.fn(async () => {
        throw new TypeError(`down ${U}`);
      }),
    });
    const pruner = startSnapshotPruner(d, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).toHaveBeenCalledWith("snapshot prune failed", "TypeError");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.lock).toHaveBeenCalledTimes(2);
    await pruner.stop();
    error.mockRestore();
  });
});
