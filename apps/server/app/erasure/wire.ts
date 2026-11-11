import type { Identity } from "@docmind/auth";
import { ConversationNotFoundError } from "@loom/conversation";
import type { KeyStore } from "@loom/plugin-crypto";
import { InboxClosedError, type WorkflowRuntime } from "@loom/workflow-runtime";
import { principalOf } from "../chats/access";
import type { ChatIdResolver } from "../chats/chatIds";
import type { ChatWiring } from "../chats/wiring";
import { existingUser } from "../documents/executionCandidates";
import type { IngestPort } from "../documents/ingest";
import type { StartScheduler } from "../documents/startScheduler";
import type { SuggestTagsStarter } from "../flows/suggest-tags/start";
import type { VisualsStarter } from "../flows/visualize-document/start";
import { type OpaqueIds, handleOfSubject, legacyIds } from "../opaqueIds";
import { drainWithin } from "../shutdown";
import type { ErasureDeps } from "./eraser";
import type { ErasureStore } from "./types";

/** The cancel reason lands in the log in the clear: a fixed word, no content. */
const ERASED = "erased";
/** How long the stop step waits for one document's pending ingest start. */
const SETTLE_MS = 5_000;

export interface ErasureParts {
  app: {
    eraseSubject(
      subjectId: string,
      tenantId: undefined,
      options: { parked: "shred"; record: false },
    ): Promise<{ outcome: "erased" | "parked" | "unknown" }>;
  };
  runtime: Pick<WorkflowRuntime, "cancel">;
  keys: Pick<KeyStore, "destroy"> & { wasDestroyed?(subjectId: string): Promise<boolean> };
  store: ErasureDeps["store"];
  sql: Pick<ErasureDeps, "lock" | "work" | "rows" | "blobs" | "handleOf">;
  /** The id key cache: erasure reads an existing user's key (never mints one) to name their new-format runs, and evicts it when a subject key is destroyed. Absent: old-format ids only. */
  ids?: Pick<OpaqueIds, "load" | "cached" | "forgetSubject" | "retireHandle" | "unretireHandle">;
  /** The chat id resolver: its cached chat formats name a user's chats, so the user is evicted from it after the shred (a late `forRef` must ask the database, which no longer has the rows). Absent: nothing to evict. */
  chatIds?: Pick<ChatIdResolver, "forgetUser">;
  starts: Pick<StartScheduler, "settle">;
  titles?: { idle(): Promise<void> };
  ingest: Pick<IngestPort, "cancel">;
  visuals: Pick<VisualsStarter, "cancel" | "settle" | "idle">;
  /** The on-demand tag suggestion starter: its pending starts are settled and its runs cancelled like the other flows'. */
  suggestTags?: Pick<SuggestTagsStarter, "cancel" | "idle" | "settle">;
  /** Absent when chat is not composed: there are no conversations to stop. */
  chat?: {
    stops: Pick<ChatWiring["stops"], "stop">;
    conversations: Pick<ChatWiring["conversations"], "close">;
  };
  status: { forgetUser(userId: string, handle?: string | null): Promise<unknown> };
  activity: { forgetUser(userId: string, handle?: string | null): Promise<unknown> };
  closeStreams(userId: string): void;
  sleep?: ErasureDeps["sleep"];
}

/** Loom throws a plain Error for an execution that never existed; match its exact message for this id and nothing else. */
const isNoExecution = (err: unknown, executionId: string) =>
  err instanceof Error && err.message === `No execution found for id: ${executionId}`;

/** A key store that cannot prove a destruction would make the shred retry forever: refuse it at compose time. */
export function requireKeyDestroyedProof(keys: { wasDestroyed?: unknown }): void {
  if (typeof keys.wasDestroyed !== "function")
    throw new Error("erasure needs a key store with wasDestroyed");
}

