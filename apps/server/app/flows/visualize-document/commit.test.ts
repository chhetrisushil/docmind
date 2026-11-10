import { randomUUID } from "node:crypto";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryContentStore } from "@loom/plugin-content";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryProgressBus } from "../../documents/progress";
import { SENSITIVE_EVENT_PATHS } from "../../sensitive";
import { executionIdFor, subjectOfExecution } from "../../subject";
import { type CommitInput, commitEffect } from "./commit";
import { experienceIdOf, lineageTestIds } from "./testSupport";
import { aPlan, childrenOf } from "./testing";

const SECRET_LABEL = "Zebra-Secret-Label";
const SECRET_SUMMARY = "Zebra-Secret-Summary";
const ref = () => ({ tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() });
const inputOf = async (r: ReturnType<typeof ref>): Promise<CommitInput> => {
  const plan = await aPlan("revenue", SECRET_LABEL, SECRET_SUMMARY);
  return {
    ...r,
    ops: [...plan.ops],
    ...(plan.summary !== undefined && { summary: plan.summary }),
    ...(plan.summaryClass !== undefined && { summaryClass: plan.summaryClass }),
    report: plan.report,
  };
};

describe("the commit step", () => {
  it("commits the plan to the document's line and returns a content-free result", async () => {
    const lineage = new Lineage({
      events: new InMemoryLineageStore(),
      content: new InMemoryContentStore(),
    });
    const r = ref();
    const input = await inputOf(r);
    const effect = commitEffect({
      guard: { begin: async () => {} },
      lineage,
      ids: lineageTestIds,
      bus: new InMemoryProgressBus(),
      now: () => "2026-11-08T10:00:00.000Z",
    });
    const out = await effect.execute(input, undefined as never);
    expect(out).toEqual({ outcome: "done", count: input.ops.length });
    const latest = await lineage.resolveLatest(await experienceIdOf(r));
    expect(latest.ok && childrenOf(latest.value.root).map((c) => c.id)).toEqual(["revenue"]);
  });

  it("publishes visuals-ready once per commit, to the owner, and never fails the step when the bus does", async () => {
    const lineage = new Lineage({
      events: new InMemoryLineageStore(),
      content: new InMemoryContentStore(),
    });
    const r = ref();
    const input = await inputOf(r);
    const bus = new InMemoryProgressBus();
    const seen: unknown[] = [];
    bus.subscribe({ userId: r.userId }, (e) => seen.push(e));
    const other: unknown[] = [];
    bus.subscribe({ userId: randomUUID() }, (e) => other.push(e));
    const effect = commitEffect({
      guard: { begin: async () => {} },
      lineage,
      ids: lineageTestIds,
      bus,
      now: () => "2026-11-08T10:00:00.000Z",
    });
    await effect.execute(input, undefined as never);
    expect(seen).toEqual([
      { documentId: r.documentId, status: "ready", step: "finalize", visuals: "ready" },
    ]);
    expect(other).toEqual([]);

    const broken = commitEffect({
      guard: { begin: async () => {} },
      lineage,
      ids: lineageTestIds,
      bus: {
        publish: () => {
          throw new Error("bus down");
        },
        subscribe: () => () => {},
      },
      now: () => "2026-11-08T10:00:00.000Z",
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await broken.execute(input, undefined as never)).toEqual({
      outcome: "done",
      count: input.ops.length,
    });
    expect(log).toHaveBeenCalledWith("visuals ready event not published", "Error");
    log.mockRestore();
  });

  it("seals the planned ops, summary and report of its start event in the raw log", async () => {
    const input = await inputOf(ref());
    const executionId = executionIdFor(input.userId, "visualize-test");
    const inner = new InMemoryAsyncEventStore();
    const store = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
      sensitive: { ...SENSITIVE_EVENT_PATHS },
      subjectOf: subjectOfExecution,
    });
    await store.append({
      executionId,
      workflowId: "visualize-document",
      timestamp: 0,
      id: "e0",
      sequence: 0,
      eventType: "STEP_STARTED",
      payload: { stepId: "visualize-commit", input },
    } as EventEnvelope);
    const [rawEvent] = await inner.read(executionId);
    const raw = JSON.stringify(rawEvent);
    for (const secret of [SECRET_LABEL, SECRET_SUMMARY, "KeyFigure", "fact-0"])
      expect(raw, secret).not.toContain(secret);
    const sealed = (v: unknown) => (v as { __loomEnc?: string } | undefined)?.__loomEnc;
    const stored = (rawEvent?.payload as { input: Record<string, unknown> }).input;
    for (const key of ["ops", "summary", "report"])
      expect(sealed(stored[key]), `input.${key}`).toBe("loom/aes-256-gcm");
    // The ids stay readable (they carry no content), and the store opens the rest again.
    expect(stored.documentId).toBe(input.documentId);
    expect(JSON.stringify(await store.read(executionId))).toContain(SECRET_LABEL);
  });
});
