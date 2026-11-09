import { randomUUID } from "node:crypto";
import { createViews } from "@docmind/experiences";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { InMemoryContentStore } from "@loom/plugin-content";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { ExecutionAlreadyExistsError } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatBus, type LiveChatEvent } from "../../chats/bus";
import { buildApp } from "../../config";
import { SENSITIVE_EVENT_PATHS } from "../../sensitive";
import { subjectOfExecution } from "../../subject";
import type { Fact } from "../visualize-document/facts";
import { visualsLineage } from "../visualize-document/lineage";
import { visualsPlanner } from "../visualize-document/planner";
import { childrenOf } from "../visualize-document/testing";
import type { TurnVisualizeDeps } from "./deps";
import { TURN_STEPS, TurnOutput, visualizeTurnFlow } from "./flow";
import { turnExecutionId, turnExperienceId } from "./ids";
import { TURN_RETRY } from "./model";
import type { TurnRead } from "./readTurn";

const LABEL = "Zebra-Secret-Revenue";
const SUMMARY = "Zebra-Secret-Summary-Text";
const DOC = randomUUID();
const CHUNK = randomUUID();
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const stored: Fact = {
  kind: "figure",
  label: LABEL,
  value: 4242,
  unit: "USD",
  chunkIds: [CHUNK],
  ordinal: 0,
};
const EXTRACTED = JSON.stringify({
  facts: [{ kind: "figure", label: LABEL, value: 4242, unit: "USD", chunkIds: [CHUNK] }],
});
const node = (capability: string) => ({
  id: "revenue",
  type: "KeyFigure",
  label: LABEL,
  span: 4,
  props: {},
  binding: { capability, arguments: {}, path: "value", priority: "P0" },
});
const plan = (capability = "fact-0") =>
  JSON.stringify({ summary: SUMMARY, nodes: [node(capability)] });
const CITED: TurnRead = {
  status: "complete",
  retrieved: [CHUNK],
  citations: [{ passageId: CHUNK, documentId: DOC }],
};

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
afterEach(async () => void (await Promise.all(apps.splice(0).map((a) => a.close()))));

function stack(o: {
  replies: string[];
  turn?: TurnRead | null;
  storedFacts?: Fact[];
  rerun?: number;
  key?: Uint8Array;
  ref?: { tenantId: string; userId: string; chatId: string; ord: number };
}) {
  const inner = new InMemoryAsyncEventStore();
  const sealed = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
    sensitive: { ...SENSITIVE_EVENT_PATHS },
    subjectOf: subjectOfExecution,
  });
  const lineage = new Lineage({
    events: new InMemoryLineageStore(),
    content: new InMemoryContentStore(),
  });
  const frames: [string, LiveChatEvent][] = [];
  const model = scripted(o.replies);
  const planner = visualsPlanner(model.llm, o.key ?? KEY);
  let held: Fact[] = [];
  const deps: TurnVisualizeDeps = {
    guard: { begin: async () => {} },
    turn: { read: async () => (o.turn === undefined ? CITED : o.turn) },
    stored: { list: async () => o.storedFacts ?? [] },
    turnFacts: {
      list: async () => held,
      replace: async (_r, facts) => {
        held = [...facts];
        return facts.length;
      },
    },
    passages: {
      read: async (_s, ids) =>
        new Map(ids.map((i) => [i, { text: `${LABEL} was 4242 USD last year.` }])),
    },
    summaryMaxChars: 400_000,
    lineage,
    bus: { publish: (c, e) => void frames.push([c, e]) },
    now: () => "2026-11-08T10:00:00.000Z",
    sleep: async () => {},
    llm: model.llm,
    planner,
  };
  const app = buildApp(
    { kind: "custom", eventStore: sealed },
    { events: sealed },
    { visualizeTurn: { flow: visualizeTurnFlow(() => planner), deps } },
  );
  apps.push(app);
  const ref = o.ref ?? {
    tenantId: randomUUID(),
    userId: randomUUID(),
    chatId: randomUUID(),
    ord: 4,
  };
  const executionId = turnExecutionId(ref.userId, ref.chatId, ref.ord, o.rerun);
  const run = async (rerun?: number) => {
    const handle = await app.runtime.start(
      visualizeTurnFlow(() => planner),
      ref,
      {
        executionId:
          rerun === undefined
            ? executionId
            : turnExecutionId(ref.userId, ref.chatId, ref.ord, rerun),
        principal: { tenant: ref.tenantId, actor: ref.userId },
      },
    );
    return TurnOutput.parse((await handle.waitForCompletion()).variables._output);
  };
  return { inner, sealed, lineage, frames, model, ref, executionId, run, heldFacts: () => held };
}

