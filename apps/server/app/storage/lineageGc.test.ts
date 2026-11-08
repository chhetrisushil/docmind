import { InMemoryContentStore } from "@loom/plugin-content";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLock } from "../db/sessionLock";
import { StartupConfigError } from "../startupError";
import {
  DEFAULT_LINEAGE_GC_INTERVAL_MS,
  LINEAGE_GC_GRACE_MS,
  type LineageGcDeps,
  type MaintenanceRuns,
  collectLineageContent,
  loadLineageGcIntervalMs,
  startLineageGc,
} from "./lineageGc";

const DAY = 86_400_000;
const enc = (s: string) => new TextEncoder().encode(s);

function lockFake() {
  const release = vi.fn(async () => {}) as unknown as SessionLock & ReturnType<typeof vi.fn>;
  const lost = new AbortController();
  release.lost = lost.signal;
  return { release, lost };
}

/** A store on a clock the test moves: blobs written now are 3 days old after `advance(3 * DAY)`. */
function world() {
  let clock = 1_700_000_000_000; // a touch time of 0 means UNKNOWN to Loom and is never erased
  const store = new InMemoryContentStore({ now: () => clock });
  const lock = lockFake();
  const put = async (s: string) => (await store.put(enc(s))).__loomContent;
  const base = { store, lock: vi.fn(async () => lock.release) };
  return {
    store,
    lock,
    put,
    advance: (ms: number) => {
      clock += ms;
    },
    deps: (pins: LineageGcDeps["pins"], over: Partial<LineageGcDeps> = {}): LineageGcDeps => ({
      ...base,
      pins,
      now: () => clock,
      ...over,
    }),
    has: async (address: string) => (await store.get({ __loomContent: address })) !== null,
  };
}
/** The store as it is, minus one SPI method (a spread would drop the prototype's methods). */
const withoutMethod = (
  store: InMemoryContentStore,
  name: "touch" | "touchClock",
): LineageGcDeps["store"] =>
  new Proxy(store, {
    get: (t, k) => (k === name ? undefined : (Reflect.get(t, k).bind?.(t) ?? Reflect.get(t, k))),
  });
const yielding = (...a: string[]) =>
  async function* () {
    yield* a;
  };

describe("loadLineageGcIntervalMs", () => {
  it("defaults to a day and reads 0 as off", () => {
    expect(loadLineageGcIntervalMs({})).toBe(DEFAULT_LINEAGE_GC_INTERVAL_MS);
    expect(DEFAULT_LINEAGE_GC_INTERVAL_MS).toBe(86_400_000);
    expect(loadLineageGcIntervalMs({ DOCMIND_LINEAGE_GC_INTERVAL_MS: " 0 " })).toBe(0);
    expect(loadLineageGcIntervalMs({ DOCMIND_LINEAGE_GC_INTERVAL_MS: "60000" })).toBe(60_000);
  });
  it.each(["-1", "1.5", "abc", "59999", "2592000001", "1e6"])(
    "fails the boot on %s, naming the variable only",
    (value) => {
      const load = () => loadLineageGcIntervalMs({ DOCMIND_LINEAGE_GC_INTERVAL_MS: value });
      expect(load).toThrow(StartupConfigError);
      expect(load).toThrow("DOCMIND_LINEAGE_GC_INTERVAL_MS");
    },
  );
});

