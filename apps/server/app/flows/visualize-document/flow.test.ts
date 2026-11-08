import { randomUUID } from "node:crypto";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { InMemoryContentStore } from "@loom/plugin-content";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../config";
import { SENSITIVE_EVENT_PATHS } from "../../sensitive";
import { isIngestExecution, isVisualizeExecution } from "../../status/model";
import { foldIngestStatus } from "../../status/model";
import { subjectOfExecution } from "../../subject";
import { LLM_RETRY, STEP_RETRY } from "../ingest-document/stepEffect";
import type { VisualizeDeps } from "./deps";
import type { Fact } from "./facts";
import {
  VISUALIZE_STEPS,
  VisualizeOutput,
  visualizeCommitStep,
  visualizeDocumentFlow,
  visualizeExtractStep,
  visualizeLoadStep,
} from "./flow";
import { experienceIdOf } from "./lineage";
import type { VisualizeRef } from "./pgFacts";
import { visualsPlanner } from "./planner";
import { visualizeExecutionId } from "./start";
import { childrenOf } from "./testing";

const LABEL = "Zebra-Secret-Revenue";
const SUMMARY = "Zebra-Secret-Summary-Text";
const CHUNK = randomUUID();
const TEXT = `${LABEL} was 4242 USD last year.`;
const FACTS = JSON.stringify({
  facts: [{ kind: "figure", label: LABEL, value: 4242, unit: "USD", chunkIds: [CHUNK] }],
});
const NODE = {
  id: "revenue",
  type: "KeyFigure",
  label: LABEL,
  span: 4,
  props: {},
  binding: { capability: "fact-0", arguments: {}, path: "value", priority: "P0" },
};
const PLAN = JSON.stringify({ summary: SUMMARY, nodes: [NODE] });
const EMPTY_PLAN = JSON.stringify({ nodes: [] });
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

/** A provider that answers each call with the next reply (the last repeats) and records the requests. */
const scripted = (replies: string[]) => {
  const requests: LlmRequest[] = [];
  const llm: LlmProvider & { model: string } = {
    model: "claude-test",
    complete: async (r: LlmRequest) => {
      requests.push(r);
      return {
        content: replies[Math.min(requests.length - 1, replies.length - 1)] as string,
        stopReason: "end_turn",
      };
    },
  };
  return { llm, requests };
};

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function stack(replies: string[] | null) {
  const inner = new InMemoryAsyncEventStore();
  const sealed = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
    sensitive: { ...SENSITIVE_EVENT_PATHS },
    subjectOf: subjectOfExecution,
  });
  const lineage = new Lineage({
    events: new InMemoryLineageStore(),
    content: new InMemoryContentStore(),
  });
  const model = replies ? scripted(replies) : undefined;
  let held: Fact[] = [];
  const planner = model && visualsPlanner(model.llm, KEY);
  const deps: VisualizeDeps = {
    guard: { begin: async () => {} },
    chunks: {
      sectionsOf: async () => [{ id: CHUNK, sectionOrdinal: 0 }],
      read: async () => [{ id: CHUNK, text: TEXT }],
    },
    facts: {
      replace: async (_r, facts) => {
        held = [...facts];
        return facts.length;
      },
      list: async () => held,
    },
    lineage,
    now: () => "2026-11-08T10:00:00.000Z",
    sleep: async () => {},
    ...(model && { llm: model.llm }),
    ...(planner && { planner }),
  };
  const app = buildApp(
    { kind: "custom", eventStore: sealed },
    { events: sealed },
    {
      visualize: { flow: visualizeDocumentFlow(() => planner), deps },
    },
  );
  apps.push(app);
  const ref: VisualizeRef = {
    tenantId: randomUUID(),
    userId: randomUUID(),
    documentId: randomUUID(),
  };
  const executionId = visualizeExecutionId(ref.userId, ref.documentId, 2);
  const run = async () => {
    const handle = await app.runtime.start(
      visualizeDocumentFlow(() => planner),
      ref,
      {
        executionId,
        principal: { tenant: ref.tenantId, actor: ref.userId },
      },
    );
    const state = await handle.waitForCompletion();
    return VisualizeOutput.parse(state.variables._output);
  };
  return { app, inner, sealed, lineage, model, ref, executionId, run };
}

