import type { Identity } from "@docmind/auth";
import { ConversationNotFoundError } from "@loom/conversation";
import type { KeyStore } from "@loom/plugin-crypto";
import { InboxClosedError, type WorkflowRuntime } from "@loom/workflow-runtime";
import { principalOf } from "../chats/access";
import { chatConversationId } from "../chats/ids";
import type { ChatWiring } from "../chats/wiring";
import type { IngestPort } from "../documents/ingest";
import type { StartScheduler } from "../documents/startScheduler";
import { drainWithin } from "../shutdown";
import { executionIdFor } from "../subject";
import type { ErasureDeps } from "./eraser";
import type { ErasureStore } from "./types";

/** The cancel reason lands in the log in the clear: a fixed word, no content. */
const ERASED = "erased";
/** How long the stop step waits for one document's pending ingest start. */
const SETTLE_MS = 5_000;

export interface ErasureParts {
  app: {
    eraseSubject(
      userId: string,
      tenantId: undefined,
      options: { parked: "shred" },
    ): Promise<{ outcome: "erased" | "parked" | "unknown" }>;
  };
  runtime: Pick<WorkflowRuntime, "cancel">;
  keys: Pick<KeyStore, "destroy"> & { wasDestroyed?(subjectId: string): Promise<boolean> };
  store: ErasureDeps["store"];
  sql: Pick<ErasureDeps, "lock" | "work" | "rows" | "blobs">;
  starts: Pick<StartScheduler, "settle">;
  titles?: { idle(): Promise<void> };
  ingest: Pick<IngestPort, "cancel">;
  /** Absent when chat is not composed: there are no conversations to stop. */
  chat?: {
    stops: Pick<ChatWiring["stops"], "stop">;
    conversations: Pick<ChatWiring["conversations"], "close">;
  };
  status: { forgetUser(userId: string): Promise<unknown> };
  activity: { forgetUser(userId: string): Promise<unknown> };
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
  return {
    store: p.store,
    ...p.sql,
    closeStreams: p.closeStreams,
    settleStart: (identity, documentId) =>
      drainWithin(p.starts.settle(identity, documentId), SETTLE_MS),
    settleTitles: async () => void (await p.titles?.idle()),
    cancelIngest: (identity, documentId, generation) =>
      p.ingest.cancel(identity, documentId, generation),
    async stopChat(identity: Identity, chatId: string) {
      if (!p.chat) return;
      const conversationId = chatConversationId(identity.userId, chatId);
      p.chat.stops.stop(conversationId); // aborts a running turn at its next checkpoint
      try {
        await p.chat.conversations.close(conversationId, { principal: principalOf(identity) });
      } catch (err) {
        // Never started, or closed already: nothing to wind down.
        if (!(err instanceof ConversationNotFoundError || err instanceof InboxClosedError))
          throw err;
      }
    },
    async cancelTitle(identity, chatId) {
      const executionId = executionIdFor(identity.userId, `chat-title-${chatId}`);
      try {
        await p.runtime.cancel(executionId, ERASED, { principal: principalOf(identity) });
      } catch (err) {
        if (!isNoExecution(err, executionId)) throw err;
      }
    },
    eraseSubject: (userId) => p.app.eraseSubject(userId, undefined, { parked: "shred" }),
    keys: {
      destroy: (subjectId) => p.keys.destroy(subjectId),
      wasDestroyed: async (subjectId) => (await p.keys.wasDestroyed?.(subjectId)) === true,
    },
    forgetStatus: (userId) => p.status.forgetUser(userId),
    forgetActivity: (userId) => p.activity.forgetUser(userId),
    ...(p.sleep && { sleep: p.sleep }),
  };
}
