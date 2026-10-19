import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IngestPort } from "./ingest";
import { StartScheduler } from "./startScheduler";

const IDENTITY = { tenantId: randomUUID(), userId: randomUUID() };
const GEN = 7;
afterEach(() => vi.restoreAllMocks());

const port = (start: IngestPort["start"]): IngestPort => ({ start, cancel: async () => {} });

describe("StartScheduler", () => {
  it("returns from fire() before the start settles, and idle() waits for it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started: string[] = [];
    const generations: number[] = [];
    const s = new StartScheduler(
      port(async (_i, doc, generation) => {
        await gate;
        started.push(doc);
        generations.push(generation);
        return null;
      }),
    );
    s.fire(IDENTITY, "doc-1", GEN);
    expect(started).toEqual([]);
    release();
    await s.idle();
    expect(started).toEqual(["doc-1"]);
    expect(generations).toEqual([GEN]); // the port received the generation fired with
  });

  it("logs only the error class and the route when a start fails, never the message or ids", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = new StartScheduler(
      port(async () => {
        throw new RangeError("secret-name.txt");
      }),
    );
    s.fire(IDENTITY, "doc-2", GEN);
    await s.idle();
    expect(spy).toHaveBeenCalledWith("ingest start failed", "RangeError", "POST /api/documents");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-name");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("doc-2");
  });

  it("logs the label the caller gave instead of the upload route", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = new StartScheduler(
      port(async () => {
        throw new RangeError("x");
      }),
    );
    s.fire(IDENTITY, "doc-4", GEN, "stale upload sweep");
    await s.idle();
    expect(spy).toHaveBeenCalledWith("ingest start failed", "RangeError", "stale upload sweep");
  });

  it("never throws from fire() when the port throws synchronously", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = new StartScheduler(
      port(() => {
        throw new TypeError("sync");
      }),
    );
    expect(() => s.fire(IDENTITY, "doc-3", GEN)).not.toThrow();
    await s.idle();
  });

  it("idle() is already resolved when nothing is pending, and covers starts fired while waiting", async () => {
    const started: string[] = [];
    const s = new StartScheduler(
      port(async (_i, doc, _g) => {
        started.push(doc);
        return null;
      }),
    );
    await s.idle();
    s.fire(IDENTITY, "a", GEN);
    const waiting = s.idle();
    s.fire(IDENTITY, "b", GEN);
    await waiting;
    expect(started).toEqual(["a", "b"]);
  });

  it("settle() waits for that document's start only, matches ids case-insensitively, and never rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const done: string[] = [];
    const s = new StartScheduler(
      port(async (_i, doc, _g) => {
        if (doc === "other") return null;
        await gate;
        done.push(doc);
        throw new Error("boom");
      }),
    );
    await s.settle(IDENTITY, "none"); // nothing pending: resolves at once
    s.fire(IDENTITY, "abc-def", GEN);
    s.fire(IDENTITY, "other", GEN);
    let settled = false;
    const waiting = s.settle(IDENTITY, "ABC-DEF").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await waiting;
    expect(done).toEqual(["abc-def"]);
    await s.settle({ ...IDENTITY, userId: randomUUID() }, "abc-def"); // another user: nothing to wait for
  });
});
