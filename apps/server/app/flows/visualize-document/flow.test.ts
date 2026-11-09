import { randomUUID } from "node:crypto";
import { LlmRefusalError, LlmRequestError, LlmUnavailableError } from "@docmind/llm-anthropic";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import { type EventEnvelope, flowContentHash, flowHashMatches } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { InMemoryContentStore } from "@loom/plugin-content";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../config";
import { InMemoryProgressBus } from "../../documents/progress";
import { SENSITIVE_EVENT_PATHS } from "../../sensitive";
import { isIngestExecution, isVisualizeExecution } from "../../status/model";
import { foldIngestStatus } from "../../status/model";
import { subjectOfExecution } from "../../subject";
import { CONNECTIONS_PLAN_NODE } from "../../ui/testSupport";
import { LLM_RETRY, STEP_RETRY } from "../ingest-document/stepEffect";
import type { VisualizeDeps } from "./deps";
import type { Fact, StructureFact } from "./facts";
import {
  LEGACY_VISUALIZE_STEPS,
  VISUALIZE_STEPS,
  VisualizeOutput,
  visualizeCommitStep,
  visualizeDocumentFlow,
  visualizeExtractStep,
  visualizeLoadStep,
  visualizeStructureStep,
} from "./flow";
import { experienceIdOf } from "./lineage";
import type { VisualizeRef } from "./pgFacts";
import { visualsPlanner } from "./planner";
import { visualizeExecutionId } from "./start";
import type { StructureReader } from "./structure";
import { childrenOf, noStructure } from "./testing";

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
const CONNECTIONS_PLAN = JSON.stringify({
  summary: "The documents this one connects to",
  nodes: [CONNECTIONS_PLAN_NODE],
});
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

/** A provider that answers `ok` (in order, the last repeating) for the first `answers` calls and then throws `err` on every call. */
const failingAfter = (answers: string[], err: () => Error) => {
  const requests: LlmRequest[] = [];
  const llm: LlmProvider & { model: string } = {
    model: "claude-test",
    complete: async (r: LlmRequest) => {
      requests.push(r);
      if (requests.length > answers.length) throw err();
      return { content: answers[requests.length - 1] as string, stopReason: "end_turn" };
    },
  };
  return { llm, requests };
};

function stack(
  replies: string[] | null,
  o: {
    provider?: ReturnType<typeof scripted>;
    executionId?: string;
    structure?: StructureReader;
    /** Start the execution on the 1.0.0 flow, as one that was in flight at deploy was. */
    legacy?: boolean;
  } = {},
) {
  const inner = new InMemoryAsyncEventStore();
  const sealed = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
    sensitive: { ...SENSITIVE_EVENT_PATHS },
    subjectOf: subjectOfExecution,
  });
  const bus = new InMemoryProgressBus();
  const lineage = new Lineage({
    events: new InMemoryLineageStore(),
    content: new InMemoryContentStore(),
  });
  const model = o.provider ?? (replies ? scripted(replies) : undefined);
  let held: Fact[] = [];
  let structured: StructureFact[] = [];
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
      replaceStructure: async (_r, facts) => {
        structured = [...facts];
        return facts.length;
      },
      list: async () => held,
      listAll: async () => [...held, ...structured],
    },
    structure: o.structure ?? noStructure(),
    summaryMaxChars: 400_000,
    bus,
    lineage,
    now: () => "2026-11-08T10:00:00.000Z",
    sleep: async () => {},
    ...(model && { llm: model.llm }),
    ...(planner && { planner }),
  };
  const current = () => visualizeDocumentFlow(() => planner);
  const legacy = () => visualizeDocumentFlow(() => planner, { legacy: true });
  const app = buildApp(
    { kind: "custom", eventStore: sealed },
    { events: sealed },
    { visualize: { flow: current(), legacyFlow: legacy(), deps } },
  );
  apps.push(app);
  const ref: VisualizeRef = {
    tenantId: randomUUID(),
    userId: randomUUID(),
    documentId: randomUUID(),
  };
  const executionId = o.executionId ?? visualizeExecutionId(ref.userId, ref.documentId, 2);
  const run = async (id: string = executionId) => {
    const handle = await app.runtime.start(o.legacy ? legacy() : current(), ref, {
      executionId: id as typeof executionId,
      principal: { tenant: ref.tenantId, actor: ref.userId },
    });
    const state = await handle.waitForCompletion();
    return VisualizeOutput.parse(state.variables._output);
  };
  return {
    app,
    inner,
    sealed,
    lineage,
    bus,
    model,
    ref,
    executionId,
    run,
    held: () => held,
    structured: () => structured,
    hold: (facts: Fact[]) => {
      held = facts;
    },
  };
}

