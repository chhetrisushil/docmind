import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openStream } from "./events";
import { InMemoryProgressBus, type ProgressBus } from "./progress";

// A bus per test: a module-level bus would keep every earlier test's subscribers attached.
let bus = new InMemoryProgressBus();
beforeEach(() => {
  bus = new InMemoryProgressBus();
});
const scope = { userId: randomUUID() };
const ev = (documentId = randomUUID()) =>
  ({ documentId, step: "chunk", status: "parsing" }) as const;
const noSchedule = () => () => {};

const fakeResponse = (accepts: boolean | (() => boolean) = true) => {
  const written: string[] = [];
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    write: (frame: string) => {
      written.push(frame);
      return typeof accepts === "function" ? accepts() : accepts;
    },
    end: vi.fn(),
    destroy: vi.fn(),
  });
  return { res: res as unknown as ServerResponse, raw: res, written };
};

describe("openStream", () => {
  it("frames each event with an increasing id and the contract's JSON", () => {
    const { res, written } = fakeResponse();
    openStream(res, () => {}, bus, scope, noSchedule, 15_000);
    const [a, b] = [ev(), ev()];
    bus.publish(scope, a);
    bus.publish(scope, b);
    expect(written).toEqual([
      `id: 1\nevent: progress\ndata: ${JSON.stringify(a)}\n\n`,
      `id: 2\nevent: progress\ndata: ${JSON.stringify(b)}\n\n`,
    ]);
  });

  it("frames a terminal event that has no step", () => {
    const { res, written } = fakeResponse();
    openStream(res, () => {}, bus, scope, noSchedule, 15_000);
    const failed = { documentId: randomUUID(), status: "failed", detail: "internal" } as const;
    bus.publish(scope, failed);
    expect(written).toEqual([`id: 1\nevent: progress\ndata: ${JSON.stringify(failed)}\n\n`]);
  });

  it("sends a heartbeat comment each time the scheduler fires, at the given interval", () => {
    const { res, written } = fakeResponse();
    let beat: () => void = () => {};
    const schedule = vi.fn((fn: () => void) => {
      beat = fn;
      return () => {};
    });
    openStream(res, () => {}, bus, scope, schedule, 15_000);
    beat();
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 15_000);
    expect(written).toEqual([": ping\n\n"]);
  });

  it("drops a consumer that cannot keep up: a full buffer destroys the response and unsubscribes", () => {
    const { res, raw, written } = fakeResponse(false);
    const cancelled = vi.fn();
    openStream(
      res,
      () => {},
      bus,
      scope,
      () => cancelled,
      15_000,
    );
    bus.publish(scope, ev());
    bus.publish(scope, ev()); // never written: the first full buffer ended the stream
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(raw.end).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
  });

  it("stop is idempotent: one cancel, one end, no writes afterwards", () => {
    const { res, raw, written } = fakeResponse();
    let beat: () => void = () => {};
    const cancelled = vi.fn();
    const stop = openStream(
      res,
      () => {},
      bus,
      scope,
      (fn) => {
        beat = fn;
        return cancelled;
      },
      15_000,
    );
    stop();
    stop();
    bus.publish(scope, ev());
    beat();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(raw.end).toHaveBeenCalledTimes(1);
    expect(raw.destroy).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it("hands stop to onClose, and calling it twice is safe", () => {
    const { res, raw, written } = fakeResponse();
    let close: () => void = () => {};
    const cancelled = vi.fn();
    openStream(
      res,
      (fn) => {
        close = fn;
      },
      bus,
      scope,
      () => cancelled,
      15_000,
    );
    close();
    close();
    bus.publish(scope, ev());
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(raw.end).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
  });

  it.each(["close", "error"])("a %s on the response stops the stream once", (name) => {
    const { res, raw, written } = fakeResponse();
    const cancelled = vi.fn();
    const stop = openStream(
      res,
      () => {},
      bus,
      scope,
      () => cancelled,
      15_000,
    );
    raw.emit(name);
    stop();
    bus.publish(scope, ev());
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(raw.end).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it("never throws into the bus when write throws; the stream is destroyed", () => {
    const { res, raw } = fakeResponse(() => {
      throw new Error("EPIPE");
    });
    openStream(res, () => {}, bus, scope, noSchedule, 15_000);
    expect(() => bus.publish(scope, ev())).not.toThrow();
    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not block other subscribers when this client is slow", () => {
    const { res } = fakeResponse(false);
    openStream(res, () => {}, bus, scope, noSchedule, 15_000);
    const other = vi.fn();
    bus.subscribe(scope, other);
    bus.publish(scope, ev());
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("subscribes only to the given scope", () => {
    const { res, written } = fakeResponse();
    openStream(res, () => {}, bus, scope, noSchedule, 15_000);
    bus.publish({ userId: randomUUID() }, ev());
    expect(written).toEqual([]);
  });

  it("only the contract's fields reach the wire", () => {
    const { res, written } = fakeResponse();
    openStream(res, () => {}, bus, scope, noSchedule, 15_000);
    bus.publish(scope, { ...ev(), filename: "secret.txt" } as never);
    expect(written[0]).not.toContain("secret");
  });

  it("a crafted event cannot inject an SSE field: the frame is exactly three lines plus the blank", () => {
    const { res, written } = fakeResponse();
    openStream(res, () => {}, bus, scope, noSchedule, 15_000);
    const crafted = {
      documentId: randomUUID(),
      status: "failed",
      detail: "internal\n\nevent: evil\ndata: x",
    };
    expect(() => bus.publish(scope, crafted as never)).toThrow(/invalid progress event/);
    expect(written).toEqual([]);
    // Even a value the schema would let through carries no raw newline into the frame.
    const ok = ev();
    bus.publish(scope, ok);
    expect(written[0]?.split("\n")).toHaveLength(5);
    expect(written[0]?.endsWith("\n\n")).toBe(true);
    expect(JSON.stringify("a\nevent: evil")).not.toContain("\n");
  });

  it("a bus that delivers during subscribe and fills the buffer leaves no subscription behind", () => {
    const { res, raw } = fakeResponse(false);
    const off = vi.fn();
    const cancelled = vi.fn();
    const syncBus: ProgressBus = {
      publish: () => {},
      subscribe: (_scope, listener) => {
        listener(ev()); // synchronous delivery before subscribe returns
        return off;
      },
    };
    openStream(
      res,
      () => {},
      syncBus,
      scope,
      () => cancelled,
      15_000,
    );
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1); // the heartbeat started after the end is cancelled too
  });

  it("the in-memory bus never delivers during subscribe", () => {
    const heard = vi.fn();
    new InMemoryProgressBus().subscribe(scope, heard);
    expect(heard).not.toHaveBeenCalled();
  });
});
