import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { POOL_END_MS } from "./closeSequence";
import {
  FORCE_EXIT_DEADLINE_MS,
  SHUTDOWN_DRAIN_MS,
  drainWithin,
  loadShutdownDeadlineMs,
  runAll,
  scheduleForceExit,
  shutdown,
} from "./shutdown";

describe("shutdown", () => {
  it("lets the in-flight request finish before it closes the app", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    let arrived: () => void = () => undefined;
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const server = createServer((_req, res) => {
      arrived();
      release = () => {
        order.push("response sent");
        res.end("done");
      };
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const inFlight = fetch(url).then((r) => r.text());
    await requestArrived;
    const closing = shutdown(server, {
      close: async () => {
        order.push("app closed");
      },
    });
    // Yield a macrotask: a shutdown that skipped waiting for close() would have closed the app by now.
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([]);
    release();

    expect(await inFlight).toBe("done");
    await closing;
    expect(order).toEqual(["response sent", "app closed"]);
  });

  it("still closes the app when the server fails to close, and rethrows that error", async () => {
    const server = createServer(); // never listened: close() reports ERR_SERVER_NOT_RUNNING
    let closed = false;
    await expect(
      shutdown(server, {
        close: async () => {
          closed = true;
        },
      }),
    ).rejects.toMatchObject({ code: "ERR_SERVER_NOT_RUNNING" });
    expect(closed).toBe(true);
  });
});

describe("drainWithin", () => {
  it("returns at the deadline when the work never settles", async () => {
    await expect(drainWithin(new Promise(() => undefined), 5)).resolves.toBeUndefined();
  });
  it("returns when the work settles, even by rejecting", async () => {
    await expect(drainWithin(Promise.reject(new Error("x")), 60_000)).resolves.toBeUndefined();
  });
});

describe("runAll", () => {
  it("runs every step after a failure and rethrows the first error", async () => {
    const ran: string[] = [];
    await expect(
      runAll(
        async () => {
          ran.push("a");
          throw new RangeError("first");
        },
        async () => {
          ran.push("b");
          throw new TypeError("second");
        },
        async () => {
          ran.push("c");
        },
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(ran).toEqual(["a", "b", "c"]);
  });
});

describe("scheduleForceExit", () => {
  it("exits with the process's exit code after the delay, and its timer is unref'd", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      scheduleForceExit(exit, () => 1, 100);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(exit).toHaveBeenCalledWith(1);
      scheduleForceExit(exit, () => undefined, 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(exit).toHaveBeenLastCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not keep a clean process alive", () => {
    const unref = vi.spyOn(globalThis, "setTimeout");
    scheduleForceExit(
      () => {},
      () => 0,
      60_000,
    );
    const timer = unref.mock.results.at(-1)?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    clearTimeout(timer);
    unref.mockRestore();
  });
});

describe("the shutdown deadline", () => {
  it("exceeds the sum of the bounded close steps, so it bounds the drain and not the closing", () => {
    expect(FORCE_EXIT_DEADLINE_MS).toBeGreaterThan(2 * SHUTDOWN_DRAIN_MS + 2 * POOL_END_MS);
  });

  it("exits with code 1 once the deadline passes, and not before", () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      scheduleForceExit(exit, () => 1, FORCE_EXIT_DEADLINE_MS);
      vi.advanceTimersByTime(FORCE_EXIT_DEADLINE_MS - 1);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit.mock.calls).toEqual([[1]]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("loadShutdownDeadlineMs", () => {
  it("defaults to the 60 s deadline", () => {
    expect(loadShutdownDeadlineMs({})).toBe(FORCE_EXIT_DEADLINE_MS);
  });

  it("reads DOCMIND_SHUTDOWN_DEADLINE_MS", () => {
    expect(loadShutdownDeadlineMs({ DOCMIND_SHUTDOWN_DEADLINE_MS: "90000" })).toBe(90_000);
  });

  it("names the variable on a bad value, never the value", () => {
    for (const bad of ["0", "-5", "soon", "1.5", "3600001"]) {
      expect(() => loadShutdownDeadlineMs({ DOCMIND_SHUTDOWN_DEADLINE_MS: bad })).toThrow(
        /^DOCMIND_SHUTDOWN_DEADLINE_MS must be/,
      );
    }
  });
});
