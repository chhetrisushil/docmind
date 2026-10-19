import { randomUUID } from "node:crypto";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  EncryptingEventStore,
  InMemoryKeyStore,
  sensitivePathsFromSteps,
} from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../config";
import { ingestDocumentFlow } from "../flows/ingest-document/flow";
import { SENSITIVE_EVENT_PATHS } from "../sensitive";
import { subjectOfExecution } from "../subject";
import { isIngestExecution } from "./model";
import { flowSteps, statusSensitive } from "./wire";

describe("the status model's sensitive map", () => {
  it("includes the framework-sealed paths that only the encrypting store knows after defineConfig, which the steps alone miss", async () => {
    const events = new EncryptingEventStore(new InMemoryAsyncEventStore(), new InMemoryKeyStore(), {
      sensitive: { ...SENSITIVE_EVENT_PATHS },
      subjectOf: subjectOfExecution,
    });
    const app = buildApp({ kind: "custom", eventStore: events }, { events });
    expect(sensitivePathsFromSteps(flowSteps()).EXECUTION_STARTED).toBeUndefined();
    expect(statusSensitive(flowSteps(), events).EXECUTION_STARTED).toEqual(
      expect.arrayContaining([
        "principal.identity.actor",
        "principal.identity.onBehalfOf",
        "principal.identity.tenant",
      ]),
    );
    await app.close();
  });

  it("is the steps' map alone when the store seals nothing", () => {
    expect(statusSensitive(flowSteps(), {})).toEqual(sensitivePathsFromSteps(flowSteps()));
  });
});

describe("flows and retention", () => {
  it("lists the steps of every registered flow, so a new flow's sensitive outputs reach the model", () => {
    expect(flowSteps().map((s) => s.id)).toEqual(
      ingestDocumentFlow.definition.steps.map((s) => s.id),
    );
  });

  it("recognises every generation of an ingest execution, and nothing else", () => {
    const [u, d] = [randomUUID(), randomUUID()];
    expect(
      [`u_${u}:ingest-${d}`, `u_${u}:ingest-${d}.2`, `u_${u}:chat-${d}`].map(isIngestExecution),
    ).toEqual([true, true, false]);
  });

  // The wiring itself (F20): Loom's `lifecycle.compact` consults the config's `compactionExempt`.
  it("keeps an ingest execution's whole log through compaction while compacting another flow's", async () => {
    const [u, d] = [randomUUID(), randomUUID()];
    const app = buildApp({ kind: "memory" });
    const log = app.stores.eventStore;
    const ingestId = `u_${u}:ingest-${d}.2`;
    const chatId = `u_${u}:chat-${d}`;
    for (const executionId of [ingestId, chatId]) {
      for (let sequence = 0; sequence < 4; sequence++) {
        await log.append({
          id: `${executionId}-${sequence}`,
          workflowId: "wf",
          executionId,
          eventType: sequence === 0 ? "EXECUTION_STARTED" : "STEP_STARTED",
          sequence,
          timestamp: sequence,
          payload: { input: {} },
        });
      }
    }
    expect(await app.lifecycle.compact(ingestId)).toBeNull(); // exempt: nothing reclaimed
    expect(await log.read(ingestId)).toHaveLength(4);
    expect(await app.lifecycle.compact(chatId)).not.toBeNull(); // the control: compaction does run here
    await app.close();
  });
});
