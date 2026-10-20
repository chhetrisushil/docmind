import type { ChunkVectorStore } from "@docmind/vector-pg";
import type { Effect } from "@loom/effect-runtime";
import type { IngestStartInput } from "../flow";
import {
  LINK_STEP_TIMEOUT_MS,
  type LinkInput,
  SIMILAR_MIN,
  SIMILAR_PER_CHUNK,
  buildLinks,
  referenceMatcher,
} from "../links";
import type { ChunkStore } from "../pgChunks";
import type { EntityStore } from "../pgEntities";
import type { LinkStore } from "../pgLinks";
import type { TitleSource } from "../pgTitles";
import {
  type StepGuard,
  type StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffect,
} from "../stepEffect";

export const NEIGHBOUR_BATCH = 64;
export const READ_BATCH = 256;

export interface LinkDeps extends StepSeams {
  guard: StepGuard;
  chunks: ChunkStore;
  vectors: ChunkVectorStore;
  entities: EntityStore;
  links: LinkStore;
  titles: TitleSource;
  /** Link's own attempt bound; the deps object is shared, so this is not the generic `stepTimeoutMs`. */
  linkStepTimeoutMs?: number;
}

/**
 * Link step (D12): structure, similar, entity and reference links, replaced as a set. Progress is
 * reported after each neighbour batch, so a long scan that makes progress does not spend the retry
 * budget. Titles and chunk text stay in memory and reach only `referenceMatcher`.
 */
export function linkEffect(deps: LinkDeps): Effect<IngestStartInput, StepResult> {
  return stepEffect(
    "link",
    deps.guard,
    async (ref, signal, progress) => {
      const scope = { tenantId: ref.tenantId, ownerId: ref.userId };
      const chunks = await deps.chunks.sectionsOf(ref);
      if (chunks.length === 0)
        return { count: await deps.links.replaceForDocument(ref, [], signal) };
      const similar: LinkInput["similar"] = [];
      for (let i = 0; i < chunks.length; i += NEIGHBOUR_BATCH) {
        const ids = chunks.slice(i, i + NEIGHBOUR_BATCH).map((c) => c.id);
        similar.push(
          ...(await deps.vectors.neighbours(
            scope,
            ref.documentId,
            ids,
            SIMILAR_PER_CHUNK,
            SIMILAR_MIN,
          )),
        );
        progress?.();
      }
      const shared = await deps.entities.sharedWith(ref);
      const titles = (await deps.titles.others(ref)).flatMap((t) =>
        t.firstChunkId === null ? [] : [{ title: t.title, firstChunkId: t.firstChunkId }],
      );
      const matchReferences = referenceMatcher(titles); // up to 2,000 patterns: compiled once, not once per read batch
      const references: LinkInput["references"] = [];
      for (let i = 0; i < chunks.length; i += READ_BATCH) {
        const texts = await deps.chunks.read(
          ref,
          chunks.slice(i, i + READ_BATCH).map((c) => c.id),
        );
        references.push(...matchReferences(texts));
      }
      const links = buildLinks({
        chunks: chunks.map((c, ordinal) => ({ ...c, ordinal })),
        similar,
        shared,
        references,
      });
      return { count: await deps.links.replaceForDocument(ref, links, signal) };
    },
    ingestStepOptions({
      ...deps,
      stepTimeoutMs: deps.linkStepTimeoutMs ?? LINK_STEP_TIMEOUT_MS,
    }),
  );
}
