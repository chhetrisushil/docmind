import { InMemoryContentStore } from "@loom/plugin-content";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLock } from "../db/sessionLock";
import { StartupConfigError } from "../startupError";
import {
  DEFAULT_LINEAGE_GC_INTERVAL_MS,
  LINEAGE_GC_GRACE_MS,
  type LineageGcDeps,
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

  it("deletes nothing when the store has no clock or the pins are unavailable at the start", async () => {
    const w = world();
    await w.put("a");
    w.advance(3 * DAY);
    const noClock = w.deps(yielding("x"), { store: withoutMethod(w.store, "touchClock") });
    expect(await collectLineageContent(noClock)).toMatchObject({
      refused: "roots-incomplete",
      reclaimed: 0,
    });
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
    expect(pins).not.toHaveBeenCalled(); // the first run is one interval away
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000); // ticks during the run are skipped
    expect(pins).toHaveBeenCalledOnce();
    release();
    await gc.stop();
    const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logged).toContain("lineage gc");
    expect(logged).not.toContain("sha256:");
  });
});
