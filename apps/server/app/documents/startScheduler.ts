import type { Identity } from "@docmind/auth";
import type { IngestPort } from "./ingest";

/**
 * Starts ingest executions without making the upload wait for Loom's event store. A failed start is
 * logged by class and route only; the stale-upload sweep restarts it. `idle()` lets tests and
 * shutdown wait for everything fired so far (and anything fired while waiting); `settle()` lets a
 * delete wait for one document's pending start so a cancel never runs before the start lands.
 */
export class StartScheduler {
  private readonly pending = new Set<Promise<void>>();
  // Keyed by user and lower-cased document id (the same normalisation as `ingestStartInput`).
  // The key is never logged.
  // Executions the port started that have not finished yet (their completion promises never reject).
  private readonly running = new Set<Promise<void>>();
  private readonly byDocument = new Map<string, Set<Promise<void>>>();
  constructor(private readonly port: IngestPort) {}

  private static key(identity: Identity, documentId: string): string {
    return `${identity.userId}:${documentId.toLowerCase()}`;
  }

  /** `label` names who fired the start in the failure log (a route, or the sweep); never an id. */
  fire(
    identity: Identity,
    documentId: string,
    generation: number,
    label = "POST /api/documents",
  ): void {
    const key = StartScheduler.key(identity, documentId);
    const run = (async () => {
      try {
        const handle = await this.port.start(identity, documentId, generation);
        if (handle) {
          const done: Promise<void> = handle
            .waitForCompletion()
            .then(
              () => undefined,
              () => undefined,
            )
            .finally(() => this.running.delete(done));
          this.running.add(done);
        }
      } catch (err) {
        console.error(
          "ingest start failed",
          err instanceof Error ? err.constructor.name : typeof err,
          label,
        );
      }
    })();
    this.pending.add(run);
    const runs = this.byDocument.get(key) ?? new Set<Promise<void>>();
    this.byDocument.set(key, runs);
    runs.add(run);
    void run.finally(() => {
      this.pending.delete(run);
      runs.delete(run);
      if (runs.size === 0 && this.byDocument.get(key) === runs) this.byDocument.delete(key);
    });
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** Resolves once every execution started so far has finished, whatever its outcome (a backfill script waits on this). */
  async finished(): Promise<void> {
    await this.idle();
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  /** Resolves once this document's pending start (if any) has finished, successfully or not. Never rejects. */
  async settle(identity: Identity, documentId: string): Promise<void> {
    const runs = this.byDocument.get(StartScheduler.key(identity, documentId));
    if (runs) await Promise.all([...runs]); // each run catches its own error, so none rejects
  }
}
