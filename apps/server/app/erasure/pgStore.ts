import type { Pool } from "pg";
import {
  type ErasureRequest,
  type ErasureState,
  type ErasureStep,
  type ErasureStore,
  type Queryable,
  isErasureStep,
} from "./types";

interface Row {
  user_id: string;
  tenant_id: string;
  state: "pending" | "done";
  steps: string[];
  attempts: number;
}

const toRequest = (r: Row): ErasureRequest => ({
  userId: r.user_id,
  tenantId: r.tenant_id,
  state: r.state,
  steps: r.steps.filter(isErasureStep),
  attempts: r.attempts,
});

/**
 * The erasure requests on Postgres (migration 0024), connected as docmind_app. The table is reachable only through the
 * insert policy (inside a tenant transaction) and the definer functions (`docmind_erasure_pending(state)` serves both `pending()` and `erased()`,
 * `docmind_erasure_status(hash)` serves `status()`); nothing here reads or writes it directly but the insert. Every
 * statement carries ids, step names and a receipt hash only.
 */
export class PgErasureStore implements ErasureStore {
  constructor(private readonly pool: Pool) {}

  async insert(
    tx: Queryable,
    userId: string,
    tenantId: string,
    receiptHash: Buffer,
  ): Promise<boolean> {
    // No conflict target: DO NOTHING needs the INSERT privilege only (the app role cannot SELECT the table).
    const result = (await tx.query(
      "INSERT INTO public.erasure_requests (user_id, tenant_id, receipt_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [userId, tenantId, receiptHash],
    )) as { rowCount?: number | null } | undefined;
    return result?.rowCount === 1;
  }

  async status(receiptHash: Buffer): Promise<ErasureState | null> {
    const { rows } = await this.pool.query<{ state: string | null }>(
      "SELECT public.docmind_erasure_status($1) AS state",
      [receiptHash],
    );
    const state = rows[0]?.state;
    return state === "pending" || state === "done" ? state : null;
  }

  // pending() and erased() are capped at 1000 rows by docmind_erasure_pending (no fifth definer function is wanted), and
  // get() scans pending(); so with more than 1000 pending requests get() can answer null for a request that exists.
  // Far beyond v1 scale.
  async pending(): Promise<ErasureRequest[]> {
    const { rows } = await this.pool.query<Row>(
      "SELECT user_id, tenant_id, state, steps, attempts FROM public.docmind_erasure_pending($1)",
      ["pending"],
    );
    return rows.map(toRequest);
  }

  async erased(): Promise<string[]> {
    const { rows } = await this.pool.query<Pick<Row, "user_id">>(
      "SELECT user_id FROM public.docmind_erasure_pending($1)",
      ["done"],
    );
    return rows.map((r) => r.user_id);
  }

  async get(userId: string): Promise<ErasureRequest | null> {
    return (await this.pending()).find((r) => r.userId === userId) ?? null;
  }

  async mark(userId: string, step: ErasureStep): Promise<void> {
    const { rows } = await this.pool.query<{ found: boolean }>(
      "SELECT public.docmind_erasure_mark($1, $2, $3) AS found",
      [userId, step, step === "done"],
    );
    if (!rows[0]?.found) throw new Error("no such erasure request");
  }

  async retried(userId: string): Promise<void> {
    const { rows } = await this.pool.query<{ found: boolean }>(
      "SELECT public.docmind_erasure_mark($1, 'retry', false) AS found",
      [userId],
    );
    if (!rows[0]?.found) throw new Error("no such erasure request");
  }
}
