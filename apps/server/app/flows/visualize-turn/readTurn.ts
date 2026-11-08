import type { ConversationReader, HistoryEntry } from "@loom/conversation";
import type { Pool } from "pg";
import { citeReply, documentTitles } from "../../chats/citations";
import { chatConversationId } from "../../chats/ids";
import { turnKeyOfRecord } from "../../chats/scope";
import type { PgTurnItems, StoredPassage } from "../../chats/turnItems";
import type { FieldCrypto } from "../../crypto/fields";
import type { TurnRef } from "./ids";

export interface TurnReadDeps {
  /** The decrypting reader of the conversation log (`createConversationReader(eventStore)`); it does not authorize: the ref comes from the execution. */
  reader: Pick<ConversationReader, "read">;
  items: Pick<PgTurnItems, "forTurns">;
  pool: Pool;
  fields: FieldCrypto;
  /** Test seam: current titles of the user's documents among the ids (default: the real lookup). */
  titlesOf?: (ids: string[]) => Promise<Map<string, string>>;
}

export interface TurnRead {
  status: "complete" | "interrupted" | "failed";
  /** Chunk ids of the turn's retrieved passages, in retrieval order, deduplicated. */
  retrieved: string[];
  /** What `citeReply` leaves, in citation order, for documents the user still owns. */
  citations: { passageId: string; documentId: string }[];
}

const PAGE = 30;
const MAX_PAGES = 40;

/** The assistant record with this `ord`, found by scanning backward from the tail; null when there is none. */
async function findReply(
  deps: TurnReadDeps,
  ref: TurnRef,
  signal?: AbortSignal,
): Promise<HistoryEntry | null> {
  const conversationId = chatConversationId(ref.userId, ref.chatId);
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await deps.reader.read(conversationId, {
      direction: "backward",
      limit: PAGE,
      ...(cursor !== undefined && { cursor }),
      ...(signal && { signal }),
    });
    for (const e of res.entries) {
      if (e.ord === ref.ord) return e.role === "assistant" && e.turn >= 1 ? e : null;
    }
    // Backward: once a page reaches records older than the wanted ord, it is not here.
    const oldest = res.entries.at(-1)?.ord;
    if (res.done || res.nextCursor === undefined || (oldest !== undefined && oldest < ref.ord))
      return null;
    cursor = res.nextCursor;
  }
  return null;
}

/** The settled turn's status, retrieved chunks and kept citations. Reads content; returns ids only. */
export async function readTurn(
  deps: TurnReadDeps,
  ref: TurnRef,
  signal?: AbortSignal,
): Promise<TurnRead | null> {
  const reply = await findReply(deps, ref, signal);
  if (
    !reply ||
    (reply.status !== "complete" && reply.status !== "interrupted" && reply.status !== "failed")
  )
    return null;
  const turnKey = turnKeyOfRecord({
    role: "assistant",
    ord: reply.ord as number,
    turn: reply.turn,
  });
  const items = (await deps.items.forTurns(ref, [turnKey])).get(turnKey) ?? [];
  const passages: StoredPassage[] = items.flatMap((i) =>
    i.kind === "passages" ? i.body.passages : [],
  );
  const retrieved = [...new Set(passages.map((p) => p.passageId))];
  const documentIds = [...new Set(passages.map((p) => p.documentId))];
  const titles = await (deps.titlesOf
    ? deps.titlesOf(documentIds)
    : documentTitles(
        deps.pool,
        deps.fields,
        { tenantId: ref.tenantId, userId: ref.userId },
        documentIds,
      ));
  const cited = citeReply(reply.text, passages, titles);
  return {
    status: reply.status,
    retrieved,
    // A document missing from `titles` was deleted (or is not the user's): its citation does not count.
    citations: cited.citations
      .filter((c) => titles.has(c.documentId))
      .map((c) => ({ passageId: c.passageId, documentId: c.documentId })),
  };
}
