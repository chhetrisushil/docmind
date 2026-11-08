import type { EventEnvelope } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { composeDurableObservers } from "./observers";

const e = { eventType: "STEP_COMPLETED" } as unknown as EventEnvelope;
describe("composeDurableObservers", () => {
  it("calls every observer in order, whatever an earlier one does", async () => {
    const calls: string[] = [];
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const one = composeDurableObservers(
      () => {
        calls.push("a");
        throw new Error("sync");
      },
      async () => {
        calls.push("b");
        throw new Error("async");
      },
      () => void calls.push("c"),
    );
    expect(one(e)).toBeUndefined(); // never returns a promise the runtime could await or fail on
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["a", "b", "c"]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
