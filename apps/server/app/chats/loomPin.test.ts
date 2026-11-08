import { turnSettledObserver } from "@loom/conversation";
import type { EventEnvelope } from "@loom/core";
import { describe, expect, it, vi } from "vitest";

// A guard that the Loom DocMind links to exports the turn-settled hook (loom PR #776). It fails on an older ../loom checkout.
describe("the pinned Loom exports turnSettledObserver", () => {
  it("ignores events of another flow", () => {
    const listener = vi.fn();
    const observe = turnSettledObserver({ definition: { id: "doc-chat" } }, listener);
    observe({
      workflowId: "something-else",
      executionId: "x",
      eventType: "STEP_COMPLETED",
      payload: {},
    } as unknown as EventEnvelope);
    expect(listener).not.toHaveBeenCalled();
  });
});
