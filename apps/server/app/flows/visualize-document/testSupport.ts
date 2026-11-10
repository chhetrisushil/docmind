import { testIdSource } from "../../opaqueIds/testing";
import type { VisualizeRef } from "./pgFacts";

/** The id cache the lineage tests share: `commitPlan` and `experienceIdOf` must build the same line from it. */
export const lineageTestIds = testIdSource();

/** The document's NEW-format lineage line (`visuals-<H>-<D>`): the line a test commits to and reads back. */
export const experienceIdOf = async (ref: VisualizeRef): Promise<string> =>
  (await lineageTestIds.ensureUser(ref)).documentLineage(ref.documentId);
