import type { ChatReasoningDto, ReasoningResponse } from "@docmind/contracts";
import { unwrapTainted } from "@loom/classify";
import { type Conversations, generationId, parseCursor } from "@loom/conversation";
import { type ReasoningLogReader, type ReasoningStepRead, readReasoningBounded } from "@loom/llm";
import type { ChatReasoningStore } from "./reasoningStore";
import type { ChatRef } from "./turnItems";

/** What reading ONE reply's reasoning may cost: its own steps (a few parts, a few KiB each). */
export const REPLY_LIMITS = { maxParts: 64, maxBytes: 256 * 1024 } as const;
/** What the endpoint may cost: Loom's own bounds for its `/reasoning` route (256 parts, 1 MiB). */
export const ENDPOINT_LIMITS = { maxParts: 256, maxBytes: 1024 * 1024 } as const;
/** The folded text of one reply is cut here (the contract allows 40,000). */
export const MAX_REASONING_CHARS = 32_000;

/** One `read` of each execution's log per request, however many replies ask (Loom's reader reads the whole generation). */
export function memoLog(log: ReasoningLogReader): ReasoningLogReader {
  const seen = new Map<string, ReturnType<ReasoningLogReader["read"]>>();
  return {
    read: (executionId) => {
      let p = seen.get(executionId);
      if (p === undefined) {
        p = log.read(executionId);
        seen.set(executionId, p);
      }
      return p;
    },
  };
}

/**
 * The recorded attempts' texts folded into one `ChatReasoningDto`, as loom-ui's `chatReasoningFromDurable` does:
 * only the attempt a step recorded counts; texts are trimmed and joined by a blank line; any `summary` makes the
 * whole a `summary` (never upgraded to `text`); a part with no text is hidden reasoning (`redacted`); an erased
 * part or one that fails its digest never contributes text and shows only when nothing else does. `null` when
 * nothing was recorded.
 */
export function foldReasoning(
  steps: readonly ReasoningStepRead[],
  truncated: boolean,
): ChatReasoningDto | null {
  const texts: string[] = [];
  let used = 0;
  let summary = false;
  let hidden = false;
  let mismatch = false;
  let erased = false;
  let cut = truncated;
  for (const s of steps) {
    for (const a of s.attempts) {
      const recorded =
        a.recorded && (s.recordedAttempt === undefined || a.attempt === s.recordedAttempt);
      if (!recorded) continue;
      for (const p of a.parts) {
        if (p.status === "erased") erased = true;
        else if (p.status === "redacted") hidden = true;
        else if (p.status !== "ok") mismatch = true;
        else {
          const clean = (p.text === undefined ? "" : unwrapTainted(p.text)).trim();
          if (clean === "") {
            hidden = true;
            continue;
          }
          const room = MAX_REASONING_CHARS - used;
          if (room <= 0) {
            cut = true;
            continue;
          }
          texts.push(clean.length > room ? clean.slice(0, room) : clean);
          if (clean.length > room) cut = true;
          used += Math.min(clean.length, room) + 2;
          if (p.kind === "summary") summary = true;
        }
      }
    }
  }
  const flag = cut ? { truncated: true as const } : {};
  if (texts.length > 0)
    return { text: texts.join("\n\n"), kind: summary ? "summary" : "text", ...flag };
  if (hidden) return { text: "", kind: "redacted", ...flag };
  if (mismatch) return { text: "", kind: "text", status: "digest-mismatch", ...flag };
  if (erased) return { text: "", kind: "text", status: "erased", ...flag };
  return null;
}

export interface ReplyRef {
  /** Loom's history cursor of the reply, `<generation>.<sequence>`. */
  cursor: string;
  /** The turn key `<o>` of the reply's step ids (`turnKeyOf(entry)`). */
  turnKey: number;
}

/** History's view of reasoning: one call per page, keyed by each reply's cursor. */
export interface ReplyReasoning {
  forReplies(
    ref: ChatRef,
    conversationId: string,
    replies: readonly ReplyRef[],
  ): Promise<Map<string, ChatReasoningDto | null>>;
}

