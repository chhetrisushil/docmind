import type { Pool } from "pg";
import { withTenant } from "../db/tenant";
import type { ReasoningRows } from "./reasoningStore";
import type { ChatRef } from "./turnItems";

/**
 * `chat_reasoning_texts` rows: every statement runs in `withTenant` and names the owner and the chat, and the
 * composite foreign key makes a row of a chat that is not the writer's own impossible.
 */
export class PgReasoningRows implements ReasoningRows {
  constructor(private readonly pool: Pool) {}

  async put(ref: ChatRef, address: string, sealed: unknown): Promise<void> {
    await withTenant(this.pool, ref.tenantId, (tx) =>
      tx.query(
        `INSERT INTO chat_reasoning_texts (tenant_id, user_id, chat_id, address, text_enc)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [ref.tenantId, ref.userId, ref.chatId, address, JSON.stringify(sealed)],
      ),
    );
  }

  async get(ref: ChatRef, address: string): Promise<unknown | null> {
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const res = await tx.query<{ text_enc: unknown }>(
        `SELECT text_enc FROM chat_reasoning_texts
          WHERE chat_id = $1 AND user_id = $2 AND address = $3`,
        [ref.chatId, ref.userId, address],
      );
      return res.rows;
    });
    return rows[0]?.text_enc ?? null;
  }
}
