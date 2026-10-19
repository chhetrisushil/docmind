import { createFairScheduler } from "@loom/fair-scheduler";
import { IngestAbortedError } from "./errors";

interface Lane {
  active: number;
  waiters: { wake: () => void }[];
}

/**
 * Ingest work shares the process fairly between tenants (spec 5.2 "Scaling", M3b D10). A run first
 * takes one of its tenant's `tenantConcurrency` slots (FIFO per tenant), then one of the process's
 * `concurrency` slots, handed out round-robin across tenants by Loom's fair scheduler. The tenant slot
 * comes first, so a tenant at its own cap never sits on a process slot while it waits. In memory and
 * per process: v1 runs one server per database (spec 5.2). Tenant ids are never logged.
 */
export class IngestGate {
  private readonly fair: ReturnType<typeof createFairScheduler>;
  private readonly lanes = new Map<string, Lane>();
  private queued = 0;
  private running = 0;

  constructor(private readonly limits: { concurrency: number; tenantConcurrency: number }) {
    this.fair = createFairScheduler({ concurrency: limits.concurrency });
  }

  get waiting(): number {
    return this.queued;
  }
  get active(): number {
    return this.running;
  }

  async run<T>(
    tenantId: string,
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new IngestAbortedError();
    await this.acquire(tenantId, signal);
    let started = false;
    try {
      return await this.fair.schedule(
        async () => {
          started = true;
          this.running++;
          try {
            return await task();
          } finally {
            this.running--;
          }
        },
        { tenant: tenantId, ...(signal && { signal }) },
      );
    } catch (err) {
      // The fair scheduler rejects a queued task with the signal's reason; callers see one class.
      // A task that started before the abort keeps its own error.
      if (signal?.aborted && !started) throw new IngestAbortedError();
      throw err;
    } finally {
      this.release(tenantId);
    }
  }

  private acquire(tenantId: string, signal?: AbortSignal): Promise<void> {
    const lane = this.lanes.get(tenantId) ?? { active: 0, waiters: [] };
    this.lanes.set(tenantId, lane);
    if (lane.active < this.limits.tenantConcurrency) {
      lane.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        wake: () => {
          signal?.removeEventListener("abort", onAbort);
          this.queued--;
          lane.active++;
          resolve();
        },
      };
      const onAbort = () => {
        const i = lane.waiters.indexOf(waiter);
        if (i >= 0) lane.waiters.splice(i, 1);
        this.queued--;
        this.dropIfIdle(tenantId, lane);
        reject(new IngestAbortedError());
      };
      this.queued++;
      lane.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(tenantId: string): void {
    const lane = this.lanes.get(tenantId);
    if (!lane) return;
    lane.active--;
    const next = lane.waiters.shift();
    if (next) next.wake();
    else this.dropIfIdle(tenantId, lane);
  }

  private dropIfIdle(tenantId: string, lane: Lane): void {
    if (lane.active === 0 && lane.waiters.length === 0) this.lanes.delete(tenantId);
  }
}
