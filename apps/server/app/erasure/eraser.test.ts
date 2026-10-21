import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ERASURE_CONCURRENCY,
  ERASURE_RESCAN_MS,
  ERASURE_STUCK_AFTER,
  Eraser,
  type ErasureDeps,
  ErasureParkedError,
  STEP_ORDER,
  abortableSleep,
  backoffMs,
} from "./eraser";
import { MemoryErasureStore } from "./testing";
import type { ErasureRequest, ErasureStep } from "./types";

const USER = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const CHAT = "44444444-4444-4444-8444-444444444444";
const EMAIL = "erase-me@example.com";

const request = (
  steps: ErasureStep[] = [],
  state: "pending" | "done" = "pending",
): ErasureRequest => ({
  userId: USER,
  tenantId: TENANT,
  state,
  steps,
  attempts: 0,
});

/**
 * The real in-memory store (Task 168), seeded with the given requests, plus what the unit tests also need:
 * every step ever marked (a done request reads `null` from `get`), and the retries counted.
 */
function memoryStore(initial: ErasureRequest[], erased: string[] = []) {
  const inner = new MemoryErasureStore();
  const marked = new Map<string, ErasureStep[]>();
  const retries = new Map<string, number>();
  const tx = { query: async () => undefined };
  const ready = (async () => {
    for (const [i, r] of initial.entries()) {
      await inner.insert(tx, r.userId, r.tenantId, Buffer.alloc(32, i + 1)); // a distinct receipt hash per request
      for (const step of r.steps) await inner.mark(r.userId, step);
    }
  })();
  return {
    marked,
    retries,
    get: async (userId: string) => {
      await ready;
      return inner.get(userId);
    },
    pending: async () => {
      await ready;
      return inner.pending();
    },
    async mark(userId: string, step: ErasureStep) {
      await ready;
      marked.set(userId, [...(marked.get(userId) ?? []), step]);
      return inner.mark(userId, step);
    },
    async retried(userId: string) {
      await ready;
      retries.set(userId, (retries.get(userId) ?? 0) + 1);
      return inner.retried(userId);
    },
    erased: async () => {
      await ready;
      return [...erased, ...(await inner.erased())];
    },
  };
}

interface Knobs {
  outcomes?: ("erased" | "parked" | "unknown")[];
  destroyed?: boolean;
  failOnce?: Partial<Record<string, number>>;
  lock?: boolean;
}