describe("visualize-document flow", () => {
  it("pins its identity: version, step ids and retry policies", () => {
    const flow = visualizeDocumentFlow();
    expect(flow.definition.id).toBe("visualize-document");
    expect(flow.definition.version).toBe("1.1.0");
    expect(VISUALIZE_STEPS.map((s) => s.id)).toEqual([
      "visualize-extract",
      "visualize-structure",
      "visualize-load",
      "visualize-commit",
    ]);
    expect(visualizeStructureStep.retry).toEqual(STEP_RETRY);
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

  it("plans connections when the model finds no facts: a plan with a connections widget, outcome done", async () => {
    const s = stack([JSON.stringify({ facts: [] }), CONNECTIONS_PLAN]);
    expect(await s.run()).toEqual({ outcome: "done" });
    expect(s.model?.requests).toHaveLength(2); // one extraction, one planner call
    const head = await s.lineage.head(experienceIdOf(s.ref));
    expect(head.ok && head.value).toBeTruthy();
    expect(JSON.stringify(await s.sealed.read(s.executionId))).toContain("RelatedDocuments");
  });

  it("is empty when there are no facts and the planner emits nothing: nothing is committed", async () => {
    const s = stack([JSON.stringify({ facts: [] }), EMPTY_PLAN]);
    expect(await s.run()).toEqual({ outcome: "empty" });
    expect(await s.lineage.head(experienceIdOf(s.ref))).toEqual({ ok: true, value: null });
  });

  it("is still failed when there are no facts and the model is unreachable for the plan", async () => {
    const f = failingAfter([JSON.stringify({ facts: [] })], () => new LlmUnavailableError(503));
    const s = stack(["unused"], { provider: f });
    expect(await s.run()).toEqual({ outcome: "failed", code: "visuals-model-unavailable" });
  });

  it("a refusal clears the facts and still plans the connections", async () => {
    let calls = 0;
    const requests: LlmRequest[] = [];
    const llm: LlmProvider & { model: string } = {
      model: "claude-test",
      complete: async (r: LlmRequest) => {
        requests.push(r);
        calls += 1;
        if (calls === 1) throw new LlmRefusalError();
        return { content: CONNECTIONS_PLAN, stopReason: "end_turn" };
      },
    };
    const s = stack(["unused"], { provider: { llm, requests } });
    expect(await s.run()).toEqual({ outcome: "done" });
    expect(requests).toHaveLength(2);
  });

  it("fails when the planner answers with no nodes (the planner refuses an empty plan), committing nothing", async () => {
    const s = stack([FACTS, EMPTY_PLAN]);
    expect(await s.run()).toEqual({ outcome: "failed", code: "visuals-plan-invalid" });
    expect(await s.lineage.head(experienceIdOf(s.ref))).toEqual({ ok: true, value: null });
  });

  it("drops the widgets whose fact does not fit them before committing, logging the entry name only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const two = JSON.stringify({
      facts: [
        { kind: "figure", label: LABEL, value: 4242, unit: "USD", chunkIds: [CHUNK] },
        {
          kind: "series",
          label: LABEL,
          points: [
            { x: "North", y: 4242 },
            { x: "South", y: 4242 },
          ],
          chunkIds: [CHUNK],
        },
      ],
    });
    const bind = (id: string, type: string, capability: string) => ({
      ...NODE,
      id,
      type,
      binding: { ...NODE.binding, capability, path: "label" },
    });
    const planned = JSON.stringify({
      summary: SUMMARY,
      nodes: [
        bind("revenue", "KeyFigure", "fact-0"),
        bind("trend", "FigureTrend", "fact-1"),
        bind("kpi", "KeyFigure", "fact-1"),
      ],
    });
    const s = stack([two, planned]);
    expect(await s.run()).toEqual({ outcome: "done" });
    const latest = await s.lineage.resolveLatest(experienceIdOf(s.ref));
    expect(latest.ok && childrenOf(latest.value.root).map((c) => c.id)).toEqual(["revenue"]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("FigureTrend");
    expect(logged).not.toContain(LABEL);
    warn.mockRestore();
  });

  it("is empty, committing nothing, when every widget is dropped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const series = JSON.stringify({
      facts: [
        {
          kind: "series",
          label: LABEL,
          points: [
            { x: "North", y: 4242 },
            { x: "South", y: 4242 },
          ],
          chunkIds: [CHUNK],
        },
      ],
    });
    const planned = JSON.stringify({
      summary: SUMMARY,
      nodes: [{ ...NODE, type: "FigureTrend", binding: { ...NODE.binding, path: "label" } }],
    });
    const s = stack([series, planned]);
    expect(await s.run()).toEqual({ outcome: "empty" });
    expect(await s.lineage.head(experienceIdOf(s.ref))).toEqual({ ok: true, value: null });
    vi.restoreAllMocks();
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

  const STRUCTURE_READER: StructureReader = {
    title: async () => "Zebra-Secret-Report",
    headings: async () => [
      { chunkId: CHUNK, sectionOrdinal: 1, headingPath: ["Zebra-Heading-One"] },
      { chunkId: CHUNK, sectionOrdinal: 2, headingPath: ["Zebra-Heading-Two"] },
      {
        chunkId: CHUNK,
        sectionOrdinal: 3,
        headingPath: ["Zebra-Heading-Two", "Zebra-Heading-Sub"],
      },
    ],
    entities: async () => [],
    mentions: async () => [],
  };

  const OUTLINE_NODE = {
    id: "outline",
    type: "DocumentOutline",
    label: "Outline",
    span: 12,
    props: {},
    binding: { capability: "fact-16", arguments: {}, path: "nodes", priority: "P1" },
  };
  const OUTLINE_PLAN = JSON.stringify({ summary: "The outline", nodes: [OUTLINE_NODE] });

  it("plans over both an extracted fact and the outline, and commits both widgets", async () => {
    const s = stack([FACTS, JSON.stringify({ summary: SUMMARY, nodes: [NODE, OUTLINE_NODE] })], {
      structure: STRUCTURE_READER,
    });
    expect(await s.run()).toEqual({ outcome: "done" });
    const latest = await s.lineage.resolveLatest(experienceIdOf(s.ref));
    expect(latest.ok && childrenOf(latest.value.root).map((c) => c.id)).toEqual([
      "revenue",
      "outline",
    ]);
  });

  it("plans a document that has only a structure fact (no extracted facts)", async () => {
    const s = stack([JSON.stringify({ facts: [] }), OUTLINE_PLAN], { structure: STRUCTURE_READER });
    expect(await s.run()).toEqual({ outcome: "done" });
    expect(s.held()).toEqual([]);
    const latest = await s.lineage.resolveLatest(experienceIdOf(s.ref));
    expect(latest.ok && childrenOf(latest.value.root).map((c) => c.id)).toEqual(["outline"]);
  });

  it("derives the structure facts after extraction and stores them beside the extracted ones, with no extra model call", async () => {
    const s = stack([FACTS, PLAN], { structure: STRUCTURE_READER });
    expect(await s.run()).toEqual({ outcome: "done" });
    expect(s.held().map((f) => f.ordinal)).toEqual([0]);
    expect(s.structured().map((f) => [f.ordinal, f.kind])).toEqual([[16, "outline"]]);
    expect(s.model?.requests).toHaveLength(2); // one extract window, one planner call: structure made no model call
    // The planner is offered the outline as a capability but is never shown a heading.
    expect(JSON.stringify(s.model?.requests[1])).not.toContain("Zebra-Heading");
    expect(JSON.stringify(s.model?.requests[1])).not.toContain("Zebra-Secret-Report");
  });

  it("re-derives and replaces the structure facts on a re-run that skips extraction", async () => {
    const s = stack([PLAN], { structure: STRUCTURE_READER });
    s.hold(JSON.parse(FACTS).facts.map((f: object, i: number) => ({ ...f, ordinal: i })) as Fact[]);
    const rerun = visualizeExecutionId(s.ref.userId, s.ref.documentId, 2, 1);
    expect(await s.run(rerun)).toEqual({ outcome: "done" });
    expect(s.model?.requests).toHaveLength(1); // the planner only: no extraction
    expect(s.structured().map((f) => f.ordinal)).toEqual([16]); // re-derived on the re-plan path
  });

  it("still ends empty, not failed, for a document with neither facts nor structure when the planner emits nothing", async () => {
    const s = stack([JSON.stringify({ facts: [] }), EMPTY_PLAN]);
    expect(await s.run()).toEqual({ outcome: "empty" });
  });

  it("makes no structure and no write when the visuals role is off", async () => {
    const s = stack(null, { structure: STRUCTURE_READER });
    expect(await s.run()).toEqual({ outcome: "skipped" });
    expect(s.structured()).toEqual([]);
  });

  it("pins the 1.0.0 flow hash: any drift of the legacy definition strands in-flight executions", () => {
    // Recorded by every 1.0.0 execution before the deploy. If this changes, the legacy flow is no longer 1.0.0.
    expect(flowContentHash(visualizeDocumentFlow(undefined, { legacy: true }).definition)).toBe(
      "sha256:d8491324b75b1de1a597aa91646efaf15dec2dd3652ba6a4e7023a4f502266f6",
    );
  });

  it("keeps 1.0.0 beside 1.1.0: the same flow id, its own steps and its own flow hash", () => {
    const legacy = visualizeDocumentFlow(undefined, { legacy: true });
    const current = visualizeDocumentFlow();
    expect(legacy.definition.id).toBe(current.definition.id);
    expect(legacy.definition.version).toBe("1.0.0");
    expect(legacy.definition.steps.map((s) => s.id)).toEqual(
      LEGACY_VISUALIZE_STEPS.map((s) => s.id),
    );
    expect(legacy.definition.steps.map((s) => s.id)).toEqual([
      "visualize-extract",
      "visualize-load",
      "visualize-commit",
    ]);
    expect(flowHashMatches(flowContentHash(current.definition), legacy.definition)).toBe(false);
    expect(flowHashMatches(flowContentHash(legacy.definition), legacy.definition)).toBe(true);
  });

  it("finishes a run started on 1.0.0 on the legacy runner: no structure step, no structure fact", async () => {
    const s = stack([FACTS, PLAN], { legacy: true, structure: STRUCTURE_READER });
    expect(await s.run()).toEqual({ outcome: "done" });
    expect(s.held().map((f) => f.ordinal)).toEqual([0]);
    expect(s.structured()).toEqual([]);
    const log = await s.inner.read(s.executionId);
    // `start()` records the hash of the CURRENT registered version of the id (1.1.0) whichever flow object it is given, so the
    // recorded hash of this simulated run is not asserted: a real 1.0.0 run recorded the 1.0.0 hash before the deploy. What
    // is pinned here is that the legacy runner never asks for the structure step.
    const steps = log
      .filter((e) => e.eventType === "STEP_STARTED")
      .map((e) => (e.payload as { stepId: string }).stepId);
    expect(steps).toContain("visualize-extract");
    expect(steps).not.toContain("visualize-structure");
  });

  it("a run started on 1.1.0 records the 1.1.0 hash and the structure step", async () => {
    const s = stack([FACTS, PLAN], { structure: STRUCTURE_READER });
    expect(await s.run()).toEqual({ outcome: "done" });
    const log = await s.inner.read(s.executionId);
    const started = log.find((e) => e.eventType === "EXECUTION_STARTED");
    const recorded = (started?.payload as { flowHash: string }).flowHash;
    expect(flowHashMatches(recorded, visualizeDocumentFlow().definition)).toBe(true);
    expect(
      flowHashMatches(recorded, visualizeDocumentFlow(undefined, { legacy: true }).definition),
    ).toBe(false);
    const steps = log
      .filter((e) => e.eventType === "STEP_STARTED")
      .map((e) => (e.payload as { stepId: string }).stepId);
    expect(steps).toContain("visualize-structure");
  });
});

