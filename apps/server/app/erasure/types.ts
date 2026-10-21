/** The steps of an erasure, in the order the eraser runs them (D3). `done` is the last mark, and finishes the request. */
export const ERASURE_STEPS = [
  "stop",
  "shred",
  "readModels",
  "rows",
  "blobs",
  "key",
  "done",
] as const;
export type ErasureStep = (typeof ERASURE_STEPS)[number];

export const isErasureStep = (x: unknown): x is ErasureStep =>
  typeof x === "string" && (ERASURE_STEPS as readonly string[]).includes(x);

/** A durable erasure request: ids, the steps already finished, and a retry count. No email, no content. */
export interface ErasureRequest {
  userId: string;
  tenantId: string;
  state: "pending" | "done";
  steps: ErasureStep[];
  attempts: number;
}

/** Anything a statement can run on: a tenant transaction (`withTenant`'s client) or a test double. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export type ErasureState = ErasureRequest["state"];

export interface ErasureStore {
  /**
   * Inserts a pending request inside the caller's tenant transaction (the route's, with the session delete and the
   * email scrub). `receiptHash` is the sha256 of the receipt token (`receipt.ts`); the token itself never reaches the
   * store. Idempotent: a second insert for the user changes nothing, the first receipt stays. Resolves `true` when it
   * inserted and `false` when a request already existed (the route answers 409, as the receipt it minted was not stored).
   */
  insert(tx: Queryable, userId: string, tenantId: string, receiptHash: Buffer): Promise<boolean>;
  /** The state of the request a receipt hash belongs to (`docmind_erasure_status`), or `null` for none. Done stays answerable. */
  status(receiptHash: Buffer): Promise<ErasureState | null>;
  /** Every pending request across tenants, ordered by user id (the boot resume and the rescan). */
  pending(): Promise<ErasureRequest[]>;
  /** Records a finished step once; `done` also finishes the request. Throws when there is no such request. */
  mark(userId: string, step: ErasureStep): Promise<void>;
  /** Counts a failed attempt (the eraser's backoff loop). Throws when there is no pending request. */
  retried(userId: string): Promise<void>;
  /** The user's PENDING request, or `null` (none, or already done: a re-run is a no-op). */
  get(userId: string): Promise<ErasureRequest | null>;
  /** The user ids of the requests that are done, ordered by user id (the post-boot `forgetUser` re-run). Required. */
  erased(): Promise<string[]>;
}
