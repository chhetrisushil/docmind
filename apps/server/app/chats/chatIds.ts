import type { Pool } from "pg";
import { withTenant } from "../db/tenant";
import { type UserIdSource, existingUser } from "../documents/executionCandidates";
import {
  type ChatConversationId,
  type UserExecutionId,
  type UserIds,
  legacyIds,
} from "../opaqueIds";
import { legacyChatConversationId } from "./ids";
import type { ChatRef } from "./turnItems";

/** The id format of one chat (`chat_sessions.id_format`, migration 0039): fixed when the chat is created. */
export type ChatIdFormat = "legacy" | "opaque";

export interface ChatOwner {
  tenantId: string;
  userId: string;
}

/**
 * Every Loom id one chat has, in the chat's own format. All four come from one format, so a chat never mixes them: its conversation (and its
 * generations `~n`, which Loom derives from this id), its title execution, a turn's visuals execution and that turn's lineage line.
 */
export interface ChatIdBuilders {
  readonly format: ChatIdFormat;
  conversationId(): ChatConversationId;
  titleExecutionId(): UserExecutionId;
  /** `rerun` makes `-r<n>`, an on-demand run (1 to 999). */
  turnExecutionId(ord: number, rerun?: number): UserExecutionId;
  turnExperienceId(ord: number): string;
}

export interface ChatIdResolver {
  /** The builders of a chat the caller has loaded (its row carries the format). Null: an opaque chat whose owner has no live id key (erased, or never given one). Never mints. */
  forRow(
    who: ChatOwner,
    chat: { id: string; id_format: ChatIdFormat },
  ): Promise<ChatIdBuilders | null>;
  /** The builders of a chat the caller only has a reference to: reads the format. Null when the chat row is not found for this owner (a cached answer may outlive a deleted row for one process), or as `forRow`. Never mints. */
  forRef(ref: ChatRef): Promise<ChatIdBuilders | null>;
  /** The builders of a chat about to be created: always the new format, minting the user's key and handle on their first use. A key-store outage throws. */
  forNew(who: ChatOwner, chatId: string): Promise<ChatIdBuilders>;
  /** Drops everything remembered about a user's chats (the eraser calls it after the shred, so a cached answer cannot outlive the user's rows). Never throws. */
  forgetUser(userId: string): void;
}

export const legacyBuilders = (userId: string, chatId: string): ChatIdBuilders => ({
  format: "legacy",
  conversationId: () => legacyChatConversationId(userId, chatId),
  titleExecutionId: () => legacyIds.chatTitle(userId, chatId),
  turnExecutionId: (ord, rerun) => legacyIds.turnVisualize(userId, chatId, ord, rerun),
  turnExperienceId: (ord) => legacyIds.turnLineage(userId, chatId, ord),
});

export const opaqueBuilders = (user: UserIds, chatId: string): ChatIdBuilders => ({
  format: "opaque",
  conversationId: () => user.conversation(chatId),
  titleExecutionId: () => user.chatTitle(chatId),
  turnExecutionId: (ord, rerun) => user.turnVisualize(chatId, ord, rerun),
  turnExperienceId: (ord) => user.turnLineage(chatId, ord),
});

const FORMAT_CACHE_MAX = 5000;

/**
 * The Postgres resolver. A chat's format never changes, so a found format is cached (bounded, oldest first out), keyed by tenant, user and
 * chat; a missing chat is never cached. The cache holds ids of people, so `forgetUser` evicts a user's entries when they are erased.
 */
export class PgChatIds implements ChatIdResolver {
  private readonly formats = new Map<string, ChatIdFormat>();
  /** Bumped by every `forgetUser`: a `forRef` read in flight across one does not cache what it read (it may be the erased user's). */
  private forgets = 0;

  constructor(
    private readonly pool: Pool,
    private readonly ids: UserIdSource,
  ) {}

  /** `tenant:user:chat` (UUIDs hold no colon, so `forgetUser` can read the user back from the key). */
  private key(ref: { tenantId: string; userId: string }, chatId: string): string {
    return `${ref.tenantId}:${ref.userId}:${chatId}`;
  }

  private remember(key: string, format: ChatIdFormat): void {
    this.formats.delete(key);
    if (this.formats.size >= FORMAT_CACHE_MAX) {
      const oldest = this.formats.keys().next().value;
      if (oldest !== undefined) this.formats.delete(oldest);
    }
    this.formats.set(key, format);
  }

  private async build(
    who: ChatOwner,
    chatId: string,
    format: ChatIdFormat,
  ): Promise<ChatIdBuilders | null> {
    if (format === "legacy") return legacyBuilders(who.userId, chatId);
    const user = await existingUser(this.ids, who);
    return user ? opaqueBuilders(user, chatId) : null;
  }

  /** `chat` must come from an owner-scoped read (`loadChat`, under RLS). Not cached: the row may predate an erasure's `forgetUser` (only `forRef`, guarded, fills the cache). */
  async forRow(
    who: ChatOwner,
    chat: { id: string; id_format: ChatIdFormat },
  ): Promise<ChatIdBuilders | null> {
    return this.build(who, chat.id, chat.id_format);
  }

  async forRef(ref: ChatRef): Promise<ChatIdBuilders | null> {
    const key = this.key(ref, ref.chatId);
    let format = this.formats.get(key);
    if (format === undefined) {
      const forgets = this.forgets;
      const row = await withTenant(
        this.pool,
        ref.tenantId,
        async (tx) =>
          (
            await tx.query<{ id_format: ChatIdFormat }>(
              "SELECT id_format FROM chat_sessions WHERE id = $1 AND user_id = $2",
              [ref.chatId, ref.userId],
            )
          ).rows[0],
      );
      if (!row) return null;
      format = row.id_format;
      if (forgets === this.forgets) this.remember(key, format);
    }
    return this.build(ref, ref.chatId, format);
  }

  async forNew(who: ChatOwner, chatId: string): Promise<ChatIdBuilders> {
    return opaqueBuilders(await this.ids.ensureUser(who), chatId);
  }

  forgetUser(userId: string): void {
    this.forgets++;
    for (const key of [...this.formats.keys()])
      if (key.split(":")[1] === userId) this.formats.delete(key);
  }
}
