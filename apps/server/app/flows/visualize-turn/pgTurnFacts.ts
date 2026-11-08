import { randomUUID } from "node:crypto";
import { ParseAbortedError } from "@docmind/parsers";
import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { type Fact, StoredFact } from "../visualize-document/facts";
import type { TurnRef } from "./ids";

export interface TurnFactStore {
  /** Replaces the turn's facts in one transaction; returns the rows written. */
  replace(ref: TurnRef, facts: readonly Fact[], signal?: AbortSignal): Promise<number>;
  /** The turn's facts in ordinal order (owner-scoped; none for a turn that is not the caller's). */
  list(ref: TurnRef): Promise<Fact[]>;
}

export const turnFactBind = (id: string) => `turnfact:${id}`;

export class PgTurnVisualFacts implements TurnFactStore {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  async replace(ref: TurnRef, facts: readonly Fact[], signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) throw new ParseAbortedError(); // nothing sealed, nothing written
    // Sealing may call the key store: do it before the transaction, never under row locks.
    const cipher = this.fields.forUser(ref.userId);
    const rows = await Promise.all(
      facts.map(async (f) => {
        const id = randomUUID();
        return {
          id,
          ordinal: f.ordinal,
          chunkIds: f.chunkIds,
          sealed: JSON.stringify(await cipher.seal(turnFactBind(id), f)),
        };
      }),
    );
    if (signal?.aborted) throw new ParseAbortedError(); // aborted while sealing: no transaction
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      if (signal?.aborted) throw new ParseAbortedError();
      await tx.query(
        "DELETE FROM turn_visual_facts WHERE chat_id = $1 AND user_id = $2 AND ord = $3",
        [ref.chatId, ref.userId, ref.ord],
      );
      for (const r of rows) {
        // The composite foreign key refuses a chat that is not this user's (or is gone): the insert throws.
        await tx.query(
          `INSERT INTO turn_visual_facts (id, tenant_id, user_id, chat_id, ord, ordinal, fact_enc, chunk_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::uuid[])`,
          [r.id, ref.tenantId, ref.userId, ref.chatId, ref.ord, r.ordinal, r.sealed, r.chunkIds],
        );
      }
      if (signal?.aborted) throw new ParseAbortedError();
    });
    return rows.length;
  }

  async list(ref: TurnRef): Promise<Fact[]> {
    const res = await withTenant(this.pool, ref.tenantId, (tx) =>
      tx.query<{ id: string; fact_enc: unknown }>(
        "SELECT id, fact_enc FROM turn_visual_facts WHERE chat_id = $1 AND user_id = $2 AND ord = $3 ORDER BY ordinal",
        [ref.chatId, ref.userId, ref.ord],
      ),
    );
    const cipher = this.fields.forUser(ref.userId);
    return Promise.all(
      res.rows.map(async (r) => {
        const parsed = StoredFact.safeParse(await cipher.open(turnFactBind(r.id), r.fact_enc));
        if (!parsed.success) throw new Error("turn visual fact has an unexpected shape");
        return parsed.data;
      }),
    );
  }
}