describe("collectLineageContent", () => {
  it("erases an old blob no root names and keeps the rooted one and a young one", async () => {
    const w = world();
    const kept = await w.put("kept");
    const orphan = await w.put("orphan");
    w.advance(3 * DAY);
    const young = await w.put("young");
    const report = await collectLineageContent(w.deps(yielding(kept)));
    expect(report).toMatchObject({ roots: 1, reclaimed: 1, failed: 0, skipped: false });
    expect(report.refused).toBeUndefined();
    expect(await w.has(kept)).toBe(true);
    expect(await w.has(orphan)).toBe(false);
    expect(await w.has(young)).toBe(true);
    expect(w.lock.release).toHaveBeenCalledOnce();
  });

  it("deletes NOTHING when the root enumeration fails midway, counting the class only", async () => {
    const w = world();
    const a = await w.put("a");
    await w.put("b");
    w.advance(3 * DAY);
    class LineUnreadableError extends Error {}
    const pins = async function* () {
      yield a;
      throw new LineUnreadableError("the line of user-secret-id failed");
    };
    const report = await collectLineageContent(w.deps(pins));
    expect(report).toMatchObject({
      refused: "roots-incomplete",
      reclaimed: 0,
      failed: 1,
      failedByClass: { LineUnreadableError: 1 },
    });
    expect(JSON.stringify(report)).not.toContain("user-secret-id");
    expect(await w.has(a)).toBe(true);
    expect((await w.store.listPage?.({ limit: 10 }))?.entries).toHaveLength(2);
  });

  it("reports a store without a clock as no-clock, deleting nothing", async () => {
    const w = world();
    const a = await w.put("a");
    w.advance(3 * DAY);
    const missing = w.deps(yielding("x"), { store: withoutMethod(w.store, "touchClock") });
    expect(await collectLineageContent(missing)).toMatchObject({
      refused: "no-clock",
      reclaimed: 0,
      failed: 1,
    });
    const throwing = withoutMethod(w.store, "touch");
    const broken = {
      ...throwing,
      touchClock: async () => {
        throw new RangeError("clock down");
      },
    } as unknown as LineageGcDeps["store"];
    expect(await collectLineageContent(w.deps(yielding("x"), { store: broken }))).toMatchObject({
      refused: "no-clock",
      failedByClass: { RangeError: 1 },
    });
    expect(await w.has(a)).toBe(true);
  });

  it("deletes nothing when the pins are unavailable from the start", async () => {
    const w = world();
    const a = await w.put("a");
    w.advance(3 * DAY);
    const pins = (): AsyncIterable<string> => {
      throw new TypeError("the LineageStore cannot enumerate its lines");
    };
    expect(await collectLineageContent(w.deps(pins))).toMatchObject({
      refused: "roots-incomplete",
      failedByClass: { TypeError: 1 },
    });
    expect(await w.has(a)).toBe(true);
  });

  it("stops between root yields on shutdown, without erasing or failing", async () => {
    const w = world();
    const a = await w.put("a");
    w.advance(3 * DAY);
    const ctl = new AbortController();
    const pins = async function* () {
      yield "sha256:one";
      ctl.abort();
      yield "sha256:two";
    };
    const report = await collectLineageContent(w.deps(pins), ctl.signal);
    expect(report).toMatchObject({ refused: "stopped", reclaimed: 0, failed: 0 });
    expect(await w.has(a)).toBe(true);
  });

  it("reports a shutdown during the sweep as stopped, not sweep-failed", async () => {
    const w = world();
    w.advance(3 * DAY);
    const ctl = new AbortController();
    const store = {
      delete: w.store.delete.bind(w.store),
      deleteIfUntouchedSince: w.store.deleteIfUntouchedSince?.bind(w.store),
      touch: w.store.touch?.bind(w.store),
      touchClock: w.store.touchClock?.bind(w.store),
      listPage: async () => {
        ctl.abort();
        throw new Error("the connection was closed");
      },
    } as LineageGcDeps["store"];
    const report = await collectLineageContent(w.deps(yielding("sha256:x"), { store }), ctl.signal);
    expect(report).toMatchObject({ refused: "stopped", failed: 0 });
  });

  it("deletes nothing when the root set is empty", async () => {
    const w = world();
    const a = await w.put("a");
    w.advance(3 * DAY);
    expect(await collectLineageContent(w.deps(yielding()))).toMatchObject({
      refused: "no-roots",
      reclaimed: 0,
    });
    expect(await w.has(a)).toBe(true);
  });

  it("keeps a blob touched after the roots were computed (a promote, a branch or a put during the run)", async () => {
    const w = world();
    const keep = await w.put("keep");
    const raced = await w.put("raced");
    const gone = await w.put("gone");
    w.advance(3 * DAY);
    const pins = async function* () {
      yield keep;
      // The run is already past the cutoff when a writer re-cites an old blob.
      await w.store.touch?.([raced]);
    };
    const report = await collectLineageContent(w.deps(pins));
    expect(report.reclaimed).toBe(1);
    expect(await w.has(raced)).toBe(true);
    expect(await w.has(gone)).toBe(false);
  });

  it("measures the grace from when the roots began, so a blob that came of age while they were read survives", async () => {
    const w = world();
    const borderline = await w.put("borderline"); // touched at t
    w.advance(DAY - 1000); // the run starts 1 s short of a day later
    const pins = async function* () {
      w.advance(2000); // reading the roots takes 2 s: by the sweep the blob is a day and a second old
      yield "sha256:some-root";
    };
    const report = await collectLineageContent(w.deps(pins));
    expect(report.reclaimed).toBe(0);
    expect(await w.has(borderline)).toBe(true);
  });

  it("refuses to erase through a store without touch (Loom's guard), counting the class", async () => {
    const w = world();
    const a = await w.put("a");
    w.advance(3 * DAY);
    const report = await collectLineageContent(
      w.deps(yielding("sha256:x"), { store: withoutMethod(w.store, "touch") }),
    );
    expect(report.refused).toBe("sweep-failed");
    expect(report.failedByClass).toEqual({ ReclaimOrphansTouchError: 1 });
    expect(await w.has(a)).toBe(true);
  });

  it("lets only one run work: a second run finds the lock held and looks at nothing", async () => {
    const w = world();
    const pins = vi.fn(yielding("x"));
    const held = w.deps(pins, { lock: async () => null });
    expect(await collectLineageContent(held)).toMatchObject({ skipped: true, reclaimed: 0 });
    expect(pins).not.toHaveBeenCalled();
  });

  it("stops without erasing when the lock is lost while the roots are read", async () => {
    const w = world();
    const a = await w.put("a");
    w.advance(3 * DAY);
    const pins = async function* () {
      yield "sha256:keep";
      w.lock.lost.abort();
      yield "sha256:more";
    };
    expect(await collectLineageContent(w.deps(pins))).toMatchObject({
      refused: "stopped",
      reclaimed: 0,
    });
    expect(await w.has(a)).toBe(true);
  });

  it("uses a one-day grace by default", () => {
    expect(LINEAGE_GC_GRACE_MS).toBe(DAY);
  });
});

