import type { Identity } from "@docmind/auth";
import type { ChatMessageDto } from "@docmind/contracts";
import type { Conversations, HistoryEntry } from "@loom/conversation";
import type { PrincipalChain } from "@loom/effect-runtime";
import { citeReply, documentTitles } from "./citations";
import { chatConversationId } from "./ids";
import type { ChatRouteDeps } from "./routes";
import { turnKeyOfRecord } from "./scope";
import type { StoredPassage, TurnItem } from "./turnItems";

/** Messages per history page (spec 6.1). */
export const HISTORY_PAGE = 30;
/** Calls to Loom's reader for one page: each scans a bounded number of events, so a busy log needs several. */
const MAX_ROUNDS = 20;

export type MessageDeps = Pick<ChatRouteDeps, "pool" | "fields" | "chat" | "reasoning">;

/** The turn key of a history entry (the `<o>` of its turn's step ids). Undefined without a record ordinal. */
export const turnKeyOf = (e: HistoryEntry): number | undefined =>
  e.ord === undefined ? undefined : turnKeyOfRecord({ role: e.role, ord: e.ord, turn: e.turn });

/**
 * Up to `limit` messages ending at `cursor` (newest first from Loom, returned oldest first). One call to the
 * reader can return fewer entries than asked with `done: false` (its scan budget ran out on model and tool events
 * between messages), so this keeps calling with the continuation until the page is full, the start is reached, or
 * MAX_ROUNDS calls were made. `nextCursor` continues toward older messages; `null` means the start was reached.
 */
export async function readHistoryPage(
  conversations: Pick<Conversations, "history">,
  conversationId: string,
  principal: PrincipalChain,
  cursor: string | undefined,
  limit: number,
): Promise<{ entries: HistoryEntry[]; nextCursor: string | null }> {
  const entries: HistoryEntry[] = [];
  let next = cursor;
  let done = false;
  for (let round = 0; round < MAX_ROUNDS && entries.length < limit && !done; round++) {
    const page = await conversations.history(conversationId, {
      principal,
      direction: "backward",
      limit: limit - entries.length,
      ...(next !== undefined && { cursor: next }),
    });
    entries.push(...page.entries);
    done = page.done;
    // "Absent when nothing was scanned": there is nothing to continue from, so this is the end.
    if (page.nextCursor === undefined) done = true;
    else next = page.nextCursor;
  }
  return { entries: entries.reverse(), nextCursor: done ? null : (next ?? null) };
}

const statusOf = (s: HistoryEntry["status"]): ChatMessageDto["status"] =>
  s === "restricted" ? "rejected" : s;

/**
 * Chat messages for history entries (oldest first): each reply gets the citations, reasoning, steps and outcome of
 * its turn. Citations are recomputed from the turn's stored passages (D6), which is deterministic, so a reload shows
 * what the live stream showed. An entry without a record ordinal is skipped: its id would have to come from a
 * cursor (PF13).
 */
export async function toMessageDtos(
  deps: MessageDeps,
  identity: Identity,
  chatId: string,
  history: readonly HistoryEntry[],
): Promise<ChatMessageDto[]> {
  const entries = history.filter((e) => e.ord !== undefined);
  // A rejected record has turn 0 and no turn of its own: it has no items.
  const keyOf = (e: HistoryEntry) =>
    e.role === "assistant" && e.turn >= 1 ? turnKeyOf(e) : undefined;
  const ref = { tenantId: identity.tenantId, userId: identity.userId, chatId };
  const keys = [...new Set(entries.flatMap((e) => keyOf(e) ?? []))];
  const items =
    keys.length > 0 ? await deps.chat.items.forTurns(ref, keys) : new Map<number, TurnItem[]>();
  // Reasoning is Loom's (ADR 0133): one grouped read per page, keyed by the reply's cursor. Display only: a read
  // that fails gives null for that reply (replyReasoning logs the class).
  const replies = entries.flatMap((e) => {
    const turnKey = keyOf(e);
    return turnKey === undefined ? [] : [{ cursor: e.cursor, turnKey }];
  });
  const reasoning = await deps.reasoning.forReplies(
    ref,
    chatConversationId(identity.userId, chatId),
    replies,
  );
  const documentIds = new Set<string>();
  for (const list of items.values())
    for (const item of list)
      if (item.kind === "passages")
        for (const p of item.body.passages) documentIds.add(p.documentId);
  const titles = await documentTitles(deps.pool, deps.fields, identity, [...documentIds]);

  return entries.map((e): ChatMessageDto => {
    const base = {
      id: String(e.ord),
      cursor: e.cursor,
      turn: e.turn,
      role: e.role,
      status: statusOf(e.status),
      createdAt: new Date(e.at ?? 0).toISOString(),
    };
    if (e.role === "user") {
      return { ...base, text: e.text, citations: [], reasoning: null, steps: [], outcome: null };
    }
    const turnItems = items.get(keyOf(e) ?? -1) ?? [];
    const retrieved: StoredPassage[] = [];
    const steps: ChatMessageDto["steps"] = [];
    let outcome: ChatMessageDto["outcome"] = null;
    for (const item of turnItems) {
      if (item.kind === "passages") retrieved.push(...item.body.passages);
      else if (item.kind === "tool") steps.push(item.body);
      else outcome = item.body.kind;
    }
    const cited = citeReply(e.text, retrieved, titles);
    // A complete, empty reply with no recorded outcome is a loop that ran out of iterations (H11).
    if (outcome === null && e.status === "complete" && e.text.trim() === "")
      outcome = "max_iterations";
    return {
      ...base,
      text: cited.text,
      citations: cited.citations,
      reasoning: reasoning.get(e.cursor) ?? null,
      steps,
      outcome,
    };
  });
}
