import { randomUUID } from "node:crypto";
import { ExecutionAlreadyExistsError, type WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { chatConversationId } from "../../chats/ids";
import { visualizeTurnFlow } from "./flow";
import { turnExecutionId } from "./ids";
import { loomTurnStarter } from "./start";

const user = randomUUID();
const chat = randomUUID();
const tenant = randomUUID();
const ref = { tenantId: tenant, userId: user, chatId: chat, ord: 4 };
const cited = {
  status: "complete" as const,
  retrieved: ["k"],
  citations: [{ passageId: "k", documentId: randomUUID() }],
};
const flow = visualizeTurnFlow();

function fake() {
  const started = new Set<string>();
  const done = new Map<string, () => void>();
  const start = vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
    if (started.has(o.executionId)) throw new ExecutionAlreadyExistsError(o.executionId);
    started.add(o.executionId);
    return {
      executionId: o.executionId,
      waitForCompletion: () => new Promise<void>((r) => done.set(o.executionId, r)),
    } as never;
  });
  return {
    runtime: { start } as unknown as Pick<WorkflowRuntime, "start">,
    start,
    started,
    finish: (id: string) => done.get(id)?.(),
  };
}
const options = (over = {}) => ({
  enabled: () => true,
  tenantOf: async () => tenant,
  turn: { read: async () => cited },
  backlog: () => 0,
  maxWaiting: 20,
  onError: vi.fn(),
  ...over,
});
const settled = () => ({
  conversationId: chatConversationId(user, chat),
  executionId: chatConversationId(user, chat),
  turn: 2,
  ord: 4,
  status: "complete" as const,
});

describe("the turn starter: the hook", () => {
  it("starts visualize-turn-<chat>-<ord> once; a duplicate event is swallowed and a fork's repeat is the same id", async () => {
    const f = fake();
    const s = loomTurnStarter(f.runtime, flow, options());
    s.onSettled(settled());
    s.onSettled(settled());
    await s.idle();
    expect(f.start).toHaveBeenCalledTimes(2);
    expect([...f.started]).toEqual([turnExecutionId(user, chat, 4)]);
    expect(f.start.mock.calls[0]?.[1]).toEqual(ref); // ids only
    expect(f.start.mock.calls[0]?.[2]).toMatchObject({ principal: { tenant, actor: user } });
  });
  it("never throws into the hook, whatever the start does", async () => {
    const onError = vi.fn();
    const f = fake();
    f.start.mockRejectedValueOnce(new Error("store down"));
    const s = loomTurnStarter(f.runtime, flow, options({ onError }));
    expect(() => s.onSettled(settled())).not.toThrow();
    await s.idle();
    expect(onError).toHaveBeenCalledTimes(1);
    const s2 = loomTurnStarter(
      f.runtime,
      flow,
      options({
        onError,
        tenantOf: async () => {
          throw new Error("db");
        },
      }),
    );
    expect(() => s2.onSettled(settled())).not.toThrow();
    await s2.idle();
    expect(onError).toHaveBeenCalledTimes(2);
  });
  it("starts nothing for an interrupted turn, a disabled role or a full backlog", async () => {
    const f = fake();
    for (const o of [options({ enabled: () => false }), options({ backlog: () => 20 })]) {
      const s = loomTurnStarter(f.runtime, flow, o);
      s.onSettled(settled());
      await s.idle(); // the check has settled: a start would have been made by now
    }
    const s = loomTurnStarter(f.runtime, flow, options());
    s.onSettled({ ...settled(), status: "interrupted" });
    await s.idle();
    expect(f.start).not.toHaveBeenCalled();
    s.onSettled(settled()); // the control: the same starter does start a complete, cited turn
    await s.idle();
    expect(f.start).toHaveBeenCalledTimes(1);
  });
});

describe("the turn starter: on demand", () => {
  it("numbers re-runs from -r1 and probes past ids that exist", async () => {
    const f = fake();
    f.started.add(turnExecutionId(user, chat, 4, 1)); // an earlier process started -r1
    const s = loomTurnStarter(f.runtime, flow, options());
    expect(await s.visualize(ref)).toEqual({ kind: "started", rerun: 2 });
    f.finish(turnExecutionId(user, chat, 4, 2));
    await vi.waitFor(() => expect(s.running(ref)).toBe(false)); // idle() does not wait for the run's end
    expect(await s.visualize(ref)).toEqual({ kind: "started", rerun: 3 });
  });
  it("answers running while a run of the turn is in flight (automatic or on demand), and frees the turn when it ends", async () => {
    const f = fake();
    const s = loomTurnStarter(f.runtime, flow, options());
    s.onSettled(settled());
    await s.idle();
    expect(s.running(ref)).toBe(true);
    expect(await s.visualize(ref)).toEqual({ kind: "running" });
    f.finish(turnExecutionId(user, chat, 4));
    await vi.waitFor(() => expect(s.running(ref)).toBe(false));
    expect(await s.visualize(ref)).toEqual({ kind: "started", rerun: 1 });
  });
  it("is disabled while the visuals role is off", async () => {
    const s = loomTurnStarter(fake().runtime, flow, options({ enabled: () => false }));
    expect(await s.visualize(ref)).toEqual({ kind: "disabled" });
  });
  it("idle() settles while an execution is still running (shutdown does not wait for whole runs)", async () => {
    const f = fake(); // its waitForCompletion never resolves until finish()
    const s = loomTurnStarter(f.runtime, flow, options());
    s.onSettled(settled());
    await s.idle();
    expect(s.running(ref)).toBe(true);
  });
});
