import type { EventEnvelope } from "@loom/core";
import {
  type DecoratorPlan,
  type EventStore,
  type OptionalEventStoreMethod,
  installOptional,
} from "@loom/event-runtime";

/**
 * The decision under which Loom's conversation records the trimmed rolling summary (`conv#o<ord>:summary-fit`,
 * `@loom/conversation`). Its `choice` is the summary STRING, which no sealed path can reach without also sealing
 * every conversation record's `choice` (spec: docs/specs/2026-11-03-chat-rolling-summary-design.md §4).
 */
export const SUMMARY_FIT_DECISION = /^conv#o[1-9][0-9]{0,8}:summary-fit$/;
const MARK = "docmindSummary";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function summaryFitPayload(e: EventEnvelope): Record<string, unknown> | undefined {
  if (e.eventType !== "DECISION_RECORDED" || !isRecord(e.payload)) return undefined;
  const id = e.payload.decisionId;
  return typeof id === "string" && SUMMARY_FIT_DECISION.test(id) ? e.payload : undefined;
}

/** Write side: a summary-fit string choice becomes `{ docmindSummary: 1, text }`, so `choice.text` is sealed. */
export function sealableSummaryChoice(e: EventEnvelope): EventEnvelope {
  const p = summaryFitPayload(e);
  if (p === undefined || typeof p.choice !== "string") return e;
  return { ...e, payload: { ...p, choice: { [MARK]: 1, text: p.choice } } };
}

/** Read side: exactly `{ docmindSummary: 1, text: string }` on a summary-fit decision becomes the string again. */
export function restoredSummaryChoice(e: EventEnvelope): EventEnvelope {
  const p = summaryFitPayload(e);
  if (p === undefined || !isRecord(p.choice)) return e;
  const c = p.choice;
  const keys = Object.keys(c);
  if (keys.length !== 2 || c[MARK] !== 1 || typeof c.text !== "string") return e;
  return { ...e, payload: { ...p, choice: c.text } };
}

const restoreAll = (events: EventEnvelope[]): EventEnvelope[] => events.map(restoredSummaryChoice);

/**
 * Sits above the sealing event store (`EncryptingEventStore`) and hands Loom the summary-fit decision as Loom wrote it,
 * while the store below seals its text. Every optional SPI method is decided here (a new one is a compile error), and the
 * properties `defineConfig` reads by shape off `storage.eventStore` to seal the inbox archive and senders are carried
 * up: without them the archive would be written in plaintext, silently.
 */
export class SummaryChoiceEventStore implements EventStore {
  readonly appendBatch?: NonNullable<EventStore["appendBatch"]>;
  readonly head?: NonNullable<EventStore["head"]>;
  readonly readRange?: NonNullable<EventStore["readRange"]>;
  readonly acquireFence?: NonNullable<EventStore["acquireFence"]>;
  readonly acquireFenceIf?: NonNullable<EventStore["acquireFenceIf"]>;
  readonly appendIfUnchanged?: NonNullable<EventStore["appendIfUnchanged"]>;
  readonly storeNow?: NonNullable<EventStore["storeNow"]>;
  readonly sealingCapability?: NonNullable<EventStore["sealingCapability"]>;
  readonly readAtRest?: NonNullable<EventStore["readAtRest"]>;
  readonly copyPrefix?: NonNullable<EventStore["copyPrefix"]>;
  readonly deleteExecution?: NonNullable<EventStore["deleteExecution"]>;
  readonly deleteThrough?: NonNullable<EventStore["deleteThrough"]>;
  readonly truncatePrefix?: NonNullable<EventStore["truncatePrefix"]>;
  readonly truncatePrefixKeeping?: NonNullable<EventStore["truncatePrefixKeeping"]>;
  readonly listExecutions?: NonNullable<EventStore["listExecutions"]>;
  readonly listExecutionsPage?: NonNullable<EventStore["listExecutionsPage"]>;
  /** `EncryptingEventStore`'s, carried up (read by shape by `defineConfig`'s archive and sender sealing). */
  readonly subjectOf?: unknown;
  readonly senderSubjectOf?: unknown;

  constructor(private readonly inner: EventStore) {
    const plan = {
      // biome-ignore lint/style/noNonNullAssertion: installOptional installs this entry only when the inner store has the method
      appendBatch: (envs) => inner.appendBatch!(envs.map(sealableSummaryChoice)),
      head: "forward",
      // biome-ignore lint/style/noNonNullAssertion: installOptional installs this entry only when the inner store has the method
      readRange: async (id, from, to) => restoreAll(await inner.readRange!(id, from, to)),
      acquireFence: "forward",
      acquireFenceIf: "forward",
      appendIfUnchanged: (id, event, expect) =>
        // biome-ignore lint/style/noNonNullAssertion: installOptional installs this entry only when the inner store has the method
        inner.appendIfUnchanged!(id, event === null ? null : sealableSummaryChoice(event), expect),
      storeNow: "forward",
      sealingCapability: "forward",
      // The at-rest view is the envelopes AS STORED, never decrypted: it shows the object form, on purpose.
      readAtRest: "forward",
      // A fork copies stored rows inside the inner store: the object form travels with them and is restored on read.
      copyPrefix: "forward",
      deleteExecution: "forward",
      deleteThrough: "forward",
      truncatePrefix: "forward",
      truncatePrefixKeeping: "forward",
      listExecutions: "forward",
      listExecutionsPage: "forward",
    } satisfies DecoratorPlan<EventStore, OptionalEventStoreMethod>;
    installOptional<EventStore, OptionalEventStoreMethod>(this, inner, plan);
    const shape = inner as { subjectOf?: unknown; senderSubjectOf?: unknown };
    if (shape.subjectOf !== undefined) this.subjectOf = shape.subjectOf;
    if (shape.senderSubjectOf !== undefined) this.senderSubjectOf = shape.senderSubjectOf;
  }

  append(envelope: EventEnvelope): Promise<void> {
    return this.inner.append(sealableSummaryChoice(envelope));
  }

  async read(executionId: string): Promise<EventEnvelope[]> {
    return restoreAll(await this.inner.read(executionId));
  }

  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    return restoreAll(await this.inner.readFrom(executionId, fromSequence));
  }

  subscribe(executionId: string, handler: (event: EventEnvelope) => void): Promise<() => void> {
    return this.inner.subscribe(executionId, (e) => handler(restoredSummaryChoice(e)));
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
