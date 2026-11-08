import { randomUUID } from "node:crypto";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import { InMemoryContentStore } from "@loom/plugin-content";
import { describe, expect, it, vi } from "vitest";
import type { ChatBus, LiveChatEvent } from "../../chats/bus";
import { SENSITIVE_EVENT_PATHS } from "../../sensitive";
import { type TurnCommitInput, turnCommitEffect } from "./commit";
import { turnExperienceId } from "./ids";
import { aTurnPlan } from "./testing";

const ref = () => ({ tenantId: randomUUID(), userId: randomUUID(), chatId: randomUUID(), ord: 6 });
const lineage = () =>
  new Lineage({ events: new InMemoryLineageStore(), content: new InMemoryContentStore() });
const make = (l: Lineage, bus: Pick<ChatBus, "publish">) =>
  turnCommitEffect({
    guard: { begin: async () => {} },
    lineage: l,
    bus,
    now: () => "2026-11-08T10:00:00.000Z",
  });
type Visualized = Extract<TurnCommitInput, { outcome: "visualized" }>;
const visualized = async (r: ReturnType<typeof ref>): Promise<Visualized> => {
  const plan = await aTurnPlan("headline", "Zebra-Secret-Label", "Zebra-Secret-Summary");
  return {
    ...r,
    outcome: "visualized",
    ops: [...plan.ops],
    report: plan.report,
    ...(plan.summary && { summary: plan.summary }),
  };
};

describe("turn-commit", () => {
  it("commits to the turn's line and publishes visuals to the chat", async () => {
    const l = lineage();
    const seen: [string, LiveChatEvent][] = [];
    const r = ref();
    const input = await visualized(r);
    const out = await make(l, { publish: (c, e) => void seen.push([c, e]) }).execute(
      input,
      undefined as never,
    );
    expect(out).toEqual({ outcome: "done", count: input.ops.length });
    expect(await l.head(turnExperienceId(r))).toMatchObject({
      ok: true,
      value: expect.any(String),
    });
    expect(seen).toEqual([[r.chatId, { kind: "visuals", ord: 6, outcome: "visualized" }]]);
  });
  it("is idempotent: a second commit of the same plan writes nothing new and still announces", async () => {
    const l = lineage();
    const r = ref();
    const input = await visualized(r);
    const publish = vi.fn();
    const effect = make(l, { publish });
    await effect.execute(input, undefined as never);
    const head1 = await l.head(turnExperienceId(r));
    await effect.execute(input, undefined as never);
    expect(await l.head(turnExperienceId(r))).toEqual(head1);
    expect(publish).toHaveBeenCalledTimes(2);
  });
  it("replaces the head when a re-run decided a different plan", async () => {
    const l = lineage();
    const r = ref();
    const effect = make(l, { publish: vi.fn() });
    await effect.execute(await visualized(r), undefined as never);
    const head1 = await l.head(turnExperienceId(r));
    const plan = await aTurnPlan("other", "Other-Label");
    await effect.execute(
      { ...r, outcome: "visualized", ops: [...plan.ops], report: plan.report },
      undefined as never,
    );
    const head2 = await l.head(turnExperienceId(r));
    expect(head2).toMatchObject({ ok: true });
    expect(head2).not.toEqual(head1);
  });
  it("writes nothing to the lineage for 'nothing', and announces it (every run that ends nothing publishes)", async () => {
    const l = lineage();
    const r = ref();
    const publish = vi.fn();
    await make(l, { publish }).execute({ ...r, outcome: "nothing" }, undefined as never);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(r.chatId, { kind: "visuals", ord: 6, outcome: "nothing" });
    expect(await l.head(turnExperienceId(r))).toEqual({ ok: true, value: null });
  });
  it("fails with the lineage error (fatal, not retried) when 'visualized' arrives without a report, and publishes nothing", async () => {
    const publish = vi.fn();
    const input = { ...(await visualized(ref())) } as Record<string, unknown>;
    input.report = undefined;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        make(lineage(), { publish }).execute(input as never, undefined as never),
      ).rejects.toThrow("ingest step failed: turn-commit"); // the event log's fixed text
      // the class that reaches the process log: the lineage error, which is fatal (one attempt, no retry)
      expect(log.mock.calls).toEqual([
        ["ingest step failed", "turn-commit", "VisualsLineageError"],
      ]);
    } finally {
      log.mockRestore();
    }
    expect(publish).not.toHaveBeenCalled();
  });
  it("ends 'gone' (the shared document_gone outcome), writing and publishing nothing, when the turn's line was erased", async () => {
    const erased = {
      head: async () => ({ ok: false, refusal: { kind: "line-erased" } }),
    } as unknown as Lineage;
    const publish = vi.fn();
    const out = await make(erased, { publish }).execute(
      await visualized(ref()),
      undefined as never,
    );
    expect(out).toEqual({ outcome: "document_gone" });
    expect(publish).not.toHaveBeenCalled();
  });
  it("never fails the step when the bus does", async () => {
    const r = ref();
    const out = await make(lineage(), {
      publish: () => {
        throw new Error("bus down");
      },
    }).execute(await visualized(r), undefined as never);
    expect(out.outcome).toBe("done");
  });
  it("relies on sealed event paths that are registered: ops, summary, report in, facts out", () => {
    expect(SENSITIVE_EVENT_PATHS.STEP_STARTED).toEqual(
      expect.arrayContaining(["input.ops", "input.summary", "input.report"]),
    );
    expect(SENSITIVE_EVENT_PATHS.STEP_COMPLETED).toContain("output.facts");
    expect(SENSITIVE_EVENT_PATHS.DECISION_RECORDED).toEqual(
      expect.arrayContaining(["choice.ops", "choice.summary", "choice.findings", "choice.report"]),
    );
  });
});