describe("visualize-turn flow", () => {
  it("pins its identity: id, version, step ids and the retry policy of every step", () => {
    const flow = visualizeTurnFlow();
    expect(flow.definition.id).toBe("visualize-turn");
    expect(flow.definition.version).toBe("1.0.0");
    expect(TURN_STEPS.map((s) => s.id)).toEqual([
      "turn-load",
      "turn-extract",
      "turn-facts",
      "turn-commit",
    ]);
    for (const s of TURN_STEPS) expect(s.retry).toEqual(TURN_RETRY);
    expect(TURN_RETRY).toEqual({ maxAttempts: 3, backoffMs: 2_000, backoffMultiplier: 2 });
  });

  it("the commit step's schema refuses a 'visualized' input without ops, and accepts 'nothing' without them", () => {
    const commit = TURN_STEPS.find((s) => s.id === "turn-commit");
    const ref = { tenantId: randomUUID(), userId: randomUUID(), chatId: randomUUID(), ord: 2 };
    const schema = commit?.inputSchema as { safeParse(v: unknown): { success: boolean } };
    expect(schema.safeParse({ ...ref, outcome: "visualized" }).success).toBe(false);
    expect(schema.safeParse({ ...ref, outcome: "visualized", ops: [] }).success).toBe(true);
    expect(schema.safeParse({ ...ref, outcome: "nothing" }).success).toBe(true);
  });

  it("uses the stored facts that cover the citations: no extraction, one planner call, a head and a frame", async () => {
    const s = stack({ replies: [plan()], storedFacts: [stored] });
    expect(await s.run()).toEqual({ outcome: "visualized" });
    expect(s.model.requests).toHaveLength(1); // the planner only
    const latest = await s.lineage.resolveLatest(turnExperienceId(s.ref));
    expect(latest.ok && childrenOf(latest.value.root).map((c) => c.id)).toEqual(["revenue"]);
    expect(s.frames).toEqual([[s.ref.chatId, { kind: "visuals", ord: 4, outcome: "visualized" }]]);
  });

  it("drops a widget whose fact does not fit it after the decision; every widget dropped is nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const regions: Fact = {
      kind: "series",
      label: "Regions",
      points: [
        { x: "North", y: 1 },
        { x: "South", y: 2 },
      ],
      chunkIds: [CHUNK],
      ordinal: 1,
    };
    const bind = (id: string, type: string, capability: string) => ({
      ...node(capability),
      id,
      type,
      binding: { capability, arguments: {}, path: "label", priority: "P1" },
    });
    const some = stack({
      replies: [
        JSON.stringify({
          summary: SUMMARY,
          nodes: [bind("revenue", "KeyFigure", "fact-0"), bind("trend", "FigureTrend", "fact-1")],
        }),
      ],
      storedFacts: [stored, regions],
    });
    expect(await some.run()).toEqual({ outcome: "visualized" });
    const latest = await some.lineage.resolveLatest(turnExperienceId(some.ref));
    expect(latest.ok && childrenOf(latest.value.root).map((c) => c.id)).toEqual(["revenue"]);
    const none = stack({
      replies: [
        JSON.stringify({ summary: SUMMARY, nodes: [bind("trend", "FigureTrend", "fact-0")] }),
      ],
      storedFacts: [regions],
    });
    expect(await none.run()).toEqual({ outcome: "nothing" });
    expect(await none.lineage.head(turnExperienceId(none.ref))).toEqual({ ok: true, value: null });
    vi.restoreAllMocks();
  });

  it("extracts from the turn's chunks only when no stored fact covers them", async () => {
    const s = stack({ replies: [EXTRACTED, plan()], storedFacts: [] });
    expect(await s.run()).toEqual({ outcome: "visualized" });
    expect(s.model.requests).toHaveLength(2); // one extract window, one planner call
  });

  it("a re-run ending nothing keeps the head's facts: a turn that already has facts is re-planned, never re-extracted", async () => {
    const s = stack({
      replies: [EXTRACTED, plan(), JSON.stringify({ nodes: [] })],
      storedFacts: [],
    });
    expect(await s.run()).toEqual({ outcome: "visualized" });
    const before = s.heldFacts();
    expect(before).toHaveLength(1);
    expect(await s.run(1)).toEqual({ outcome: "nothing" });
    expect(s.heldFacts()).toEqual(before); // the head's `fact-0` still points at the same row
    const latest = await s.lineage.resolveLatest(turnExperienceId(s.ref));
    expect(latest.ok && childrenOf(latest.value.root).map((c) => c.id)).toEqual(["revenue"]);

    // ...and the kept head's widgets still hydrate, from the facts the re-run left in place
    if (!latest.ok) throw new Error("the head is gone");
    const views = createViews({ placeholderKey: "k".repeat(32), revisionKey: "r".repeat(32) });
    const turn = { chatId: s.ref.chatId, ord: s.ref.ord };
    const live = new Set<string>();
    const payload = views.turnPayload(turn, latest.value, live, "web");
    const experience = views.turnExperience(turn, latest.value, live);
    if (!payload || !experience) throw new Error("the head does not serve");
    const turnFacts = vi.fn(async () => s.heldFacts());
    const out = await views.hydrateExperience(
      experience,
      Object.keys(experience.providers).map((handle) => ({
        experienceId: payload.experienceId,
        versionHash: payload.versionHash,
        handle,
        params: {},
      })),
      {
        turnFacts,
        connections: async () => null,
        documents: async () => ({ items: [], truncated: false }),
        document: async () => null,
        content: async () => ({ items: [], more: false }),
        source: async () => null,
        chats: async () => [],
        visualFacts: async () => null,
      },
      s.ref.userId,
      "turn",
    );
    expect(turnFacts).toHaveBeenCalledWith(turn);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ state: "ready", value: { value: 4242 } });
  });

  it("is nothing for an uncited answer: no model call, no lineage head, and the nothing frame", async () => {
    const s = stack({ replies: [plan()], turn: { ...CITED, citations: [] } });
    expect(await s.run()).toEqual({ outcome: "nothing" });
    expect(s.model.requests).toHaveLength(0);
    expect(await s.lineage.head(turnExperienceId(s.ref))).toEqual({ ok: true, value: null });
    expect(s.frames).toEqual([[s.ref.chatId, { kind: "visuals", ord: 4, outcome: "nothing" }]]);
  });

  it("is nothing when the model finds no grounded fact or plans no widget", async () => {
    const none = stack({ replies: [JSON.stringify({ facts: [] })], storedFacts: [] });
    expect(await none.run()).toEqual({ outcome: "nothing" });
    const empty = stack({ replies: [JSON.stringify({ nodes: [] })], storedFacts: [stored] });
    expect(await empty.run()).toEqual({ outcome: "nothing" });
    expect(await empty.lineage.head(turnExperienceId(empty.ref))).toEqual({
      ok: true,
      value: null,
    }); // a real read of an absent line
  });

  it("announces 'nothing' for every run that ends nothing, automatic or on demand, and writes no head", async () => {
    for (const rerun of [undefined, 1]) {
      const s = stack({
        replies: [JSON.stringify({ nodes: [] })],
        storedFacts: [stored],
        ...(rerun && { rerun }),
      });
      expect(await s.run()).toEqual({ outcome: "nothing" });
      expect(s.frames).toEqual([[s.ref.chatId, { kind: "visuals", ord: 4, outcome: "nothing" }]]);
      expect(await s.lineage.head(turnExperienceId(s.ref))).toEqual({ ok: true, value: null });
    }
  });

  it("starting the same execution id again is refused by Loom and makes no model call (the hook's idempotency key)", async () => {
    const s = stack({ replies: [plan()], storedFacts: [stored] });
    await s.run();
    const before = s.model.requests.length;
    await expect(s.run()).rejects.toBeInstanceOf(ExecutionAlreadyExistsError);
    expect(s.model.requests.length).toBe(before);
  });

  it("holds no fact label, value or planner text unsealed in the raw log", async () => {
    const s = stack({ replies: [plan()], storedFacts: [stored] });
    await s.run();
    const raw = await s.inner.read(s.executionId);
    const text = JSON.stringify(raw);
    for (const secret of [LABEL, SUMMARY, "4242", "KeyFigure", "Zebra"])
      expect(text, secret).not.toContain(secret);
    expect(JSON.stringify(await s.sealed.read(s.executionId))).toContain(LABEL); // not vacuous
    expect(text).toContain(DOC); // the references (document id) stay readable: ids only
  });

  it("keys the planner's decision id with the deployment secret (R19): plaintext in the log, never the unkeyed hash", async () => {
    const ref = { tenantId: randomUUID(), userId: randomUUID(), chatId: randomUUID(), ord: 4 };
    const idsOf = async (key: Uint8Array) => {
      const s = stack({ replies: [plan()], storedFacts: [stored], key, ref });
      await s.run();
      const text = JSON.stringify(await s.inner.read(s.executionId));
      return text.match(/plan:compose:[A-Za-z0-9:]+/g) ?? [];
    };
    const a = await idsOf(KEY);
    const b = await idsOf(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
    expect(a.length).toBeGreaterThan(0); // the id reaches the log, so this is not vacuous
    expect(a.every((id) => /^plan:compose:k:[0-9a-f]{32}$/.test(id))).toBe(true);
    expect(b.every((id) => /^plan:compose:k:[0-9a-f]{32}$/.test(id))).toBe(true);
    expect(new Set(a).size).toBe(1);
    expect(a[0]).not.toBe(b[0]); // a different secret gives a different id for the same input
  });

  it("commits through sub-project 1's sealed lineage: an unsealed content store is refused before any write", () => {
    const events = new InMemoryAsyncEventStore();
    expect(() =>
      visualsLineage({
        events,
        content: new InMemoryContentStore(),
        keys: new InMemoryKeyStore(),
        subjectOf: subjectOfExecution,
      }),
    ).toThrow(/sealsContent/);
  });
});
