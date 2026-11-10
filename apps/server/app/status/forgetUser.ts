import type { ReadModelEventSource, ReadModelService } from "@loom/plugin-read-model";
import { isOwnedBy, userPrefixes } from "../opaqueIds";

/** The user's rows of a model that are not yet tombstoned (their execution ids, never their state), under both id formats when the user has a handle. */
export type UserExecutionLister = (
  modelId: string,
  userId: string,
  handle?: string | null,
) => Promise<readonly string[]>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PAGE = 500;

/** Whether an execution id belongs to the user: `u_<id>` itself, `u_<id>:…` (ingest, title) or `u_<id>.c-…` (chat), and the same under `h_<handle>`. */
export const isUserExecution = (
  executionId: string,
  userId: string,
  handle?: string | null,
): boolean => isOwnedBy(executionId, userId, handle);

/** The user's executions in the event log, by id prefix (a keyset walk from each prefix; a source without pages is filtered whole). */
async function userExecutionsInLog(
  source: ReadModelEventSource,
  userId: string,
  handle?: string | null,
): Promise<string[]> {
  if (!source.listExecutionsPage) {
    return ((await source.listExecutions?.()) ?? []).filter((id) =>
      isUserExecution(id, userId, handle),
    );
  }
  const out: string[] = [];
  for (const prefix of userPrefixes(userId, handle)) {
    out.push(prefix);
    let cursor: string | undefined = prefix;
    while (cursor !== undefined) {
      const page: { executionIds: string[]; nextCursor?: string } = await source.listExecutionsPage(
        {
          cursor,
          limit: PAGE,
        },
      );
      let past = false;
      for (const id of page.executionIds) {
        if (!id.startsWith(prefix)) {
          past = true; // ids sort by code point: the prefix is contiguous
          break;
        }
        if (isUserExecution(id, userId, handle)) out.push(id);
      }
      if (past) break;
      cursor = page.nextCursor;
    }
  }
  return out;
}

/**
 * User erasure for one folded model, after the shred: tombstones every row of the user, never a delete, so the
 * watermark survives and a late event cannot bring one back.
 *
 * 1. With a `source` and a `lister`, folds each of the user's executions in the log into this model first (`refresh`, on the
 *    same per-execution queue as the live path, so it also waits for any fold in flight). A model folds only its own
 *    executions live and writes the neutral rows of the others at the next boot's catch-up; without this step that
 *    boot would create live rows for an erased user. `purgeFolded` itself waits for the queues before it writes.
 * 2. Purges by `scope` (the rows with the user as scope: one call).
 * 3. Purges by execution id every remaining row under the user's id prefix (`lister`): the neutral rows of the
 *    executions this model does not own, whose key and scope are NULL. Repeats while a pass tombstones something
 *    and the lister still finds rows, so a user with many rows needs no unbounded query.
 *
 * With a `handle` it also covers the user's `h_<handle>` executions.
 *
 * Without a `lister` it is the scope purge alone. Returns the number of rows newly tombstoned; a second call returns 0.
 * Throws a `TypeError` synchronously for a user id that is not a (lower-case) uuid.
 */
export function forgetUserRows(
  service: Pick<ReadModelService, "purgeFolded" | "refresh">,
  modelId: string,
  userId: string,
  lister?: UserExecutionLister,
  source?: ReadModelEventSource,
  handle?: string | null,
): Promise<number> {
  const scope = userId.toLowerCase();
  if (!UUID.test(scope)) throw new TypeError("forgetUser: userId must be a uuid");
  return (async () => {
    if (source && lister) {
      const ids = await userExecutionsInLog(source, scope, handle);
      for (let i = 0; i < ids.length; i += PAGE)
        await service.refresh(modelId, ids.slice(i, i + PAGE), [source]);
    }
    let total = await service.purgeFolded(modelId, { scope });
    if (!lister) return total;
    for (;;) {
      const ids = await lister(modelId, scope, handle);
      let progress = 0;
      for (const executionId of ids)
        progress += await service.purgeFolded(modelId, { executionId });
      total += progress;
      if (ids.length === 0 || progress === 0) return total;
    }
  })();
}
