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

export type ChatListRow = ChatSessionRow & {
  messages: number;
  last_at: Date | null;
  sort_at: Date;
  /** `sort_at` to the microsecond, UTC: the `t` of the next page's cursor (JS dates stop at the millisecond). */
  sort_cursor: string;
};

/**
 * The owner's live chats, newest activity first: `COALESCE(last_at, created_at) DESC, id DESC`.
 * Activity (message count, last time) comes from the `chat-activity` folded model; a chat with no
 * row yet (nothing folded) counts 0 messages and sorts by its creation time. A chat that rotated
 * has one row per generation: counts add up, the last time is the latest.
 * Returns at most `page.limit` rows; the route asks for one more to learn whether a page follows.
 */
export async function listChats(
  tx: PoolClient,
  userId: string,
  page: { cursor?: { t: string; i: string }; limit: number },
): Promise<ChatListRow[]> {
  const { rows } = await tx.query<ChatListRow>(
    `SELECT c.id, c.title_enc, c.title_source, c.scope, c.created_at, c.updated_at, c.deleted_at,
            COALESCE(a.messages, 0)::int AS messages, a.last_at,
            COALESCE(a.last_at, c.created_at) AS sort_at,
            to_char(COALESCE(a.last_at, c.created_at) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_cursor
       FROM chat_sessions c
       LEFT JOIN LATERAL (
         SELECT sum((s.state ->> 'messages')::int)::int AS messages,
                max((s.state ->> 'lastAt')::timestamptz) AS last_at
           FROM read_model_state s
          WHERE s.model_id = $5 AND s.app_key = c.id::text AND s.scope = c.user_id::text
            AND NOT s.erased AND s.state IS NOT NULL) a ON true
      WHERE c.user_id = $1 AND c.deleted_at IS NULL
        AND ($2::timestamptz IS NULL OR (COALESCE(a.last_at, c.created_at), c.id) < ($2::timestamptz, $3::uuid))
      ORDER BY sort_at DESC, c.id DESC
      LIMIT $4`,
    [userId, page.cursor?.t ?? null, page.cursor?.i ?? null, page.limit, CHAT_ACTIVITY_MODEL],
  );
  return rows.map(checked);
}

/**
 * Sets the sealed title. `"auto"` writes only while the title was never set (a rename by the user
 * always wins); `"user"` always writes. False when the chat is not the owner's live chat or the
 * auto title lost.
 */
export async function setTitle(
  tx: PoolClient,
  userId: string,
  id: string,
  titleEnc: unknown,
  source: "auto" | "user",
): Promise<boolean> {
  if (typeof titleEnc !== "object" || titleEnc === null || Array.isArray(titleEnc)) {
    throw new Error("chat_sessions.title_enc must be a sealed object");
  }
  const { rowCount } = await tx.query(
    `UPDATE chat_sessions SET title_enc = $3::jsonb, title_source = $4, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        AND ($4 = 'user' OR title_source = 'none')`,
    [id, userId, JSON.stringify(titleEnc), source],
  );
  return (rowCount ?? 0) > 0;
}

export async function setScope(
  tx: PoolClient,
  userId: string,
  id: string,
  scope: ChatScope,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE chat_sessions SET scope = $3::jsonb, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId, JSON.stringify(scope)],
  );
  return (rowCount ?? 0) > 0;
}
