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

/** Rows per call of `docmind_erasure_pending`; the function allows up to 1000. */
export const ERASURE_PAGE = 500;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * The erasure requests on Postgres (migration 0024), connected as docmind_app. The table is reachable only through the
 * insert policy (inside a tenant transaction) and the definer functions (`docmind_erasure_pending(state, after, limit)` pages by user id and serves `pending()` and `erased()`,
 * `docmind_erasure_status(hash)` serves `status()`); nothing here reads or writes it directly but the insert. Every
 * statement carries ids, step names and a receipt hash only.
 */
export class PgErasureStore implements ErasureStore {
  constructor(
    private readonly pool: Pool,
    private readonly pageSize = ERASURE_PAGE,
  ) {}

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

  /** Every request in `state`, one page at a time, ordered by user id; a page shorter than `pageSize` is the last. */
  private async *pages(state: ErasureState): AsyncGenerator<Row[]> {
    let after = NIL_UUID;
    for (;;) {
      const { rows } = await this.pool.query<Row>(
        "SELECT user_id, tenant_id, state, steps, attempts FROM public.docmind_erasure_pending($1, $2, $3)",
        [state, after, this.pageSize],
      );
      if (rows.length === 0) return;
      yield rows;
      if (rows.length < this.pageSize) return;
      after = (rows[rows.length - 1] as Row).user_id;
    }
  }

  async pending(): Promise<ErasureRequest[]> {
    const out: ErasureRequest[] = [];
    for await (const rows of this.pages("pending")) out.push(...rows.map(toRequest));
    return out;
  }

  async erased(): Promise<string[]> {
    const out: string[] = [];
    for await (const rows of this.pages("done")) out.push(...rows.map((r) => r.user_id));
    return out;
  }

  async get(userId: string): Promise<ErasureRequest | null> {
    for await (const rows of this.pages("pending")) {
      const hit = rows.find((r) => r.user_id === userId);
      if (hit) return toRequest(hit);
      // Pages ascend by user id (uuid order is the byte order of its lowercase hex text), so once a page passes the id it is absent.
      if (rows.some((r) => r.user_id > userId)) return null;
    }
    return null;
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
