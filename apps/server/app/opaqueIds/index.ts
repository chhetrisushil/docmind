import {
  type IdFamily,
  type ParsedId,
  clearFieldsOf,
  familyOfExecution,
  handleOfAnyId,
  handleOfSubject,
  shapeOfExecution,
  shapeOfLineage,
  subjectOfHandle,
  subjectOfId,
} from "./ids";
import type { OpaqueIds } from "./opaqueIds";

export {
  OpaqueIds,
  HandleMismatchError,
  HandleStoreError,
  WARM_CONCURRENCY,
  WARM_PAGE,
} from "./opaqueIds";
export type { HandleStore } from "./opaqueIds";
export {
  UUID_PATTERN,
  UserIds,
  handleOfSubject,
  legacyIds,
  subjectOfHandle,
  subjectOfId,
} from "./ids";
export type { ChatConversationId, ClearFields, IdFamily, ParsedId, UserExecutionId } from "./ids";

let installed: OpaqueIds | undefined;

/**
 * The process's id module, as the synchronous parsers (the status fold, Loom's `keyOf` and `scopeOf`, the stores' subject mapping) see it.
 * An old-format id parses with no instance at all; a new-format id needs the one `compose.ts` installs (null until then, which every
 * entry point treats as "unknown handle"). Tests install their own and remove it afterwards.
 */
export const opaqueIds = {
  install(ids: OpaqueIds | undefined): void {
    installed = ids;
  },
  current: (): OpaqueIds | undefined => installed,
  /** What an execution or conversation id names, or null. Synchronous. */
  parse(id: string): ParsedId | null {
    const shape = shapeOfExecution(id);
    if (shape === null) return null;
    return shape.format === "legacy" ? shape.parsed : (installed?.parse(id) ?? null);
  },
  /** What a lineage line's experience id names, or null. */
  parseLineage(id: string): ParsedId | null {
    const shape = shapeOfLineage(id);
    if (shape === null) return null;
    return shape.format === "legacy" ? shape.parsed : (installed?.parseLineage(id) ?? null);
  },
  /** Family, ingest generation, run number and turn ordinal: in the clear in both formats, so no key and no miss. */
  clear: clearFieldsOf,
  /** The family of an execution id from its shape alone: no key, so it never misses on a cold cache. */
  family: (id: string): IdFamily | null => familyOfExecution(id),
  /** The erasure subject of an execution (see `subjectOfId`): from the id alone. */
  subjectOf: (executionId: string): string => subjectOfId(executionId),
  handleOfSubject,
  /** The subject of a user's new-format executions, `h_<handle>`. */
  subjectOfHandle,
  /** The handle of a new-format id, or null (old format, or not an id). */
  handleOf: handleOfAnyId,
  /** Whether the installed instance has this handle cached (false when none is installed or the id is old-format). */
  known: (handle: string): boolean => installed?.knows(handle) ?? false,
  /** Loads an existing user's id key without minting one (see `OpaqueIds.load`); false when none is installed. */
  async loadUser(who: { tenantId: string; userId: string }): Promise<boolean> {
    return installed ? installed.load(who) : false;
  },
  /** The awaited miss path: caches the user of `handle`. False when no user holds it (never issued, or erased) or the key is gone. */
  async ensure(handle: string): Promise<boolean> {
    if (!installed) return false;
    return (await installed.ensureHandle(handle)) !== null;
  },
};
export {
  HANDLE_PATTERN,
  LINEAGE_ID_PATTERN,
  USER_ID_TOKEN_SOURCE,
  UUID_ANY_PATTERN,
} from "./redaction";
export {
  USER_ID_PREFIXES,
  handleListerPrefixes,
  isOwnedBy,
  listerPrefixes,
  prefixExtensions,
  userPrefixes,
} from "./prefixes";
