import type { Pool } from "pg";
import { FieldKeyUnavailableError } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import type { HandleStore } from "./opaqueIds";

/**
 * `users.id_handle` (migration 0038) on the app role. `read` and `claim` run under the user's tenant (row-level security), and every
 * statement names the user and the tenant. The cross-tenant lookups go through two SECURITY DEFINER functions: the app role cannot
 * read other tenants' users.
 */
/** A failure of the store, with the fixed message and only the pg code: a unique violation's detail names the handle, so it never travels. */
function storeError(err: unknown): Error {
  if (err instanceof FieldKeyUnavailableError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  return Object.assign(new Error("the id handle store failed"), {
    ...(typeof code === "string" ? { code } : {}),
  });
}
const safe = <T>(call: () => Promise<T>): Promise<T> =>
  call().catch((err) => Promise.reject(storeError(err)));

export class PgHandleStore implements HandleStore {
  constructor(private readonly pool: Pool) {}

  private async readRaw(who: { tenantId: string; userId: string }): Promise<string | null> {
    return withTenant(this.pool, who.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id_handle: string | null }>(
        "SELECT id_handle FROM users WHERE id = $1 AND tenant_id = $2",
        [who.userId, who.tenantId],
      );
      return rows[0]?.id_handle ?? null;
    });
  }

  /**
   * One statement settles a race: the first UPDATE sets the handle, a concurrent one finds `id_handle` set, updates nothing and reads
   * the stored value (the unique constraint is the backstop for a handle that two users derived). A user who is erasing, or gone, has
   * no handle to claim: the key is about to be, or already is, destroyed.
   */
  private async claimRaw(
    who: { tenantId: string; userId: string },
    handle: string,
  ): Promise<string> {
    return withTenant(this.pool, who.tenantId, async (tx) => {
      const set = await tx.query<{ id_handle: string }>(
        `UPDATE users SET id_handle = $1
          WHERE id = $2 AND tenant_id = $3 AND id_handle IS NULL AND erasing_at IS NULL
          RETURNING id_handle`,
        [handle, who.userId, who.tenantId],
      );
      if (set.rows[0]) return set.rows[0].id_handle;
      const { rows } = await tx.query<{ id_handle: string | null }>(
        "SELECT id_handle FROM users WHERE id = $1 AND tenant_id = $2",
        [who.userId, who.tenantId],
      );
      const stored = rows[0]?.id_handle;
      if (!stored) throw new FieldKeyUnavailableError();
      return stored;
    });
  }

  private async userOfRaw(handle: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string | null }>(
      "SELECT public.docmind_user_of_handle($1) AS id",
      [handle],
    );
    return rows[0]?.id ?? null;
  }

  private async pageRaw(
    after: string,
    limit: number,
  ): Promise<{ userId: string; handle: string }[]> {
    const { rows } = await this.pool.query<{ id: string; id_handle: string }>(
      "SELECT id, id_handle FROM public.docmind_user_handles($1::uuid, $2::integer)",
      [after, limit],
    );
    return rows.map((r) => ({ userId: r.id, handle: r.id_handle }));
  }

  read(who: { tenantId: string; userId: string }) {
    return safe(() => this.readRaw(who));
  }
  claim(who: { tenantId: string; userId: string }, handle: string) {
    return safe(() => this.claimRaw(who, handle));
  }
  userOf(handle: string) {
    return safe(() => this.userOfRaw(handle));
  }
  page(after: string, limit: number) {
    return safe(() => this.pageRaw(after, limit));
  }
}
