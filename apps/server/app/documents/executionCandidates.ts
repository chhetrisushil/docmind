import { type OpaqueIds, type UserIds, legacyIds } from "../opaqueIds";

/** What a starter, a canceller or a reader needs of the id cache: build for a user (minting), and find an existing user's builders (never minting). */
export type UserIdSource = Pick<OpaqueIds, "ensureUser" | "load" | "cached">;

/**
 * The user's builders when the user has a handle and a live key; undefined otherwise (no new-format run exists, or the key is destroyed).
 * Readers and cancellers use this, never `ensureUser`: they must not create a key or a handle.
 */
export async function existingUser(
  ids: Pick<OpaqueIds, "load" | "cached">,
  who: { tenantId: string; userId: string },
): Promise<UserIds | undefined> {
  return (await ids.load(who)) ? ids.cached(who.userId) : undefined;
}

/**
 * The ids a run of the document may exist under: the old-format id (a run from before the deploy) and, when the user has a handle, the
 * new-format id. Reads and cancels try each; a start builds the new-format one only.
 */
export const ingestCandidates = (
  userId: string,
  documentId: string,
  generation: number,
  user?: UserIds,
): string[] => [
  legacyIds.ingest(userId, documentId, generation),
  ...(user ? [user.ingest(documentId, generation)] : []),
];

export const visualizeCandidates = (
  userId: string,
  documentId: string,
  generation: number,
  rerun: number | undefined,
  user?: UserIds,
): string[] => [
  legacyIds.visualize(userId, documentId, generation, rerun),
  ...(user ? [user.visualize(documentId, generation, rerun)] : []),
];

export const suggestTagsCandidates = (
  userId: string,
  documentId: string,
  run: number,
  user?: UserIds,
): string[] => [
  legacyIds.suggestTags(userId, documentId, run),
  ...(user ? [user.suggestTags(documentId, run)] : []),
];

/** The lineage lines a document's visuals may live on, newest format first: reads take the first with a head, commits write the first. */
export const documentLineageCandidates = (
  userId: string,
  documentId: string,
  user?: UserIds,
): string[] => [
  ...(user ? [user.documentLineage(documentId)] : []),
  legacyIds.documentLineage(userId, documentId),
];
