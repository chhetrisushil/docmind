import type { BargeInHandlers, BargeInSource } from "@loom/conversation";
import { describe, expect, it, vi } from "vitest";
import { StopRegistry, stoppableBargeIn } from "./stop";

const CONV = "u_a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1.c-c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const handlers = (): BargeInHandlers => ({ onMessage: vi.fn(), isKnown: () => false });

/** A fake inner source: records who subscribed and with what, and counts unsubscribes. */
function fakeInner() {
  const subscribed: { conversationId: string; ownerId: string; handlers: BargeInHandlers }[] = [];
  const unsubscribed = vi.fn();
  const source: BargeInSource = async (conversationId, ownerId, h) => {
    subscribed.push({ conversationId, ownerId, handlers: h });
    return unsubscribed;
  };
  return { source, subscribed, unsubscribed };
}

describe("StopRegistry", () => {
  it("reports not running, and stops nothing, when no listener is registered", () => {
    const stops = new StopRegistry();
    expect([stops.running(CONV), stops.stop(CONV)]).toEqual([false, false]);
  });

  it("fires every listener of the conversation, once per stop, and only that conversation's", () => {
    const stops = new StopRegistry();
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    stops.on(CONV, a);
    stops.on(CONV, b);
    stops.on("other", other);
    expect(stops.running(CONV)).toBe(true);
    expect(stops.stop(CONV)).toBe(true);
    expect([a.mock.calls.length, b.mock.calls.length, other.mock.calls.length]).toEqual([1, 1, 0]);
  });

  it("keeps firing the rest when one listener throws", () => {
    const stops = new StopRegistry();
    const after = vi.fn();
    stops.on(CONV, () => {
      throw new RangeError("boom");
    });
    stops.on(CONV, after);
    expect(stops.stop(CONV)).toBe(true);
    expect(after).toHaveBeenCalledOnce();
  });

  it("forgets a listener once it unsubscribes, however often it is called", () => {
    const stops = new StopRegistry();
    const fn = vi.fn();
    const off = stops.on(CONV, fn);
    off();
    off();
    expect([stops.running(CONV), stops.stop(CONV), fn.mock.calls.length]).toEqual([
      false,
      false,
      0,
    ]);
  });
});

describe("stoppableBargeIn", () => {
  it("subscribes the inner source with the very same handlers, so a new message still interrupts", async () => {
    const stops = new StopRegistry();
    const inner = fakeInner();
    const h = handlers();
    await stoppableBargeIn(inner.source, stops)(CONV, "owner-1", h);
    expect(inner.subscribed).toEqual([{ conversationId: CONV, ownerId: "owner-1", handlers: h }]);
  });

  it("turns a stop into the turn's interruption: handlers.onMessage fires once and stop reports a running turn", async () => {
    const stops = new StopRegistry();
    const h = handlers();
    await stoppableBargeIn(fakeInner().source, stops)(CONV, "owner-1", h);
    expect(stops.stop(CONV)).toBe(true);
    expect(h.onMessage).toHaveBeenCalledOnce();
  });

  it("does not stop another conversation's turn", async () => {
    const stops = new StopRegistry();
    const h = handlers();
    await stoppableBargeIn(fakeInner().source, stops)(CONV, "owner-1", h);
    expect(stops.stop("someone-else")).toBe(false);
    expect(h.onMessage).not.toHaveBeenCalled();
  });

  it("unsubscribes from both the stops and the inner source when the turn ends", async () => {
    const stops = new StopRegistry();
    const inner = fakeInner();
    const h = handlers();
    const off = await stoppableBargeIn(inner.source, stops)(CONV, "owner-1", h);
    off();
    expect(inner.unsubscribed).toHaveBeenCalledOnce();
    expect([
      stops.running(CONV),
      stops.stop(CONV),
      (h.onMessage as ReturnType<typeof vi.fn>).mock.calls.length,
    ]).toEqual([false, false, 0]);
  });

  it("leaves no stop listener behind when the inner source fails, and rethrows its error", async () => {
    const stops = new StopRegistry();
    const boom = new RangeError("subscribe failed");
    const source: BargeInSource = async () => {
      throw boom;
    };
    await expect(stoppableBargeIn(source, stops)(CONV, "o", handlers())).rejects.toBe(boom);
    expect(stops.running(CONV)).toBe(false);
  });

  it("accepts an inner source that answers synchronously", async () => {
    const stops = new StopRegistry();
    const off = vi.fn();
    const source: BargeInSource = () => off;
    const un = await stoppableBargeIn(source, stops)(CONV, "o", handlers());
    un();
    expect(off).toHaveBeenCalledOnce();
  });

  it("a stop while the inner subscribe is still pending reaches onMessage, and unsubscribing leaves no listener", async () => {
    const stops = new StopRegistry();
    const unsubscribed = vi.fn();
    let release!: (off: () => void) => void;
    const source: BargeInSource = () =>
      new Promise<() => void>((r) => {
        release = r;
      });
    const h = handlers();
    const pending = stoppableBargeIn(source, stops)(CONV, "o", h);
    expect(stops.stop(CONV)).toBe(true);
    expect(h.onMessage).toHaveBeenCalledOnce();
    release(unsubscribed);
    const off = await pending;
    off();
    expect([unsubscribed.mock.calls.length, stops.running(CONV)]).toEqual([1, false]);
  });
});
