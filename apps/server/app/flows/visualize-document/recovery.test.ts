import { randomUUID } from "node:crypto";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import { COMPOSE_SYSTEM } from "@loom-ui/planner";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { InMemoryContentStore } from "@loom/plugin-content";
import { afterEach, describe, expect, it } from "vitest";
import { recoveryOwns } from "../../bootIngest";
import { chatConversationId } from "../../chats/ids";
import { buildApp } from "../../config";
import { ingestExecutionId } from "../../documents/ingest";
import { InMemoryProgressBus } from "../../documents/progress";
import { foldIngestStatus } from "../../status/model";
import { startRecovery } from "../ingest-document/recovery";
import type { VisualizeDeps } from "./deps";
import type { Fact } from "./facts";
import { visualizeDocumentFlow } from "./flow";
import { experienceIdOf } from "./lineage";
import { visualsPlanner } from "./planner";
import { visualizeExecutionId } from "./start";
import { childrenOf } from "./testing";

const CHUNK = randomUUID();
const FACTS = JSON.stringify({
  facts: [{ kind: "figure", label: "Revenue", value: 4242, chunkIds: [CHUNK] }],
});
const PLAN = JSON.stringify({
  summary: "Revenue at a glance",
  nodes: [
    {
      id: "revenue",
      type: "KeyFigure",
      label: "Revenue",
      span: 4,
      props: {},
      binding: { capability: "fact-0", arguments: {}, path: "value", priority: "P0" },
    },
  ],
});
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const llm = (): LlmProvider & { model: string } => {
  return {
    model: "claude-test",
    // The planner's request carries its own system prompt; anything else is an extract window.
    complete: async (r: LlmRequest) => ({
      content: r.system?.startsWith(COMPOSE_SYSTEM.slice(0, 40)) ? PLAN : FACTS,
      stopReason: "end_turn",
    }),
  };
};

/** The log outlives each app, as it does across restarts. */
const keptLog = () => {
  const store = new InMemoryAsyncEventStore();
  const kept = new Proxy(store, {
    get: (target, prop) => {
      if (prop === "close") return async () => {};
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store, kept };
};

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

describe("recovering an interrupted visualize execution", () => {
  const lineage = new Lineage({
    events: new InMemoryLineageStore(),
    content: new InMemoryContentStore(),
  });
  let held: Fact[] = []; // the fact table outlives the process, like the database
  const boot = (log: ReturnType<typeof keptLog>, over: Partial<VisualizeDeps>) => {
    const provider = llm();
    const planner = visualsPlanner(provider, KEY);
    const deps: VisualizeDeps = {
      guard: { begin: async () => {} },
      chunks: {
        sectionsOf: async () => [{ id: CHUNK, sectionOrdinal: 0 }],
        read: async () => [{ id: CHUNK, text: "Revenue was 4242 last year." }],
      },
      facts: {
        replace: async (_r, f) => {
          held = [...f];
          return f.length;
        },
        list: async () => held,
      },
      bus: new InMemoryProgressBus(),
      lineage,
      now: () => "2026-11-08T10:00:00.000Z",
      sleep: async () => {},
      llm: provider,
      planner,
      ...over,
    };
    const app = buildApp({ kind: "custom", eventStore: log.kept }, undefined, {
      visualize: { flow: visualizeDocumentFlow(() => planner), deps },
    });
    apps.push(app);
    return app;
  };

  it("startRecovery with the boot `owns` resumes it to completion, committing the plan once", async () => {
    const log = keptLog();
    const ref = { tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() };
    const executionId = visualizeExecutionId(ref.userId, ref.documentId, 2);
    // First process: the load step never settles (a crash mid-step).
    let entered: () => void = () => {};
    const inStep = new Promise<void>((r) => {
      entered = r;
    });
    const first = boot(log, {
      guard: {
        begin: async (_r, step) => {
          if (step === "visualize-load") {
            entered();
            await new Promise<never>(() => {});
          }
        },
      },
    });
    await first.runtime.start(visualizeDocumentFlow(), ref, {
      executionId,
      principal: { tenant: ref.tenantId, actor: ref.userId },
    });
    await inStep;
    // Second process on the same log: recovery re-drives it.
    const second = boot(log, {});
    const recovery = startRecovery(second.runtime, log.kept, { owns: recoveryOwns });
    await recovery.idle();
    recovery.stop();
    const state = await second.runtime.loadState(executionId, {
      principal: { tenant: ref.tenantId, actor: ref.userId },
    });
    expect(state?.status).toBe("completed");
    expect(state?.variables._output).toEqual({ outcome: "done" });
    const latest = await lineage.resolveLatest(experienceIdOf(ref));
    expect(latest.ok && childrenOf(latest.value.root).map((c) => c.id)).toEqual(["revenue"]);
    // The visualize events moved no ingest status.
    expect(foldIngestStatus(await log.store.read(executionId))).toEqual({});
  });

  it("the boot recovery owns ingest, visualize and chat executions, and nothing else", () => {
    const u = randomUUID();
    const d = randomUUID();
    expect(recoveryOwns(ingestExecutionId(u, d, 2))).toBe(true);
    expect(recoveryOwns(visualizeExecutionId(u, d, 1))).toBe(true);
    expect(recoveryOwns(visualizeExecutionId(u, d, 7))).toBe(true);
    expect(recoveryOwns(chatConversationId(u, d))).toBe(true);
    expect(recoveryOwns(`u_${u}:visualize-not-a-uuid`)).toBe(false);
    expect(recoveryOwns(`u_${u}:erasure-${d}`)).toBe(false);
  });
});
