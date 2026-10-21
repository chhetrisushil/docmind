import type { ErasureWiring } from "./compliance";
import {
  ERASURE_STEPS,
  type ErasureRequest,
  type ErasureState,
  type ErasureStep,
  type ErasureStore,
  type Queryable,
} from "./types";

/**
 * A snapshot store with no snapshots, for tests whose event store is in memory. `shredSubject` refuses
 * to run over a store that can `truncatePrefix` without one, and only ever reads it.
 */
export const noSnapshots = {
  loadLatest: async () => null,
  loadLatestSealed: async () => null,
} as unknown as ErasureWiring["raw"]["snapshotStore"];

/** The request store without a database, with the same answers as `PgErasureStore` (Task 169's unit tests use it). */
export class MemoryErasureStore implements ErasureStore {
  private readonly requests = new Map<string, ErasureRequest>();
  private readonly completed = new Map<string, number>(); // user id -> completion sequence
  private readonly receipts = new Map<string, string>(); // receipt hash (hex) -> user id

  async insert(
    _tx: Queryable,
    userId: string,
    tenantId: string,
    receiptHash: Buffer,
  ): Promise<boolean> {
    if (this.requests.has(userId)) return false;
    this.requests.set(userId, { userId, tenantId, state: "pending", steps: [], attempts: 0 });
    this.receipts.set(receiptHash.toString("hex"), userId);
    return true;
  }

  async status(receiptHash: Buffer): Promise<ErasureState | null> {
    const userId = this.receipts.get(receiptHash.toString("hex"));
    return (userId && this.requests.get(userId)?.state) || null;
  }

  async pending(): Promise<ErasureRequest[]> {
    return [...this.requests.values()]
      .filter((r) => r.state === "pending")
      .map((r) => ({ ...r, steps: [...r.steps] }));
  }

  async get(userId: string): Promise<ErasureRequest | null> {
    return (await this.pending()).find((r) => r.userId === userId) ?? null;
  }

  /** Done requests, most recently completed first, at most 1000, like the definer function. */
  async erased(): Promise<string[]> {
    return [...this.requests.values()]
      .filter((r) => r.state === "done")
      .sort((a, b) => (this.completed.get(b.userId) ?? 0) - (this.completed.get(a.userId) ?? 0))
      .map((r) => r.userId)
      .slice(0, 1000);
  }

  async mark(userId: string, step: ErasureStep): Promise<void> {
    const request = this.requests.get(userId);
    if (!request) throw new Error("no such erasure request");
    if (request.state === "done" || request.steps.includes(step)) return; // a no-op, as in the definer function
    if (ERASURE_STEPS[request.steps.length] !== step) throw new Error("erasure step out of order");
    request.steps.push(step);
    if (step === "done") {
      request.state = "done";
      this.completed.set(userId, this.completed.size + 1);
    }
  }

  async retried(userId: string): Promise<void> {
    const request = this.requests.get(userId);
    if (!request || request.state !== "pending") throw new Error("no such erasure request");
    request.attempts += 1;
  }
}
