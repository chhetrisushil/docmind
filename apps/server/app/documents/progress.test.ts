import { randomUUID } from "node:crypto";
import type { DocumentProgressEvent } from "@docmind/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryProgressBus } from "./progress";

const scope = () => ({ userId: randomUUID() });
const event = (documentId = randomUUID()): DocumentProgressEvent => ({
  documentId,
  step: "parse",
  status: "parsing",
});

describe("InMemoryProgressBus", () => {
  it("delivers to subscribers of the same user only", () => {
    const bus = new InMemoryProgressBus();
    const a = scope();
    const seenA: unknown[] = [];
    const seenOther: unknown[] = [];
    bus.subscribe(a, (e) => seenA.push(e));
    bus.subscribe(scope(), (e) => seenOther.push(e));
    const e = event();
    bus.publish(a, e);
    expect(seenA).toEqual([e]);
    expect(seenOther).toEqual([]);
  });

  it("stops delivering after unsubscribe, and a throwing listener does not stop the others", () => {
    const bus = new InMemoryProgressBus();
    const s = scope();
    const seen: unknown[] = [];
    bus.subscribe(s, () => {
      throw new Error("bad listener");
    });
    const off = bus.subscribe(s, (e) => seen.push(e));
    expect(() => bus.publish(s, event())).not.toThrow();
    off();
    bus.publish(s, event());
    expect(seen).toHaveLength(1);
  });

  it("does not leave an async listener's rejection unhandled", async () => {
    const bus = new InMemoryProgressBus();
    const s = scope();
    const unhandled: unknown[] = [];
    const spy = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", spy);
    try {
      const seen: unknown[] = [];
      bus.subscribe(s, async () => {
        throw new Error("x");
      });
      bus.subscribe(s, (e) => seen.push(e));
      bus.publish(s, event());
      // setImmediate runs after the microtask queue drains and Node's unhandled-rejection processing
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(seen).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", spy);
    }
  });

  it("unsubscribing twice is harmless and leaves a later subscriber of the same user intact", () => {
    const bus = new InMemoryProgressBus();
    const s = scope();
    const off = bus.subscribe(s, () => {});
    off();
    const seen: unknown[] = [];
    bus.subscribe(s, (e) => seen.push(e));
    off();
    bus.publish(s, event());
    expect(seen).toHaveLength(1);
  });

  it("refuses an event outside the contract", () => {
    const bus = new InMemoryProgressBus();
    expect(() => bus.publish(scope(), { ...event(), step: "nope" } as never)).toThrow(
      /^invalid progress event$/,
    );
  });

  it("accepts a terminal failed event without a step", () => {
    const bus = new InMemoryProgressBus();
    const s = scope();
    const seen: unknown[] = [];
    bus.subscribe(s, (e) => seen.push(e));
    const failed = { documentId: randomUUID(), status: "failed" } as const;
    bus.publish(s, failed);
    expect(seen).toEqual([failed]);
  });

  it("strips fields the contract does not know before delivering", () => {
    const bus = new InMemoryProgressBus();
    const s = scope();
    const seen: unknown[] = [];
    bus.subscribe(s, (e) => seen.push(e));
    bus.publish(s, { ...event(), filename: "secret.txt" } as never);
    expect(Object.keys(seen[0] as object).sort()).toEqual(["documentId", "status", "step"]);
  });
});