describe("visualize-document flow: the model is unavailable", () => {
  const down = () => new LlmUnavailableError(503);

  it("ends failed with visuals-model-unavailable when the extract model stays down through every attempt (not a thrown failure)", async () => {
    const provider = failingAfter([], down);
    const s = stack(null, { provider });
    expect(await s.run()).toEqual({ outcome: "failed", code: "visuals-model-unavailable" });
    expect(provider.requests).toHaveLength(LLM_RETRY.maxAttempts);
    expect(await s.lineage.head(experienceIdOf(s.ref))).toEqual({ ok: true, value: null });
  });

  it("ends failed with visuals-model-unavailable when the planner's model stays down (facts are stored first)", async () => {
    const provider = failingAfter([FACTS], down);
    const s = stack(null, { provider });
    expect(await s.run()).toEqual({ outcome: "failed", code: "visuals-model-unavailable" });
    expect(s.held()).toHaveLength(1); // the facts survive for the re-run
    expect(await s.lineage.head(experienceIdOf(s.ref))).toEqual({ ok: true, value: null });
  });

  it("a permanent model error is not 'unavailable': the execution still fails", async () => {
    const provider = failingAfter([], () => new LlmRequestError(400));
    const s = stack(null, { provider });
    await expect(s.run()).rejects.toThrow();
  });

  it("a planner that gives a malformed plan (not a model failure) stays visuals-plan-invalid", async () => {
    const s = stack([FACTS, "not json", "not json", "not json"]);
    expect(await s.run()).toEqual({ outcome: "failed", code: "visuals-plan-invalid" });
  });

  it("the outcome and code are all the event log keeps of the failure (no message, no content)", async () => {
    const s = stack(null, { provider: failingAfter([], down) });
    await s.run();
    const end = (await s.inner.read(s.executionId)).find(
      (e) => e.eventType === "EXECUTION_COMPLETED",
    );
    expect((end?.payload as { output: unknown }).output).toEqual({
      outcome: "failed",
      code: "visuals-model-unavailable",
    });
  });
});

