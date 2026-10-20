import { ChatScope } from "@docmind/contracts";
import type { PoolClient } from "pg";

/** The seal bind of `chat_sessions.title_enc` (spec 4.4). */
export const chatTitleBind = (id: string) => `chat:${id}:title`;

/** The folded read model of a chat's message count and last activity (Task 148 writes it). */
export const CHAT_ACTIVITY_MODEL = "chat-activity";

export interface ChatSessionRow {
  id: string;
  title_enc: unknown | null;
  title_source: "none" | "auto" | "user";
  scope: ChatScope;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

const COLUMNS = "id, title_enc, title_source, scope, created_at, updated_at, deleted_at";

/** A fixed message: a scope can name documents, and a driver or zod error would echo them. */
function checked<T extends { scope: unknown }>(row: T): T & { scope: ChatScope } {
  const scope = ChatScope.safeParse(row.scope);
  if (!scope.success) throw new Error("chat_sessions.scope is invalid");
  return { ...row, scope: scope.data };
}

/** Inserts a live chat with no title. `id` is a uuid the server minted (D1). */
export async function insertChat(
  tx: PoolClient,
  tenantId: string,
  userId: string,
  id: string,
  scope: ChatScope,
): Promise<ChatSessionRow> {
  const { rows } = await tx.query<ChatSessionRow>(
    `INSERT INTO chat_sessions (id, tenant_id, user_id, scope) VALUES ($1, $2, $3, $4::jsonb)
     RETURNING ${COLUMNS}`,
    [id, tenantId, userId, JSON.stringify(scope)],
  );
  return checked(rows[0] as ChatSessionRow);
}

/** The owner's live chat; a deleted, foreign or unknown id is `null`, all alike. */
export async function getChat(
  tx: PoolClient,
  userId: string,
  id: string,
): Promise<ChatSessionRow | null> {
  const { rows } = await tx.query<ChatSessionRow>(
    `SELECT ${COLUMNS} FROM chat_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return rows[0] ? checked(rows[0]) : null;
}

/** Marks the owner's live chat deleted. The row and its items stay until erasure (D15). */
export async function softDeleteChat(tx: PoolClient, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE chat_sessions SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}
