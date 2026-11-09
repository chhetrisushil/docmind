import type { Effect } from "@loom/effect-runtime";
import { visualizeGenerationOf } from "../../status/model";
import {
  type StepGuard,
  StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffectOf,
} from "../ingest-document/stepEffect";
import {
  type EntityCandidate,
  MIN_LINKED,
  type Mention,
  buildCooccurrence,
  topEntities,
} from "./cooccurrence";
import { ENTITY_MAP_ORDINAL, OUTLINE_ORDINAL, type StructureFact } from "./facts";
import { type HeadingRow, buildOutline } from "./outline";
import type { VisualFactStore, VisualizeRef } from "./pgFacts";

/** What the structure step reads, owner-scoped and for one document. `null` means a value did not open (that fact is skipped). */
export interface StructureReader {
  /** The document's title. Throws DocumentGoneError when it is not the owner's. */
  title(ref: VisualizeRef): Promise<string | null>;
  /** Each passage's section and opened heading path, in passage order. */
  headings(ref: VisualizeRef): Promise<HeadingRow[] | null>;
  /** The document's most-mentioned entities (at least the top 20, ties included), names opened. */
  entities(ref: VisualizeRef): Promise<EntityCandidate[] | null>;
  /** The passages of the given entities in this document, in passage order. */
  mentions(ref: VisualizeRef, entityIds: readonly string[]): Promise<Mention[]>;
}

export interface StructureDeps extends StepSeams {
  guard: StepGuard<VisualizeRef>;
  reader: StructureReader;
  facts: Pick<VisualFactStore, "replaceStructure">;
}

/**
 * Visualize-structure step: derives the document's outline and entity map (no model call) and replaces the document's
 * structure facts, leaving its extracted facts alone. It runs on every run, including a re-plan that skips extraction.
 * A kind whose inputs do not open, or that does not reach its thresholds, is simply not produced. The output is a count.
 */
const generationOfRun = (deps: StructureDeps, executionId: string | undefined) =>
  executionId === undefined ? undefined : (deps.generationOf ?? visualizeGenerationOf)(executionId);

export function structureEffect(deps: StructureDeps): Effect<VisualizeRef, StepResult> {
  return stepEffectOf<StepResult, VisualizeRef>(
    "visualize-structure",
    deps.guard,
    async (ref, signal, _progress, executionId) => {
      const facts: StructureFact[] = [];
      const title = await deps.reader.title(ref);
      const rows = title === null ? null : await deps.reader.headings(ref);
      const outline = title === null || rows === null ? null : buildOutline(title, rows);
      if (outline) facts.push({ ...outline, ordinal: OUTLINE_ORDINAL });

      const candidates = await deps.reader.entities(ref);
      const top = candidates === null ? [] : topEntities(candidates);
      const mentions =
        top.length >= MIN_LINKED
          ? await deps.reader.mentions(
              ref,
              top.map((e) => e.id),
            )
          : [];
      const map = buildCooccurrence(top, mentions);
      if (map) facts.push({ ...map, ordinal: ENTITY_MAP_ORDINAL });

      // The count only, never a heading or a name.
      console.info("visualize-structure facts", facts.length);
      return {
        count: await deps.facts.replaceStructure(
          ref,
          facts,
          signal,
          generationOfRun(deps, executionId),
        ),
      };
    },
    { schema: StepResult, ended: (end) => end },
    ingestStepOptions(deps),
  );
}
