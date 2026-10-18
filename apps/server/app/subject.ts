const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const USER_EXECUTION = new RegExp(`^u_(${UUID})(?::|$)`, "i");

/**
 * The execution id for something a user owns. Loom encrypts an execution's data under the key of
 * its erasure subject and learns the subject from the execution id alone, so every execution a user
 * owns must carry the user's id: that puts all of their data under one key, and destroying the key
 * erases it all. Callers that start executions for a user use this to build the id.
 */
export function executionIdFor(userId: string, name: string): string {
  return `u_${userId}:${name}`;
}

/**
 * The erasure subject of an execution: the owning user, or, for an execution no user owns (system
 * work), the execution itself, which is Loom's own default.
 */
export function subjectOfExecution(e: { executionId: string }): string {
  const match = USER_EXECUTION.exec(e.executionId);
  return match?.[1]?.toLowerCase() ?? e.executionId;
}