export interface ReplyReasoningDeps {
  /** The DECRYPTING event store (capture events are sealed). */
  log: ReasoningLogReader;
  store: Pick<ChatReasoningStore, "readerFor">;
  /** Called with the error of a failed read; callers log the class only (default `logReasoningError`). */
  onError?: (err: unknown) => void;
}

/** The class only: a read error could carry a store or key message. */
export const logReasoningError = (err: unknown): void =>
  console.error(
    "chat reasoning read failed",
    err instanceof Error ? err.constructor.name : typeof err,
  );

/**
 * Reasoning for the replies of one history page. One memoized read of each generation's log, then a bounded read
 * per reply selected by `stepPrefix: "conv#o<turnKey>#"` BEFORE any blob is fetched. The caller has already
 * established that the chat is the caller's (the chat row, `user_id = identity`), and the store reader is fixed
 * to that owner's chat. History is display: a failed read gives `null` for that reply, never an error.
 */
export function replyReasoning(deps: ReplyReasoningDeps): ReplyReasoning {
  const report = deps.onError ?? logReasoningError;
  return {
    async forReplies(ref, conversationId, replies) {
      const out = new Map<string, ChatReasoningDto | null>();
      if (replies.length === 0) return out;
      const log = memoLog(deps.log);
      const reader = deps.store.readerFor(ref);
      for (const r of replies) {
        const pos = parseCursor(r.cursor);
        if (pos === undefined) {
          out.set(r.cursor, null);
          continue;
        }
        try {
          const read = await readReasoningBounded(
            log,
            reader,
            { executionId: generationId(conversationId, pos.g), stepPrefix: `conv#o${r.turnKey}#` },
            REPLY_LIMITS,
          );
          out.set(r.cursor, foldReasoning(read.steps, read.truncated));
        } catch (err) {
          report(err);
          out.set(r.cursor, null);
        }
      }
      return out;
    },
  };
}

export interface ReasoningBodyDeps {
  conversations: Pick<Conversations, "reasoningTarget">;
  log: ReasoningLogReader;
  store: Pick<ChatReasoningStore, "readerFor">;
}

/**
 * The body of `GET /api/chats/:id/reasoning?cursor=`: Loom's own shape (`conversation-sse`'s route), with the text
 * unwrapped at this edge. The audience decision is Loom's (`reasoningTarget`: in owner mode the owner only; an
 * unknown cursor, a user message and anyone else are `ConversationNotFoundError`; a malformed cursor is
 * `InvalidCursorError`), and it runs BEFORE any read. The route has already checked the chat row.
 */
export async function reasoningBody(
  deps: ReasoningBodyDeps,
  ref: ChatRef,
  conversationId: string,
  cursor: string,
  options: Parameters<Conversations["reasoningTarget"]>[2],
): Promise<ReasoningResponse> {
  const target = await deps.conversations.reasoningTarget(conversationId, cursor, options);
  const { steps, truncated } = await readReasoningBounded(
    deps.log,
    deps.store.readerFor(ref),
    {
      executionId: target.executionId,
      ...(target.stepPrefix !== undefined && { stepPrefix: target.stepPrefix }),
    },
    ENDPOINT_LIMITS,
  );
  return {
    steps: steps.map((s) => ({
      stepId: s.stepId,
      ...(s.recordedAttempt !== undefined && { recordedAttempt: s.recordedAttempt }),
      attempts: s.attempts.map((a) => ({
        attempt: a.attempt,
        provider: a.provider,
        ...(a.model !== undefined && { model: a.model }),
        recorded: a.recorded,
        parts: a.parts.map((p) => ({
          kind: p.kind,
          status: p.status,
          // The transport edge: the one place the untrusted wrapper comes off.
          ...(p.text !== undefined && { text: unwrapTainted(p.text) }),
        })),
      })),
    })),
    ...(truncated && { truncated: true as const }),
  };
}
