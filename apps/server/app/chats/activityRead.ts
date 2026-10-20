import type { PoolClient } from "pg";
import { CHAT_ACTIVITY_MODEL } from "./sessions";

/**
 * One chat's folded activity, summed over its conversation generations (one row each), the same arithmetic as
 * `listChats`: lastAt is stored as epoch-ms + 0.5 (Task 148). The owner filter is the `scope` (the user id);
 * an erased or tombstoned row counts nothing.
 */
export async function chatActivityOf(
  tx: PoolClient,
  userId: string,
  chatId: string,
): Promise<{ messages: number; last_at: Date | null }> {
  const { rows } = await tx.query<{ messages: number; last_at: Date | null }>(
    `SELECT COALESCE(sum((state ->> 'messages')::int), 0)::int AS messages,
            max(to_timestamp(((state ->> 'lastAt')::double precision - 0.5) / 1000)) AS last_at
       FROM read_model_state
      WHERE model_id = $1 AND app_key = $2 AND scope = $3 AND NOT erased AND state IS NOT NULL`,
    [CHAT_ACTIVITY_MODEL, chatId, userId],
  );
  return rows[0] ?? { messages: 0, last_at: null };
}
