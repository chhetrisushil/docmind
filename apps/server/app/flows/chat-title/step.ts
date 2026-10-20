import {
  LlmAbortedError,
  LlmOutputError,
  LlmRefusalError,
  LlmRequestError,
  LlmUnavailableError,
} from "@docmind/llm-anthropic";
import type { ConversationReader } from "@loom/conversation";
import type { Effect } from "@loom/effect-runtime";
import type { LlmProvider } from "@loom/llm";
import type { Pool } from "pg";
import { chatConversationId } from "../../chats/ids";
import { chatTitleBind, getChat, setTitle } from "../../chats/sessions";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { CHAT_TITLE_RETRY, type ChatTitleInput, type ChatTitleOutput } from "./flow";
import { cleanTitle, titleRequest } from "./title";

export interface ChatTitleDeps {
  pool: Pool;
  fields: FieldCrypto;
  /** The decrypting reader of the conversation log (`createConversationReader(eventStore)`); it does not authorize. */
  reader: Pick<ConversationReader, "read">;
  /** Absent without a Claude key: the step then skips. */
  llm?: LlmProvider;
  /** Test seam: the wait between attempts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const SKIPPED: ChatTitleOutput = { outcome: "skipped" };
/** Waits `ms`, or rejects at once when the signal aborts. */
const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** The chat's first user message that was not rejected, or null when none is recorded yet. */
async function firstQuestion(
  reader: ChatTitleDeps["reader"],
  conversationId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  let cursor: string | undefined;
  for (let round = 0; round < 5; round++) {
    const page = await reader.read(conversationId, {
      limit: 10,
      ...(cursor !== undefined && { cursor }),
      ...(signal && { signal }),
    });
    for (const entry of page.entries) {
      if (entry.role === "user" && entry.status !== "rejected" && entry.text.trim() !== "")
        return entry.text;
    }
    if (page.done || page.nextCursor === undefined) return null;
    cursor = page.nextCursor;
  }
  return null;
}

/**
 * The one step of `chat-title`. The send route starts it before the conversation has recorded the first question, so a
 * missing question is transient: it waits with the declared backoff and retries, like an LLM outage, within the same
 * retry budget. It returns `skipped` (never fails the execution) whenever there is nothing to do or the model cannot
 * help: no key, a deleted or already titled chat, no question recorded in time, a refusal, an outage that outlasts the
 * retries, or an answer with no usable title. The write is `WHERE title_source = 'none'`, so a rename that lands while
 * the model is thinking wins. Only a shutdown abort is rethrown. The title is sealed and written straight to the row:
 * it is never in the step's output or the event log.
 */
export function chatTitleEffect(deps: ChatTitleDeps): Effect<ChatTitleInput, ChatTitleOutput> {
  const sleep = deps.sleep ?? defaultSleep;
  return {
    kind: "tool",
    execute: async (ref, ctx) => {
      const llm = deps.llm;
      if (!llm) return SKIPPED;
      const row = await withTenant(deps.pool, ref.tenantId, (tx) =>
        getChat(tx, ref.userId, ref.chatId),
      );
      if (!row || row.title_source !== "none") return SKIPPED;
      const conversationId = chatConversationId(ref.userId, ref.chatId);
      const wait = async (attempt: number) => {
        await sleep(
          (CHAT_TITLE_RETRY.backoffMs ?? 0) *
            (CHAT_TITLE_RETRY.backoffMultiplier ?? 1) ** (attempt - 1),
          ctx?.signal,
        );
        ctx?.signal?.throwIfAborted(); // an abort during the wait is a shutdown, never a "skipped"
      };
      let question: string | null = null;
      let title: string | null = null;
      for (let attempt = 1; attempt <= CHAT_TITLE_RETRY.maxAttempts; attempt++) {
        ctx?.signal?.throwIfAborted();
        question ??= await firstQuestion(deps.reader, conversationId, ctx?.signal);
        if (question === null) {
          // Not recorded yet: the send route fires right after the message was accepted. Transient.
          if (attempt === CHAT_TITLE_RETRY.maxAttempts) return SKIPPED;
          await wait(attempt);
          continue;
        }
        try {
          const res = await llm.complete({
            ...titleRequest(question),
            ...(ctx?.signal && { signal: ctx.signal }),
          });
          title = res.stopReason === "max_tokens" ? null : cleanTitle(res.content);
          break;
        } catch (err) {
          if (err instanceof LlmAbortedError) throw err;
          if (err instanceof LlmRefusalError || err instanceof LlmRequestError) return SKIPPED;
          if (!(err instanceof LlmUnavailableError || err instanceof LlmOutputError)) throw err;
          if (attempt === CHAT_TITLE_RETRY.maxAttempts) return SKIPPED;
          await wait(attempt);
        }
      }
      if (title === null) return SKIPPED;
      const sealed = await deps.fields.forUser(ref.userId).seal(chatTitleBind(ref.chatId), title);
      const wrote = await withTenant(deps.pool, ref.tenantId, (tx) =>
        setTitle(tx, ref.userId, ref.chatId, sealed, "auto"),
      );
      return wrote ? { outcome: "titled" } : SKIPPED;
    },
  };
}