function fakeDeps(initial: ErasureRequest[], k: Knobs = {}, erased: string[] = []) {
  const calls: string[] = [];
  const lines: string[] = []; // what the fake `log` received: the stuck warnings
  const delays: number[] = [];
  const outcomes = [...(k.outcomes ?? ["erased"])];
  const failOnce = { ...(k.failOnce ?? {}) };
  const store = memoryStore(initial, erased);
  const note = (c: string) => calls.push(c);
  const maybeFail = (name: string) => {
    if ((failOnce[name] ?? 0) > 0) {
      failOnce[name] = (failOnce[name] ?? 0) - 1;
      throw new TypeError(`boom ${EMAIL}`); // a message with an email: the log must carry the class only
    }
  };
  const deps: ErasureDeps = {
    store,
    lock: async () => {
      if (k.lock === false) return null;
      note("lock");
      return async () => void note("unlock");
    },
    work: async () => {
      note("work");
      return { documents: [{ id: DOC, generation: 2 }], chatIds: [CHAT] };
    },
    closeStreams: (u) => void note(`closeStreams:${u === USER}`),
    settleStart: async (_i, d) => void note(`settleStart:${d === DOC}`),
    settleTitles: async () => void note("settleTitles"),
    cancelIngest: async (_i, d, g) => void note(`cancelIngest:${d === DOC}:${g}`),
    stopChat: async (_i, c) => void note(`stopChat:${c === CHAT}`),
    cancelTitle: async (_i, c) => void note(`cancelTitle:${c === CHAT}`),
    eraseSubject: async () => {
      note("eraseSubject");
      maybeFail("eraseSubject");
      return {
        outcome: outcomes.length > 1 ? (outcomes.shift() as "parked") : (outcomes[0] ?? "erased"),
      };
    },
    keys: {
      destroy: async () => void note("keys.destroy"),
      wasDestroyed: async () => k.destroyed ?? true,
    },
    forgetStatus: async () => void note("forgetStatus"),
    forgetActivity: async () => void note("forgetActivity"),
    rows: async () => {
      note("rows");
      maybeFail("rows");
    },
    blobs: async () => void note("blobs"),
    log: (line) => void lines.push(line),
    // Records the wait and yields a macrotask, so a retry loop never starves the test's own timers.
    sleep: async (ms) => {
      delays.push(ms);
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  };
  return { deps, calls, delays, lines, store };
}

afterEach(() => vi.restoreAllMocks());

describe("Eraser", () => {
  it("runs the steps in order, records each, and ends with the request done", async () => {
    const { deps, calls, store } = fakeDeps([request()]);
    await new Eraser(deps).run(USER);
    expect(calls).toEqual([
      "lock",
      "closeStreams:true",
      "work",
      "settleStart:true",
      "cancelIngest:true:2",
      "stopChat:true",
      "cancelTitle:true",
      "settleTitles",
      "eraseSubject",
      "forgetStatus",
      "forgetActivity",
      "rows",
      "blobs",
      "keys.destroy",
      "blobs", // again after the key is gone: an upload that raced the erase
      "unlock",
    ]);
    expect(await store.get(USER)).toBeNull(); // done
    expect(store.marked.get(USER)).toEqual([...STEP_ORDER]);
  });

  it("resumes at the first unrecorded step", async () => {
    const { deps, calls } = fakeDeps([request(["stop", "shred"])]);
    await new Eraser(deps).run(USER);
    expect(calls[0]).toBe("lock");
    expect(calls[1]).toBe("forgetStatus");
    expect(calls).not.toContain("eraseSubject");
    expect(calls).not.toContain("closeStreams:true");
  });

  it("does nothing for a request that is done or unknown", async () => {
    const done = fakeDeps([request([...STEP_ORDER], "done")]);
    await new Eraser(done.deps).run(USER);
    expect(done.calls).toEqual(["lock", "unlock"]);
    const none = fakeDeps([]);
    await new Eraser(none.deps).run(USER);
    expect(none.calls).toEqual(["lock", "unlock"]);
  });

  it("retries a parked shred with growing waits and stops the work again before each retry", async () => {
    const { deps, calls, delays } = fakeDeps([request()], {
      outcomes: ["parked", "parked", "erased"],
    });
    await new Eraser(deps).run(USER);
    expect(delays).toEqual([1_000, 2_000]);
    expect(calls.filter((c) => c === "eraseSubject")).toHaveLength(3);
    expect(calls.filter((c) => c === "stopChat:true")).toHaveLength(3); // the stop step, then once per parked answer
    expect(calls.indexOf("forgetStatus")).toBeGreaterThan(calls.lastIndexOf("eraseSubject"));
  });

  it("accepts 'unknown' (the user owns no execution)", async () => {
    const { deps, store } = fakeDeps([request()], { outcomes: ["unknown"] });
    await new Eraser(deps).run(USER);
    expect(await store.get(USER)).toBeNull();
  });

  it("does not move past a shred whose key is still alive, and logs the class and attempt only", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, calls, delays, store } = fakeDeps([request()], { destroyed: false });
    const eraser = new Eraser(deps);
    const run = eraser.run(USER);
    await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(2));
    await eraser.stop();
    await run;
    expect(calls).not.toContain("forgetStatus");
    expect((await store.get(USER))?.steps).toEqual(["stop"]);
    expect(errors).toHaveBeenCalledWith("erasure step failed", "shred", "KeyNotDestroyedError", 1);
    expect(errors).toHaveBeenCalledWith("erasure step failed", "shred", "KeyNotDestroyedError", 2);
  });

  it("logs the error class, never the message", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, store } = fakeDeps([request()], { failOnce: { rows: 1 } });
    await new Eraser(deps).run(USER);
    expect(store.retries.get(USER)).toBe(1); // the attempt is counted on the durable request
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain(USER);
    expect(errors).toHaveBeenCalledWith("erasure step failed", "rows", "TypeError", 1);
  });

  it("retries a failed step before any later step runs", async () => {
    const { deps, calls } = fakeDeps([request()], { failOnce: { rows: 2 } });
    await new Eraser(deps).run(USER);
    const afterShred = calls
      .slice(calls.indexOf("forgetActivity") + 1)
      .filter((c) => c !== "lock" && c !== "unlock"); // each retry gives the lock back and takes it again
    expect(afterShred.slice(0, 4)).toEqual(["rows", "rows", "rows", "blobs"]);
  });

  it("warns once when a step has failed ERASURE_STUCK_AFTER times, then every ERASURE_STUCK_AFTER further attempts, not on each", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(ERASURE_STUCK_AFTER).toBe(10);
    const { deps, lines, store } = fakeDeps([request()], { failOnce: { rows: 25 } });
    await new Eraser(deps).run(USER);
    expect(store.retries.get(USER)).toBe(25); // 25 failed attempts, then the 26th succeeded
    expect(lines).toEqual([
      "erasure stuck rows TypeError attempts=10",
      "erasure stuck rows TypeError attempts=20",
    ]);
  });

  it("stays quiet below the threshold, counts each step on its own, and never names an id, an email or a message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const quiet = fakeDeps([request()], { failOnce: { eraseSubject: 9, rows: 9 } });
    await new Eraser(quiet.deps).run(USER);
    expect(quiet.lines).toEqual([]); // 9 + 9 failures, but never 10 of one step
    const { deps, lines } = fakeDeps([request()], { failOnce: { rows: 10 } });
    await new Eraser(deps).run(USER);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^erasure stuck rows TypeError attempts=10$/);
    for (const secret of [USER, TENANT, DOC, CHAT, EMAIL])
      expect(lines.join("\n")).not.toContain(secret);
  });

  it("warns for a shred that stays parked, with the class of the parked error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, lines } = fakeDeps([request()], {
      outcomes: [...Array(10).fill("parked"), "erased"],
    });
    await new Eraser(deps).run(USER);
    expect(lines).toEqual(["erasure stuck shred ErasureParkedError attempts=10"]);
  });

  it("is single-flight per user", async () => {
    const { deps, calls } = fakeDeps([request()]);
    const eraser = new Eraser(deps);
    const a = eraser.run(USER);
    const b = eraser.run(USER);
    expect(b).toBe(a);
    await a;
    expect(calls.filter((c) => c === "eraseSubject")).toHaveLength(1);
    expect(calls.filter((c) => c === "lock")).toHaveLength(1);
  });

  it("does nothing when another process holds the user's lock", async () => {
    const { deps, calls } = fakeDeps([request()], { lock: false });
    await new Eraser(deps).run(USER);
    expect(calls).toEqual([]);
  });

  describe("stop, concurrency, re-scan (fake timers)", () => {
    afterEach(() => vi.useRealTimers());
    const flush = async () => {
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
    };

    it("stop() ends a backoff wait at once, without time passing, re-enqueues nothing, and the lock is already released", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { deps, calls, store } = fakeDeps([request()], { outcomes: ["parked"] });
      const eraser = new Eraser({ ...deps, sleep: abortableSleep });
      const run = eraser.run(USER);
      await flush();
      expect(calls).toContain("eraseSubject"); // now waiting out a 1 s backoff
      expect(calls.at(-1)).toBe("unlock"); // the backoff holds neither the lock nor a slot
      await eraser.stop(); // no timer is advanced: an ignored abort would hang here
      await run;
      expect(calls.filter((c) => c === "lock")).toHaveLength(1); // the stop cancelled the re-enqueue
      expect(calls.at(-1)).toBe("unlock");
      expect((await store.get(USER))?.state).toBe("pending");
    });

    it("stop() abandons a step in flight after the bounded drain, and releases the lock when it settles", async () => {
      vi.useFakeTimers();
      const { deps, calls, store } = fakeDeps([request()]);
      let finish: () => void = () => {};
      deps.settleTitles = () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        });
      const eraser = new Eraser(deps);
      const run = eraser.run(USER);
      await flush();
      const stopped = eraser.stop();
      await vi.advanceTimersByTimeAsync(10_000); // SHUTDOWN_DRAIN_MS
      await stopped; // gave up on the running step
      expect(calls).not.toContain("unlock");
      finish();
      await run;
      expect(calls.at(-1)).toBe("unlock");
      expect(calls).not.toContain("eraseSubject"); // no new step after stop
      expect((await store.get(USER))?.steps).toEqual(["stop"]);
    });

    it("a run in backoff holds neither the lock nor a slot: two failing users do not block a third", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const a = "aaaaaaaa-0000-4000-8000-000000000000";
      const b = "bbbbbbbb-0000-4000-8000-000000000000";
      const c = "cccccccc-0000-4000-8000-000000000000";
      const { deps, store, lines } = fakeDeps(
        [a, b, c].map((userId) => ({ ...request(), userId })),
      );
      let held = 0;
      deps.lock = async () => {
        held += 1;
        return async () => {
          held -= 1;
        };
      };
      let failing = true;
      deps.rows = async (req) => {
        if (failing && req.userId !== c) throw new TypeError("boom");
      };
      deps.sleep = (ms, signal) => abortableSleep(ms, signal);
      const eraser = new Eraser(deps);
      await eraser.resumeAll();
      await vi.advanceTimersByTimeAsync(1); // a and b took both slots and failed; c ran in a slot they gave back
      await flush();
      expect(await store.get(c)).toBeNull(); // c completed while a and b are still backing off
      expect(held).toBe(0); // nobody holds a lock during a backoff
      // The attempt count and the stuck cadence continue across the re-enqueues (1 s, 2 s, 4 s ... then 60 s).
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(lines.filter((l) => l.includes("attempts=10"))).toHaveLength(2);
      failing = false;
      await vi.advanceTimersByTimeAsync(60_000);
      await eraser.idle();
      expect(await store.get(a)).toBeNull();
      expect(await store.get(b)).toBeNull();
    });

    it("never runs more than ERASURE_CONCURRENCY erasures, nor holds more lock connections, at once", async () => {
      expect(ERASURE_CONCURRENCY).toBe(2);
      const users = Array.from(
        { length: 10 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
      const { deps, store } = fakeDeps(users.map((userId) => ({ ...request(), userId })));
      let held = 0;
      let running = 0;
      let peakHeld = 0;
      let peakRunning = 0;
      let done = 0;
      deps.lock = async () => {
        held += 1;
        peakHeld = Math.max(peakHeld, held);
        return async () => {
          held -= 1;
        };
      };
      deps.eraseSubject = async () => {
        running += 1;
        peakRunning = Math.max(peakRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        done += 1;
        return { outcome: "erased" };
      };
      const eraser = new Eraser(deps);
      await eraser.resumeAll();
      await eraser.idle();
      expect(done).toBe(10);
      expect(peakRunning).toBe(2);
      expect(peakHeld).toBeLessThanOrEqual(2);
      for (const u of users) expect(await store.get(u)).toBeNull();
    });

    it("re-scans the pending requests every ERASURE_RESCAN_MS, and stop() ends the timer", async () => {
      vi.useFakeTimers();
      const holder = { free: false };
      const { deps, calls, store } = fakeDeps([request()]);
      const lock = deps.lock;
      deps.lock = async (u) => (holder.free ? lock(u) : null); // another node holds it
      const eraser = new Eraser(deps);
      await eraser.resumeAll();
      await eraser.idle();
      expect(calls).toEqual([]);
      eraser.startRescan();
      await vi.advanceTimersByTimeAsync(ERASURE_RESCAN_MS - 1);
      expect(calls).toEqual([]);
      holder.free = true; // the other node died
      await vi.advanceTimersByTimeAsync(1);
      await eraser.idle();
      expect(await store.get(USER)).toBeNull();
      // After stop() no pass runs.
      const pending = vi.spyOn(deps.store, "pending");
      await eraser.stop();
      await vi.advanceTimersByTimeAsync(ERASURE_RESCAN_MS * 3);
      expect(pending).not.toHaveBeenCalled();
    });

    it("stop() waits for a resumeAll pass in flight, and the pass forgets no further user", async () => {
      vi.useFakeTimers();
      const { deps } = fakeDeps([], {}, [
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
      ]);
      const forgotten: string[] = [];
      let release: () => void = () => {};
      deps.forgetStatus = async (u) => {
        forgotten.push(u);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      };
      const eraser = new Eraser(deps);
      void eraser.resumeAll();
      await flush();
      let stopped = false;
      const stop = eraser.stop().then(() => {
        stopped = true;
      });
      await flush();
      expect(stopped).toBe(false);
      release();
      await stop;
      expect(forgotten).toHaveLength(1);
    });

    it("a lock that cannot be taken follows the same cadence and produces the stuck line", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { deps, lines } = fakeDeps([request()]);
      const lock = deps.lock;
      let failures = 10;
      deps.lock = async (u) => {
        if (failures-- > 0) throw new RangeError(`pool timeout ${USER}`);
        return lock(u);
      };
      const errors = vi.spyOn(console, "error");
      await new Eraser(deps).run(USER);
      expect(lines).toEqual(["erasure stuck lock RangeError attempts=10"]);
      expect(errors.mock.calls.filter((c) => c[1] === "lock").map((c) => c[3])).toEqual([
        1, 2, 3, 10,
      ]);
      expect(JSON.stringify([...errors.mock.calls, lines])).not.toContain(USER);
    });
  });

  it("a lost lock sends the run back to acquire it again, and the interrupted step is not recorded", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, calls, store } = fakeDeps([request()]);
    const lock = deps.lock;
    const first = new AbortController();
    let taken = 0;
    deps.lock = async (u) => {
      const release = await lock(u);
      if (!release) return release;
      taken += 1;
      if (taken === 1) Object.assign(release, { lost: first.signal });
      return release;
    };
    let rowsCalls = 0;
    deps.rows = async () => {
      calls.push("rows");
      if (rowsCalls++ === 0) first.abort(); // the connection dropped while the step ran
    };
    await new Eraser(deps).run(USER);
    expect(taken).toBe(2);
    expect(calls.filter((c) => c === "rows")).toHaveLength(2);
    expect(calls.filter((c) => c === "unlock")).toHaveLength(2);
    expect(await store.get(USER)).toBeNull(); // finished under the second lock
    expect(errors).toHaveBeenCalledWith("erasure step failed", "lock", "LockLostError", 1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(USER);
  });

  it("retries a store.get that fails, instead of abandoning the request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, store } = fakeDeps([request()]);
    const get = deps.store.get;
    let failures = 2;
    deps.store.get = async (u) => {
      if (failures-- > 0) throw new RangeError("db blip");
      return get(u);
    };
    await new Eraser(deps).run(USER);
    expect(await store.get(USER)).toBeNull(); // done
  });

  it("does not crash when the activity model cannot forget (it failed to boot): the erasure retries", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, store, delays } = fakeDeps([request()]);
    deps.forgetActivity = async () => {
      throw new Error(`activity model is not registered ${USER}`);
    };
    const eraser = new Eraser(deps);
    const run = eraser.run(USER);
    await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(3));
    await eraser.stop();
    await expect(run).resolves.toBeUndefined();
    expect((await store.get(USER))?.steps).toEqual(["stop", "shred"]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(USER);
  });

  it("resumeAll starts every pending request and leaves the done ones alone", async () => {
    const other = { ...request(), userId: "55555555-5555-4555-8555-555555555555" };
    const finished = {
      ...request([...STEP_ORDER], "done"),
      userId: "66666666-6666-4666-8666-666666666666",
    };
    const { deps, store } = fakeDeps([request(), other, finished]);
    const eraser = new Eraser(deps);
    await eraser.resumeAll();
    await eraser.idle();
    expect(await store.get(USER)).toBeNull();
    expect(await store.get(other.userId)).toBeNull();
    // The done request's steps are unchanged: nothing was marked or retried for it.
    expect(store.marked.get(finished.userId)).toBeUndefined();
    expect(store.retries.get(finished.userId)).toBeUndefined();
    expect(await store.erased()).toContain(finished.userId);
  });

  it("resumeAll survives a store that cannot list", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = fakeDeps([request()]);
    deps.store.pending = async () => {
      throw new RangeError("db down");
    };
    await expect(new Eraser(deps).resumeAll()).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith("erasure step failed", "resume", "RangeError", 1);
  });

  it("resumeAll re-forgets the read-model rows of every erasure that is done (a rebuild can re-create them as {})", async () => {
    const { deps, calls } = fakeDeps([], {}, ["77777777-7777-4777-8777-777777777777"]);
    const eraser = new Eraser(deps);
    await eraser.resumeAll();
    await eraser.idle();
    expect(calls).toEqual(["forgetStatus", "forgetActivity"]);
  });

  it("logs failed attempts 1, 2 and 3, then every 10th", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = fakeDeps([request()], { failOnce: { rows: 21 } });
    await new Eraser(deps).run(USER);
    const attempts = errors.mock.calls.filter((c) => c[1] === "rows").map((c) => c[3]);
    expect(attempts).toEqual([1, 2, 3, 10, 20]);
  });

  it("treats a fold failure as retryable and never lets its message reach the console", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    class FoldGapError extends Error {}
    let failures = 11;
    const { deps, store, lines } = fakeDeps([request()]);
    deps.forgetStatus = async () => {
      if (failures-- > 0) throw new FoldGapError(`gap for ${USER} ${TENANT} ${EMAIL}`);
    };
    await new Eraser(deps).run(USER);
    expect(await store.get(USER)).toBeNull(); // retried until it passed
    expect(lines).toEqual(["erasure stuck readModels FoldGapError attempts=10"]);
    const everything = JSON.stringify([...errors.mock.calls, ...warns.mock.calls, lines]);
    expect(everything).toContain("FoldGapError");
    for (const secret of [USER, TENANT, EMAIL, "gap for"]) expect(everything).not.toContain(secret);
  });

  it("resumeAll goes on to the next erased user when one forget fails, logging the class only", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = "88888888-8888-4888-8888-888888888888";
    const first = "77777777-7777-4777-8777-777777777777";
    const { deps } = fakeDeps([], {}, [first, second]);
    const forgotten: string[] = [];
    deps.forgetStatus = async (u) => {
      if (u === first) throw new RangeError(`no key for ${u}`);
      forgotten.push(u);
    };
    await new Eraser(deps).resumeAll();
    expect(forgotten).toEqual([second]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(first);
    expect(errors).toHaveBeenCalledWith("erasure step failed", "resume", "RangeError", 1);
  });

  it("backs off 1 s, 2 s, 4 s ... capped at 60 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 50].map(backoffMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });

  it("names a parked shred", () => {
    expect(new ErasureParkedError().name).toBe("ErasureParkedError");
  });
});
