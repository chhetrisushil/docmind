import type { Pool } from "pg";
import { guardLookup } from "../guardLookup";
import type { StepGuard } from "../ingest-document/stepEffect";
import { TurnGoneError } from "./errors";
import type { TurnRef } from "./ids";

/**
 * Called first by every turn step: the chat must still be its owner's and live (not soft-deleted), and its owner must
 * not be being erased (`users.erasing_at`). Otherwise the step ends as "gone" (`TurnGoneError`, logged with the shared outcome word `document_gone`) and writes nothing. A failure is
 * rethrown with a fixed message.
 */
export class PgTurnGuard implements StepGuard<TurnRef> {
  constructor(private readonly pool: Pool) {}

  async begin({ tenantId, userId, chatId }: TurnRef, _step?: string): Promise<void> {
    const live = await guardLookup(
      this.pool,
      tenantId,
      async (tx) => {
        const { rows } = await tx.query(
          `SELECT 1 FROM chat_sessions c JOIN users u ON u.id = c.user_id AND u.erasing_at IS NULL
            WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL`,
          [chatId, userId],
        );
        return rows.length > 0;
      },
      "chat existence check failed",
    );
    if (!live) throw new TurnGoneError();
  }
}
