import type { Identity } from "@docmind/auth";
import type { EventEnvelope } from "@loom/core";
import {
  type ReadModelEventSource,
  ReadModelService,
  type ReadModelStore,
  type SensitiveMap,
  foldedStates,
} from "@loom/plugin-read-model";
import { ingestExecutionId } from "../documents/ingest";
import type { ProgressBus } from "../documents/progress";
import {
  INGEST_STATUS_MODEL,
  type IngestStatusState,
  type StatusView,
  UPLOADED,
  generationOf,
  ingestKeyOf,
  ingestScopeOf,
  ingestStatus,
  progressOf,
  viewOf,
} from "./model";

export interface IngestStatusOptions {
  /** Registers, folds, refreshes, purges: the Loom role's store (every tenant's rows). */
  writer: ReadModelStore;
  /** A read-only store for one caller; in production every query runs inside that caller's tenant transaction. */
  readerFor(identity: Identity): ReadModelStore;
  /** The decrypting event store: the live source for holes and the source of boot's catch-up. */
  source: ReadModelEventSource;
  /** `sensitivePathsFromSteps(...)` unioned with `sensitiveMapFromCovers(...)`, computed after `defineConfig` (R4). */
  sensitive: SensitiveMap;
  /** Progress events leave here, after the fold has applied. */
  bus: ProgressBus;
  onError?(err: unknown): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Class name only: the message of a database or fold error could carry anything.
const logClass = (err: unknown) =>
  console.error("ingest status failed", err instanceof Error ? err.constructor.name : typeof err);

/** What the document routes need from the status model. */
export interface DocumentStatusReads {
  forPage(identity: Identity, documentIds: readonly string[]): Promise<Map<string, StatusView>>;
  forDocument(identity: Identity, documentId: string): Promise<StatusView>;
  /** The document is being deleted: tombstone its rows (call after the delete commits and the flow is cancelled). */
  forgetDocument(identity: Identity, documentId: string): Promise<void>;
}

export class IngestStatus implements DocumentStatusReads {
  private readonly service: ReadModelService;
  private readonly report: (err: unknown) => void;
  private publishing: Promise<void> = Promise.resolve();

  constructor(private readonly o: IngestStatusOptions) {
    this.report = o.onError ?? logClass;
    this.service = new ReadModelService(o.writer, {
      liveSource: o.source,
      sensitive: o.sensitive,
      onError: (err) => this.report(err),
    });
  }

  /** Register (a changed version or sensitive map rebuilds), then catch up. Throws on a poison event: do not serve. */
  async boot(): Promise<{ rebuilt: boolean; executionsScanned: number }> {
    const { rebuilt } = await this.service.registerFolded({
      projection: ingestStatus,
      keyOf: ingestKeyOf,
      scopeOf: ingestScopeOf,
    });
    const { executionsScanned } = await this.service.catchUp([this.o.source]);
    return { rebuilt, executionsScanned };
  }

  /**
   * `observability.onEvent`: synchronous and never throws. Folds the event (asynchronously), then
   * publishes its progress event on one chain after `drain()`, in log order. The event is a hint: it
   * follows the fold when the fold applied, and is still published if the fold failed (the error goes
   * to `onError`); a refetch may then briefly read the older status until catch-up heals the row.
   * The publish userId comes from the execution id, never from client input.
   */
  onEvent = (event: EventEnvelope): void => {
    this.service.handleEvent(event);
    const derived = progressOf(event);
    if (derived === null) return;
    this.publishing = this.publishing
      .then(() => this.service.drain())
      .then(() => this.o.bus.publish({ userId: derived.userId }, derived.progress))
      .catch((err) => this.report(err));
  };

  /** One query for one page of documents, under the caller's tenant: absent documents are simply missing. */
  async forPage(
    identity: Identity,
    documentIds: readonly string[],
  ): Promise<Map<string, StatusView>> {
    const views = new Map<string, StatusView>();
    if (documentIds.length === 0) return views;
    // Stored keys are lowercase (routes lowercase ids too); answer under the caller's spelling.
    const spelled = new Map<string, string[]>();
    for (const id of documentIds) {
      const key = id.toLowerCase();
      spelled.set(key, [...(spelled.get(key) ?? []), id]);
    }
    const reader = this.o.readerFor(identity);
    if (reader.getFoldedByKey === undefined)
      throw new TypeError("the status reader store has no folded-state support");
    const best = new Map<string, number>();
    for (const row of foldedStates(
      await reader.getFoldedByKey(INGEST_STATUS_MODEL, [...spelled.keys()]),
    )) {
      // Reader RLS is tenant-wide: owner scoping happens here (scope is the user id).
      if (row.key === null || ingestScopeOf(row.executionId) !== identity.userId) continue;
      const generation = generationOf(row.executionId);
      // Highest generation wins (generation 1 is the bare id; `.1` is never emitted, Task 74b ruling).
      if (generation === undefined || generation < (best.get(row.key) ?? 0)) continue;
      const callers = spelled.get(row.key);
      if (callers === undefined) continue;
      best.set(row.key, generation);
      const view = viewOf(row.state as IngestStatusState);
      for (const caller of callers) views.set(caller, view);
    }
    return views;
  }

  /**
   * The document a request just touched: fold its log tail first (one read of the log, ADR 0132 D8),
   * then read it like a page. A document with no row is `uploaded`.
   */
  async forDocument(identity: Identity, documentId: string): Promise<StatusView> {
    // The writer refreshes (read-repair by execution id: a document with no row has no key to find); the reader reads.
    await this.service.refresh(
      INGEST_STATUS_MODEL,
      [ingestExecutionId(identity.userId, documentId)],
      [this.o.source],
    );
    return (await this.forPage(identity, [documentId])).get(documentId) ?? UPLOADED;
  }

  /**
   * Erasure of one document's rows (every generation), owner-scoped: the rows are read through the
   * caller's tenant reader, only the caller's own are kept, and each is purged by execution id. A
   * purge by key would tombstone every tenant's rows under the writer's cross-tenant policy.
   * A tombstone keeps the sequence, execution id and scope (ids, not state) and nulls the state.
   */
  async forgetDocument(identity: Identity, documentId: string): Promise<void> {
    const reader = this.o.readerFor(identity);
    if (reader.getFoldedByKey === undefined)
      throw new TypeError("the status reader store has no folded-state support");
    const rows = await reader.getFoldedByKey(INGEST_STATUS_MODEL, [documentId.toLowerCase()]);
    for (const row of rows) {
      if (ingestScopeOf(row.executionId) !== identity.userId) continue;
      await this.service.purgeFolded(INGEST_STATUS_MODEL, { executionId: row.executionId });
    }
  }

  /** User erasure, after rows, blobs and key: the table has no foreign key to `users`, so nothing cascades. */
  forgetUser(userId: string): Promise<number> {
    const scope = userId.toLowerCase();
    if (!UUID.test(scope)) throw new TypeError("forgetUser: userId must be a uuid");
    return this.service.purgeFolded(INGEST_STATUS_MODEL, { scope });
  }

  /** Wait for every fold scheduled so far (shutdown, tests). Callers close the event feed first: events fed afterwards are not awaited. */
  async close(): Promise<void> {
    await this.publishing;
    await this.service.drain();
  }
}