/** The production ports of the `Eraser`. */
export function erasureDeps(p: ErasureParts): ErasureDeps {
  requireKeyDestroyedProof(p.keys);
  /** The user's id builders when the user has a handle and a live key; undefined otherwise (a destroyed key means no new-format run can still be running). */
  const userIdsOf = async (identity: Identity) => p.ids && existingUser(p.ids, identity);
  return {
    store: p.store,
    ...p.sql,
    closeStreams: p.closeStreams,
    settleStart: (identity, documentId) =>
      drainWithin(
        Promise.all([
          p.starts.settle(identity, documentId),
          p.visuals.settle(identity, documentId),
          p.suggestTags?.settle(identity, documentId),
        ]).then(() => undefined),
        SETTLE_MS,
      ),
    settleTitles: async () => {
      await p.titles?.idle();
      await p.visuals.idle(); // a fired visualize start has landed (and is cancelled by cancelVisualize) before the shred
      await p.suggestTags?.idle(); // likewise a fired suggest-tags start
    },
    cancelIngest: (identity, documentId, generation) =>
      p.ingest.cancel(identity, documentId, generation),
    cancelVisualize: async (identity, documentId, generation) => {
      await p.visuals.cancel(identity, documentId, generation, ERASED);
      await p.suggestTags?.cancel(identity, documentId, ERASED); // the document's on-demand tag runs stop at the same point
    },
    async stopChat(identity: Identity, chatId: string) {
      if (!p.chat) return;
      const user = await userIdsOf(identity);
      // A conversation of either format may be live: stop and close both (a never-started one is "not found", as before).
      const conversationIds = [
        legacyIds.conversation(identity.userId, chatId),
        ...(user ? [user.conversation(chatId)] : []),
      ];
      for (const conversationId of conversationIds) {
        p.chat.stops.stop(conversationId); // aborts a running turn at its next checkpoint
        try {
          await p.chat.conversations.close(conversationId, { principal: principalOf(identity) });
        } catch (err) {
          // Never started, or closed already: nothing to wind down.
          if (!(err instanceof ConversationNotFoundError || err instanceof InboxClosedError))
            throw err;
        }
      }
    },
    async cancelTitle(identity, chatId) {
      const user = await userIdsOf(identity);
      const executionIds = [
        legacyIds.chatTitle(identity.userId, chatId),
        ...(user ? [user.chatTitle(chatId)] : []),
      ];
      for (const executionId of executionIds) {
        try {
          await p.runtime.cancel(executionId, ERASED, { principal: principalOf(identity) });
        } catch (err) {
          if (!isNoExecution(err, executionId)) throw err;
        }
      }
    },
    eraseSubject: async (subjectId) => {
      // Loom destroys the handle's key inside `eraseSubject` and the cache hears of it only after: for that window the handle is retired,
      // so a concurrent cache hit (a document delete, a visuals reconcile) cannot build an `h_` id against a key that may already be gone.
      const handle = handleOfSubject(subjectId);
      if (handle !== null) p.ids?.retireHandle(handle);
      try {
        // `record: false`: a park appends nothing to Loom's plaintext, never-cleared `__loom_erasure__` stream (an `ERASURE_PENDING
        // { subjectId }` for `h_<H>` and another for the user UUID would pair them for good). The Eraser owns the retry: it re-calls this
        // until `erased`, with a durable request row of its own, so nothing relies on Loom completing a recorded park.
        const result = await p.app.eraseSubject(subjectId, undefined, {
          parked: "shred",
          record: false,
        });
        // Loom's shred destroyed this subject's key itself, not through `keys.destroy`: the cached id key must not outlive it.
        // `unknown` with the key already gone is a retry after a shred that committed and then threw: evict then too.
        if (
          result.outcome === "erased" ||
          (result.outcome === "unknown" && (await p.keys.wasDestroyed?.(subjectId)) === true)
        )
          p.ids?.forgetSubject(subjectId);
        return result;
      } finally {
        if (handle !== null && p.ids) {
          // Fail closed: the handle is un-retired only when the key store durably says the key is alive. A shred that committed and then
          // threw (or a failed check) leaves a destroyed key behind a cache entry that no miss-path check would ever revisit.
          const alive = await Promise.resolve(p.keys.wasDestroyed?.(subjectId)).then(
            (d) => d === false,
            () => false,
          );
          if (!alive) p.ids.forgetSubject(subjectId);
          p.ids.unretireHandle(handle);
        }
      }
    },
    keys: {
      destroy: async (subjectId) => {
        await p.keys.destroy(subjectId);
        p.ids?.forgetSubject(subjectId); // the cached id key came from this key: it must not outlive it
      },
      wasDestroyed: async (subjectId) => (await p.keys.wasDestroyed?.(subjectId)) === true,
    },
    forgetStatus: (userId, handle) => p.status.forgetUser(userId, handle),
    forgetActivity: async (userId, handle) => {
      try {
        return await p.activity.forgetUser(userId, handle);
      } finally {
        // After the shred and the activity tombstones, and even if they threw (the step is retried and evicts again).
        p.chatIds?.forgetUser(userId);
      }
    },
    ...(p.sleep && { sleep: p.sleep }),
  };
}
