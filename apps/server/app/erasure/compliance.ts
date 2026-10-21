import type { Shredder, SubjectIndex } from "@loom/compliance";
import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import { type KeyStore, type ShredOptions, shredSubject } from "@loom/plugin-crypto";
import { subjectOfExecution } from "../subject";

/** What erasure needs from the storage layer: the key store, and the raw (unwrapped) event and snapshot stores. */
export interface ErasureWiring {
  keys: KeyStore;
  raw: {
    eventStore: EventStore;
    snapshotStore: NonNullable<ShredOptions["snapshotStore"]>;
  };
}

/**
 * Loom's `SubjectResolver`: the user an execution belongs to, or `undefined` for an execution no user
 * owns (`subjectOfExecution` keys those as `x:<id>`, outside the user namespace; they are not data
 * subjects and must never be grouped into an erasure). Only the execution id is read, so it works on
 * a payload that is sealed or shredded.
 */
export function userSubjectOf(e: { executionId: string }): string | undefined {
  const subject = subjectOfExecution(e);
  return subject.startsWith("x:") ? undefined : subject;
}

/**
 * Loom's `Shredder`: destroys the user's key and appends `ERASURE_PENDING` and `PAYLOAD_SHREDDED` to
 * each execution's log. It must write to the RAW store (a tombstone sealed under the destroyed key
 * would be unreadable), and be given the raw snapshot store so the tombstone's sequence clears any
 * checkpoint. Idempotent: `shredSubject` skips an execution that already has its tombstone.
 */
export function userShredder({ keys, raw }: ErasureWiring): Shredder {
  return async (subjectId, executionIds, options) => {
    const first = executionIds[0];
    if (first === undefined) return; // Loom answers "unknown" before it gets here
    await shredSubject(keys, raw.eventStore, first, {
      subjectId,
      executionIds: [...executionIds],
      snapshotStore: raw.snapshotStore,
      ...(options?.force && { force: options.force }),
    });
  };
}

/**
 * The `compliance` block of `defineConfig` (inside `security`). `destroyed` is the proof Loom needs to
 * finish an erasure that was interrupted after the key was destroyed: the key store's own durable
 * `wasDestroyed`. No `tenantOf`: user ids are UUIDs, unique across tenants, so one partition is enough
 * and `eraseSubject` is called without a tenant.
 */
export function complianceConfig({ keys, raw }: ErasureWiring) {
  const proof = keys.wasDestroyed?.bind(keys);
  return {
    subjectOf: userSubjectOf,
    erase: {
      shred: userShredder({ keys, raw }),
      ...(proof && { destroyed: proof }),
    },
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** A user or execution id: any UUID, or a `u_…` id (`u_<uuid>` or `u_<uuid>:<chat or document>`). */
const HAS_ID = new RegExp(`${UUID.source}|\\bu_[0-9A-Za-z_-]{6,}`, "i");
const ID = "<id>";
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * Replaces every id in a Loom notice and keeps the rest, so an operator still reads what happened
 * (`execution "<id>": REFUSED ... key-unavailable ...`): a whole `u_…` execution id (with its `:name`, `.c-<uuid>` or `.n`
 * suffix), the quoted execution id after the word `execution`, any bare UUID, and any email-shaped string (`<email>`).
 */
export function redactIds(message: string): string {
  return message
    .replace(/(\bexecution\s+)"[^"]*"/gi, `$1"${ID}"`)
    .replace(/\bu_[0-9A-Za-z_-]{6,}[^\s"',;)\]]*/g, ID)
    .replace(new RegExp(UUID.source, "gi"), ID)
    .replace(EMAIL, "<email>");
}

/**
 * Loom's `onWarn` sink for every app, erasure wired or not. Loom's warnings are free text that can embed a user id and
 * execution ids (a `ShredIncompleteError` message names both; so does the sealed-stream refusal at boot), so ids are
 * redacted and the text kept. If an id shape still survives, the bare label is all that is printed.
 */
export const warningFor = (message: string): string => {
  const out = redactIds(message);
  return HAS_ID.test(out) ? "warning" : out;
};

/** User-owned execution ids all start with this; the log lists ids in code-point order, so they are one contiguous run. */
const USER_PREFIX = "u_";
export const HYDRATE_PAGE = 500;

const bootstrapOf = (executionId: string): EventEnvelope => ({
  id: `hydrate-${executionId}`,
  workflowId: "",
  executionId,
  eventType: "EXECUTION_STARTED",
  sequence: 0,
  timestamp: 0,
  payload: {},
});

/**
 * Rebuilds Loom's subject index after a restart (it is fed live by `onEvent` only, so a fresh process
 * has none of the executions it did not start, and `eraseSubject` would answer `unknown` and shred
 * nothing: finding E4). Lists the `u_…` executions, one page at a time, and hands the index a synthetic
 * bootstrap event for each. The resolver reads the id alone, so no event is read and nothing is
 * decrypted; a log whose first events were compacted away hydrates the same. Safe to call again and
 * alongside the live feed. Returns how many user executions it attributed.
 */
export async function hydrateSubjectIndex(
  raw: Pick<EventStore, "listExecutionsPage">,
  index: Pick<SubjectIndex, "handleEvent">,
  pageSize = HYDRATE_PAGE,
): Promise<number> {
  if (raw.listExecutionsPage === undefined)
    throw new TypeError("hydrateSubjectIndex: the event store cannot list executions");
  let attributed = 0;
  let cursor: string = USER_PREFIX; // the cursor is strictly-after: every `u_…` id sorts after `u_`
  for (;;) {
    const page = await raw.listExecutionsPage({ cursor, limit: pageSize });
    for (const executionId of page.executionIds) {
      if (!executionId.startsWith(USER_PREFIX)) return attributed; // past the user range
      if (userSubjectOf({ executionId }) === undefined) continue; // `u_` but not a user execution id
      index.handleEvent(bootstrapOf(executionId));
      attributed += 1;
    }
    if (page.nextCursor === undefined) return attributed;
    cursor = page.nextCursor;
  }
}
