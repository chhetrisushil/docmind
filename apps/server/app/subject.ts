import { LINEAGE_STREAM_PREFIX } from "@loom-ui/lineage";
import { MAX_EXECUTION_ID_BYTES } from "@loom/plugin-postgres";
import { UUID_PATTERN } from "./chats/ids";

const UUID = UUID_PATTERN;
const CANONICAL_USER_ID = new RegExp(`^${UUID}$`);
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The visuals lineage lines: a document's `visuals-<userId>-<documentId>` and a chat turn's `turnvisuals-<userId>-<chatId>-<ord>` (ids only). */
const VISUALS_LINEAGE = new RegExp(
  `^${escapeRegExp(LINEAGE_STREAM_PREFIX)}(?:visuals-(${UUID})-${UUID}|turnvisuals-(${UUID})-${UUID}-[1-9][0-9]{0,14})$`,
);
const USER_EXECUTION = new RegExp(`^u_(${UUID})(?::|\\.c-|$)`);

export { chatConversationId, chatIdOfConversation } from "./chats/ids";
export type { ChatConversationId } from "./chats/ids";

declare const userExecution: unique symbol;
/**
 * An execution id built by `executionIdFor`. A plain string is not assignable to it, so a start or
 * fork that passes `executionId` from anywhere else is caught by the ratchet in executionIds.test.ts.
 */
export type UserExecutionId = string & { readonly [userExecution]: true };

/**
 * The execution id for something a user owns. Loom encrypts an execution's data under the key of
 * its erasure subject and learns the subject from the execution id alone, so every execution a user
 * owns must carry the user's id: that puts all of their data under one key, and destroying the key
 * erases it all. Callers that start executions for a user use this to build the id. Every
 * user-owned start AND every `runtime.fork` must pass an explicit `executionId` from `executionIdFor`
 * for that user; otherwise Loom uses a ULID and the data falls outside the user's key. Execution ids,
 * including `name`, are stored in plaintext and survive erasure, so `name` must never carry user content.
 */
export function executionIdFor(userId: string, name: string): UserExecutionId {
  if (!CANONICAL_USER_ID.test(userId)) {
    throw new RangeError("userId must be a canonical lowercase UUID (8-4-4-4-12 hex digits)");
  }
  const executionId = `u_${userId}:${name}`;
  const bytes = Buffer.byteLength(executionId, "utf8");
  if (bytes > MAX_EXECUTION_ID_BYTES) {
    throw new RangeError(
      `execution id is ${bytes} bytes, over the ${MAX_EXECUTION_ID_BYTES}-byte limit; shorten the name`,
    );
  }
  return executionId as UserExecutionId;
}

/**
 * The erasure subject of an execution: the owning user for `u_<uuid>[:...]` and `u_<uuid>.c-...` (a chat conversation, any generation), lower-case only. Any
 * other id is an execution no user owns; it is keyed as `x:<id>`, outside the bare-UUID user
 * namespace, and survives user erasure, so every user-owned execution must be started with
 * `executionIdFor`.
 *
 * A lineage line (`__loom_ui_lineage__:visuals-<userId>-<documentId>` or `...:turnvisuals-<userId>-<chatId>-<ord>`) is owned by its user, so its events and
 * artifact blobs go under the user's key. Any other id under the lineage prefix resolves to "" (no subject): the
 * encrypting stores refuse to write under it, never seal it under a key erasure would miss.
 */
export function subjectOfExecution(e: { executionId: string }): string {
  if (e.executionId.startsWith(LINEAGE_STREAM_PREFIX)) {
    const m = VISUALS_LINEAGE.exec(e.executionId);
    return m?.[1] ?? m?.[2] ?? "";
  }
  const match = USER_EXECUTION.exec(e.executionId);
  return match?.[1] ?? `x:${e.executionId}`;
}
