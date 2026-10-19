import { MAX_EXECUTION_ID_BYTES } from "@loom/plugin-postgres";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CANONICAL_USER_ID = new RegExp(`^${UUID}$`);
const USER_EXECUTION = new RegExp(`^u_(${UUID})(?::|$)`);

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
 * The erasure subject of an execution: the owning user for `u_<uuid>[:...]`, lower-case only. Any
 * other id is an execution no user owns; it is keyed as `x:<id>`, outside the bare-UUID user
 * namespace, and survives user erasure, so every user-owned execution must be started with
 * `executionIdFor`.
 */
export function subjectOfExecution(e: { executionId: string }): string {
  const match = USER_EXECUTION.exec(e.executionId);
  return match?.[1] ?? `x:${e.executionId}`;
}
