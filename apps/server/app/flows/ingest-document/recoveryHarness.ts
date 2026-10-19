import { randomUUID } from "node:crypto";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { buildApp } from "../../config";
import { ingestExecutionId } from "../../documents/ingest";
import type { IngestDeps } from "./deps";
import { type IngestStartInput, ingestDocumentFlow } from "./flow";
import { fakeIngestDeps } from "./testing";

export const input = (): IngestStartInput => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  documentId: randomUUID(),
});
/** The log outlives each app, as it does across restarts (app.close() would drop an in-memory store). */
export const keptLog = () => {
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
export type Log = ReturnType<typeof keptLog>;
export const boot = (log: Log, deps: IngestDeps) =>
  buildApp({ kind: "custom", eventStore: log.kept }, undefined, { ingest: deps });

/** A step that is interrupted for good: it signals `entered` and never settles (a crash mid-step). */
export const hanging = () => {
  let entered: () => void = () => {};
  const inStep = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const deps = fakeIngestDeps({
    guard: {
      begin: async () => {
        entered();
        await new Promise<never>(() => {});
      },
    },
  });
  return { deps, inStep };
};
export const start = (
  app: ReturnType<typeof boot>,
  ids: IngestStartInput,
  flow = ingestDocumentFlow,
) =>
  app.runtime.start(flow, ids, {
    executionId: ingestExecutionId(ids.userId, ids.documentId),
    principal: { tenant: ids.tenantId, actor: ids.userId },
  });
export const eventsOf = (log: Log, ids: IngestStartInput) =>
  log.store.read(ingestExecutionId(ids.userId, ids.documentId));
export const types = async (log: Log, ids: IngestStartInput) =>
  (await eventsOf(log, ids)).map((e) => e.eventType);