describe("visualize-document flow: a re-run", () => {
  const rerunId = (s: ReturnType<typeof stack>) =>
    visualizeExecutionId(s.ref.userId, s.ref.documentId, 2, 1);

  it("re-plans over the stored facts without asking the model for facts again", async () => {
    const s = stack([FACTS, PLAN]);
    expect(await s.run()).toEqual({ outcome: "done" });
    expect(s.model?.requests).toHaveLength(2);
    expect(await s.run(rerunId(s))).toEqual({ outcome: "done" });
    expect(s.model?.requests).toHaveLength(3); // one more planner call only
    expect(JSON.stringify(s.model?.requests.at(-1))).not.toContain("You extract facts");
  });

  it("extracts when the document has no stored facts", async () => {
    const s = stack([FACTS, PLAN]);
    expect(await s.run(rerunId(s))).toEqual({ outcome: "done" });
    expect(s.model?.requests).toHaveLength(2); // extract window, planner
    expect(s.held()).toHaveLength(1);
  });

  it("a first run (no -r suffix) always extracts, even over stored facts", async () => {
    const s = stack([FACTS, PLAN]);
    s.hold([{ kind: "figure", label: "Old", value: 1, chunkIds: [CHUNK], ordinal: 0 } as Fact]);
    await s.run();
    expect(s.model?.requests).toHaveLength(2);
  });

  it("recovers from the failure that caused it: the model is back", async () => {
    const down = failingAfter([FACTS], () => new LlmUnavailableError(503));
    const s = stack(null, { provider: down });
    expect(await s.run()).toEqual({ outcome: "failed", code: "visuals-model-unavailable" });
    // Same facts held; the next run's planner call answers.
    const back = scripted([PLAN]);
    const s2 = stack(null, { provider: back });
    s2.hold(s.held());
    expect(await s2.run(rerunId(s2))).toEqual({ outcome: "done" });
    expect(back.requests).toHaveLength(1);
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
    expect(isVisualizeExecution(visualizeExecutionId(s.ref.userId, s.ref.documentId, 1, 3))).toBe(
      true,
    );
    expect(isIngestExecution(visualizeExecutionId(s.ref.userId, s.ref.documentId, 1, 3))).toBe(
      false,
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
