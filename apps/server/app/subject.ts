import { opaqueIds } from "./opaqueIds";

export { chatConversationId, chatIdOfConversation } from "./chats/ids";
export type { ChatConversationId } from "./chats/ids";
export type { UserExecutionId } from "./opaqueIds";

/**
 * The erasure subject of an execution, from the id alone (no key, no cache, so it never misses at boot or on a replica that has not
 * seen the user): the user UUID for old-format ids (`u_<uuid>`, `u_<uuid>:...`, `u_<uuid>.c-...`), `h_<H>` for new-format ids, the same two
 * for a lineage line (`__loom_ui_lineage__:visuals-...` or `turnvisuals-...`), and `x:<id>` for an execution no user owns (it survives user
 * erasure, so every user-owned execution must be built by `opaqueIds`). Loom encrypts an execution's data under the key of its subject and
 * learns the subject from the execution id alone, so everything a user owns sits under two keys, the user's data key and `h_<H>`'s, and
 * erasure destroys both. A lineage id of any other shape resolves to "" (no subject): the encrypting stores refuse to write under it,
 * never seal it under a key erasure would miss. See `opaqueIds/ids.ts` `subjectOfId`.
 */
export function subjectOfExecution(e: { executionId: string }): string {
  return opaqueIds.subjectOf(e.executionId);
}