/** An in-memory `maintenance_runs`: `last` is undefined until a run is marked. */
function fakeRuns(last?: number, now = () => 1_000_000) {
  const state = { last };
  const runs: MaintenanceRuns & { marks: number } = {
    marks: 0,
    due: async (_name, everyMs) => state.last === undefined || now() - state.last >= everyMs,
    markRun: async () => {
      runs.marks += 1;
      state.last = now();
    },
  };
  return runs;
}

describe("collectLineageContent: scheduling by the last completed run", () => {
  const sched = (runs: MaintenanceRuns) => ({
    schedule: { name: "lineage-gc", everyMs: DAY, runs },
  });

  it("runs when there is no row, and records the run", async () => {
    const w = world();
    const runs = fakeRuns(undefined);
    const report = await collectLineageContent(w.deps(yielding("sha256:x"), sched(runs)));
    expect(report).toMatchObject({ notDue: false, skipped: false });
    expect(report.refused).toBeUndefined();
    expect(runs.marks).toBe(1);
  });

  it("skips, looking at nothing, when the last run is recent", async () => {
    const w = world();
    const runs = fakeRuns(1_000_000 - DAY / 2);
    const pins = vi.fn(yielding("sha256:x"));
    const report = await collectLineageContent(w.deps(pins, sched(runs)));
    expect(report).toMatchObject({ notDue: true, reclaimed: 0 });
    expect(pins).not.toHaveBeenCalled();
    expect(runs.marks).toBe(0);
    expect(w.lock.release).toHaveBeenCalledOnce();
  });

  it("runs when the last run is old, and updates it", async () => {
    const w = world();
    const runs = fakeRuns(1_000_000 - 2 * DAY);
    const report = await collectLineageContent(w.deps(yielding("sha256:x"), sched(runs)));
    expect(report.notDue).toBe(false);
    expect(runs.marks).toBe(1);
    expect(await runs.due("lineage-gc", DAY)).toBe(false);
  });

  it("does not count a refusal or a failure as a run", async () => {
    const w = world();
    const runs = fakeRuns(undefined);
    const failing = async function* () {
      yield "sha256:x";
      throw new Error("down");
    };
    await collectLineageContent(w.deps(failing, sched(runs)));
    await collectLineageContent(w.deps(yielding(), sched(runs))); // no-roots
    await collectLineageContent(
      w.deps(yielding("sha256:x"), { ...sched(runs), store: withoutMethod(w.store, "touch") }),
    ); // sweep refused
    expect(runs.marks).toBe(0);
  });

  it("reports an unreadable schedule as schedule-unavailable and runs nothing", async () => {
    const w = world();
    const runs = {
      due: async () => {
        throw new TypeError("db down");
      },
      markRun: async () => {},
    };
    const pins = vi.fn(yielding("sha256:x"));
    expect(await collectLineageContent(w.deps(pins, sched(runs)))).toMatchObject({
      refused: "schedule-unavailable",
      failedByClass: { TypeError: 1 },
    });
    expect(pins).not.toHaveBeenCalled();
  });
});

describe("startLineageGc", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs once per interval, never during a run, and logs counts only", async () => {
    const w = world();
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const pins = vi.fn(async function* () {
      await blocked;
      yield "sha256:x";
    });
    const gc = startLineageGc(w.deps(pins), 1000);
    expect(pins).not.toHaveBeenCalled(); // the first tick is one tick interval away
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000); // ticks during the run are skipped
    expect(pins).toHaveBeenCalledOnce();
    release();
    await gc.stop();
    const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logged).toContain("lineage gc");
    expect(logged).not.toContain("sha256:");
  });

  it("logs at startup that the collector is on and its interval", () => {
    const w = world();
    const gc = startLineageGc(w.deps(yielding("sha256:x")), 86_400_000);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).toMatch(
      /lineage gc enabled.*86400000/,
    );
    void gc.stop();
  });

  it("ticks hourly for a daily interval, so a service redeployed every day still collects", async () => {
    const w = world();
    const pins = vi.fn(yielding("sha256:x"));
    const runs = fakeRuns(undefined);
    const gc = startLineageGc(
      w.deps(pins, { schedule: { name: "lineage-gc", everyMs: DAY, runs } }),
      DAY,
    );
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(pins).toHaveBeenCalledOnce();
    await gc.stop();
  });

  it("stays quiet on a tick that is not due", async () => {
    const w = world();
    const pins = vi.fn(yielding("sha256:x"));
    const gc = startLineageGc(
      w.deps(pins, { schedule: { name: "lineage-gc", everyMs: DAY, runs: fakeRuns(1_000_000) } }),
      DAY,
    );
    vi.mocked(console.info).mockClear();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(pins).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    await gc.stop();
  });
});