describe("visualize-document flow", () => {
  it("pins its identity: version, step ids and retry policies", () => {
    const flow = visualizeDocumentFlow();
    expect(flow.definition.id).toBe("visualize-document");
    expect(flow.definition.version).toBe("1.0.0");
    expect(VISUALIZE_STEPS.map((s) => s.id)).toEqual([
      "visualize-extract",
      "visualize-load",
      "visualize-commit",
    ]);
    expect(visualizeExtractStep.retry).toEqual(LLM_RETRY);
    expect(visualizeLoadStep.retry).toEqual(STEP_RETRY);
    expect(visualizeCommitStep.retry).toEqual(STEP_RETRY);
  });

  it("extracts, plans and commits: done, with the plan as the document's visuals", async () => {
    const s = stack([FACTS, PLAN]);
    expect(await s.run()).toEqual({ outcome: "done" });
    const latest = await s.lineage.resolveLatest(experienceIdOf(s.ref));
    expect(latest.ok && childrenOf(latest.value.root).map((c) => c.id)).toEqual(["revenue"]);
    expect(s.model?.requests).toHaveLength(2); // one extract window, one planner call
  });

  it("holds no fact label, value or planner text unsealed in the raw log (the planner call writes no event)", async () => {
    const s = stack([FACTS, PLAN]);
    await s.run();
    const raw = await s.inner.read(s.executionId);
    expect(raw.length).toBeGreaterThan(0);
    const text = JSON.stringify(raw);
    for (const secret of [LABEL, SUMMARY, "4242", "KeyFigure", "fact-0", "Zebra"])
      expect(text, secret).not.toContain(secret);
    // The same log, opened by the sealing store, does hold them: the proof is not vacuous.
    const opened = JSON.stringify(await s.sealed.read(s.executionId));
    expect(opened).toContain(LABEL);
    expect(opened).toContain(SUMMARY);
    // The ids stay readable and the model event kinds are the step and decision ones only.
    const types = new Set(raw.map((e: EventEnvelope) => e.eventType));
    expect([...types].filter((t) => /LLM|MODEL|TOOL_CALL/.test(t))).toEqual([]);
    expect(types.has("DECISION_RECORDED")).toBe(true);
  });

  it("is empty when the model finds no facts: nothing is planned or committed", async () => {
    const s = stack([JSON.stringify({ facts: [] })]);
    expect(await s.run()).toEqual({ outcome: "empty" });
    expect(s.model?.requests).toHaveLength(1);
    expect(await s.lineage.head(experienceIdOf(s.ref))).toEqual({ ok: true, value: null });
  });

  it("fails when the planner answers with no nodes (the planner refuses an empty plan), committing nothing", async () => {
    const s = stack([FACTS, EMPTY_PLAN]);
    expect(await s.run()).toEqual({ outcome: "failed", code: "visuals-plan-invalid" });
    expect(await s.lineage.head(experienceIdOf(s.ref))).toEqual({ ok: true, value: null });
  });

  it("is skipped when the visuals role is off", async () => {
    const s = stack(null);
    expect(await s.run()).toEqual({ outcome: "skipped" });
  });

  it("fails with a fixed code when the planner's plan is invalid, committing nothing", async () => {
    const s = stack([FACTS, "this is not json", "still not json"]);
    expect(await s.run()).toEqual({ outcome: "failed", code: "visuals-plan-invalid" });
    expect(await s.lineage.head(experienceIdOf(s.ref))).toEqual({ ok: true, value: null });
  });
});

describe("a visualize execution is not an ingest one", () => {
  it("its ids never match the ingest pattern, and its failure never folds into an ingest status", async () => {
    const s = stack(null);
    expect(isIngestExecution(s.executionId)).toBe(false);
    expect(isVisualizeExecution(s.executionId)).toBe(true);
    expect(isVisualizeExecution(visualizeExecutionId(s.ref.userId, s.ref.documentId, 1))).toBe(
      true,
    );
    // A failed visualize execution's events leave the ingest status model at its initial state (the neutral row).
    const failed = {
      id: `${s.executionId}-1`,
      executionId: s.executionId,
      workflowId: "visualize-document",
      timestamp: 1,
      sequence: 1,
      eventType: "EXECUTION_FAILED",
      payload: { error: "x" },
    } as EventEnvelope;
    expect(foldIngestStatus([failed])).toEqual({});
  });
});
