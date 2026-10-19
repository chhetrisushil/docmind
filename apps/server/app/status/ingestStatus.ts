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
import {
  INGEST_STATUS_MODEL,
  type IngestStatusState,
  type StatusView,
  UPLOADED,
  generationOf,
  ingestKeyOf,
  ingestScopeOf,
  ingestStatus,
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
  onError?(err: unknown): void;
}

// Class name only: the message of a database or fold error could carry anything.
const logClass = (err: unknown) =>
  console.error("ingest status failed", err instanceof Error ? err.constructor.name : typeof err);

export class IngestStatus {
  private readonly service: ReadModelService;
  private readonly report: (err: unknown) => void;

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

  /** `observability.onEvent`: synchronous and never throws; the fold is applied asynchronously (ADR 0132 D4). */
  onEvent = (event: EventEnvelope): void => {
    this.service.handleEvent(event);
  };

  /** One query for one page of documents, under the caller's tenant: absent documents are simply missing. */
  async forPage(
    identity: Identity,
    documentIds: readonly string[],
  ): Promise<Map<string, StatusView>> {
    const views = new Map<string, StatusView>();
    if (documentIds.length === 0) return views;
    const reader = this.o.readerFor(identity);
    if (reader.getFoldedByKey === undefined)
      throw new TypeError("the status reader store has no folded-state support");
    const best = new Map<string, number>();
    for (const row of foldedStates(await reader.getFoldedByKey(INGEST_STATUS_MODEL, documentIds))) {
      if (row.key === null) continue;
      const generation = generationOf(row.executionId);
      if (generation === undefined || generation < (best.get(row.key) ?? 0)) continue;
      best.set(row.key, generation);
      views.set(row.key, viewOf(row.state as IngestStatusState));
    }
    return views;
  }

  /**
   * The document a request just touched: fold its log tail first (one read of the log, ADR 0132 D8),
   * then read it like a page. A document with no row is `uploaded`.
   */
  async forDocument(identity: Identity, documentId: string): Promise<StatusView> {
    await this.service.getMany(
      INGEST_STATUS_MODEL,
      [ingestExecutionId(identity.userId, documentId)],
      {
        refreshFrom: [this.o.source],
      },
    );
    return (await this.forPage(identity, [documentId])).get(documentId) ?? UPLOADED;
  }

  /** Wait for every fold scheduled so far (shutdown, tests). */
  async close(): Promise<void> {
    await this.service.drain();
  }
}
