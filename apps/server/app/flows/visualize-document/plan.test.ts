import { randomUUID } from "node:crypto";
import { VISUALS_CATALOG, capabilitiesOf } from "@docmind/experiences";
import { ReferencePlanner, checkPlannerConformance } from "@loom-ui/planner";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { SENSITIVE_EVENT_PATHS } from "../../sensitive";
import { executionIdFor, subjectOfExecution } from "../../subject";
import { DocumentGoneError } from "../ingest-document/errors";
import type { Fact } from "./facts";
import type { VisualizeRef } from "./pgFacts";
import { LoadOutput, VISUALS_INTENT, loadEffect, planVisuals } from "./plan";
import { recording, scriptedPlannerModel } from "./testing";

const FIGURE: Fact = {
  kind: "figure",
  label: "Zebra Revenue",
  value: 4242,
  unit: "USD",
  chunkIds: [randomUUID()],
  ordinal: 0,
};
const draft = (nodes: unknown[], summary?: string) =>
  JSON.stringify({ ...(summary && { summary }), nodes });
const NODE = {
  id: "revenue",
  type: "KeyFigure",
  label: "Zebra Revenue",
  span: 4,
  props: {},
  binding: { capability: "fact-0", arguments: {}, path: "value", priority: "P0" },
};
// The conformance kit's revise is the model's second reply: the same draft, one tile smaller.
const REVISED_JSON = draft([{ ...NODE, span: 3 }], "A smaller headline figure");
const PLAN_JSON = draft([NODE], "A single headline figure");
const EMPTY_JSON = draft([]);

describe("planVisuals", () => {
  it("passes the conformance kit (a second compose replays with no model call)", async () => {
    const model = scriptedPlannerModel([PLAN_JSON, REVISED_JSON]);
    const planner = new ReferencePlanner({ model, modelId: "test" });
    const findings = await checkPlannerConformance(planner, {
      intent: VISUALS_INTENT,
      catalog: VISUALS_CATALOG,
      capabilities: capabilitiesOf([FIGURE]),
      meta: { author: "test", createdAt: "2026-11-08T00:00:00Z", sourceKind: "test" },
      revision: { text: "make it smaller" },
      ctx: recording(),
      modelCalls: () => model.calls,
    });
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("a plan binds the fact and is recorded as one decision", async () => {
    const ctx = recording();
    const model = scriptedPlannerModel([PLAN_JSON]);
    const planner = new ReferencePlanner({ model, modelId: "t" });
    const plan = await planVisuals(planner, [FIGURE], ctx);
    expect(plan.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(plan.ops.length).toBeGreaterThan(0);
    expect(ctx.decisions.size).toBe(1);
    await planVisuals(planner, [FIGURE], ctx);
    expect(model.calls).toBe(1);
  });

  it("an empty draft is a valid plan with no ops", async () => {
    const plan = await planVisuals(
      new ReferencePlanner({ model: scriptedPlannerModel([EMPTY_JSON]), modelId: "t" }),
      [FIGURE],
      recording(),
    );
    expect(plan.ops).toEqual([]);
  });
});

describe("the load step", () => {
  const ref: VisualizeRef = {
    tenantId: randomUUID(),
    userId: randomUUID(),
    documentId: randomUUID(),
  };
  const guard = { begin: async () => {} };

  it("returns the document's facts as its output", async () => {
    const effect = loadEffect({
      guard,
      facts: { list: async () => [FIGURE], replace: async () => 0 },
    });
    const out = await effect.execute(ref, undefined as never);
    expect(LoadOutput.parse(out)).toEqual({ outcome: "done", facts: [FIGURE] });
  });

  it("reports a vanished document as document_gone with no facts", async () => {
    const effect = loadEffect({
      guard,
      facts: {
        list: async () => {
          throw new DocumentGoneError();
        },
        replace: async () => 0,
      },
    });
    expect(await effect.execute(ref, undefined as never)).toEqual({
      outcome: "document_gone",
      facts: [],
    });
  });
});

describe("sealing", () => {
  it("registers the load output and the planner's recorded choice", () => {
    expect(SENSITIVE_EVENT_PATHS.STEP_COMPLETED).toContain("output.facts");
    for (const p of ["choice.ops", "choice.summary", "choice.findings", "choice.report"])
      expect(SENSITIVE_EVENT_PATHS.DECISION_RECORDED).toContain(p);
  });

  it("leaves no fact label, value or model text readable in the raw events", async () => {
    const ctx = recording();
    const plan = await planVisuals(
      new ReferencePlanner({ model: scriptedPlannerModel([PLAN_JSON]), modelId: "t" }),
      [FIGURE],
      ctx,
    );
    const [decisionId] = [...ctx.decisions.keys()] as [string];
    const executionId = executionIdFor(randomUUID(), "visualize-test");
    const inner = new InMemoryAsyncEventStore();
    const store = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
      sensitive: { ...SENSITIVE_EVENT_PATHS },
      subjectOf: subjectOfExecution,
    });
    const base = { executionId, workflowId: "visualize-document", timestamp: 0 };
    await store.append({
      ...base,
      id: "e0",
      sequence: 0,
      eventType: "STEP_COMPLETED",
      payload: { stepId: "visualize-load", output: { outcome: "done", facts: [FIGURE] } },
    } as EventEnvelope);
    await store.append({
      ...base,
      id: "e1",
      sequence: 1,
      eventType: "DECISION_RECORDED",
      payload: { decisionId, choice: plan },
    } as EventEnvelope);
    const raw = JSON.stringify(await inner.read(executionId));
    for (const secret of [
      "Zebra Revenue",
      "4242",
      "A single headline figure",
      "KeyFigure",
      "fact-0",
    ])
      expect(raw, secret).not.toContain(secret);
    expect(JSON.stringify(await store.read(executionId))).toContain("Zebra Revenue");
  });

  it("seals the findings and report of a plan whose first reply was invalid (model text in the attempts)", async () => {
    const SECRET = "Zebra-Secret";
    const bad = draft([
      {
        ...NODE,
        id: SECRET,
        label: SECRET,
        binding: { ...NODE.binding, capability: `${SECRET}-cap` },
      },
    ]);
    const ctx = recording();
    const plan = await planVisuals(
      new ReferencePlanner({ model: scriptedPlannerModel([bad, PLAN_JSON]), modelId: "t" }),
      [FIGURE],
      ctx,
    );
    expect(JSON.stringify(plan.report.attempts)).toContain(SECRET);
    const [decisionId] = [...ctx.decisions.keys()] as [string];
    const executionId = executionIdFor(randomUUID(), "visualize-test");
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
      eventType: "DECISION_RECORDED",
      payload: { decisionId, choice: plan },
    } as EventEnvelope);
    const [rawEvent] = await inner.read(executionId);
    expect(JSON.stringify(rawEvent)).not.toContain(SECRET);
    expect(JSON.stringify(await store.read(executionId))).toContain(SECRET);
    // Every field of the recorded choice but the class enum is a sealed envelope, so a PlanResult
    // field added later cannot leak unnoticed.
    const choice = (rawEvent?.payload as { choice: Record<string, unknown> }).choice;
    for (const [key, value] of Object.entries(choice))
      if (key !== "summaryClass")
        expect((value as { __loomEnc?: string } | undefined)?.__loomEnc, `choice.${key}`).toBe(
          "loom/aes-256-gcm",
        );
  });
});
