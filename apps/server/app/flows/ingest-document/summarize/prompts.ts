import { DocumentSummary } from "@docmind/contracts";
import { z } from "zod";
import { ENTITY_KINDS } from "../../../crypto/entityKeys";
import { parseSuggestedTags, tagInstruction } from "../../../tags/suggestions";

const capped = (n: number, each: number) =>
  z.array(z.string()).transform((a) => a.slice(0, n).map((s) => s.slice(0, each)));

export const MAP_SYSTEM = [
  "You summarize one part of a document from a private document library.",
  "Write a faithful summary of this part in at most 120 words, in the document's language.",
  "List the named entities it mentions: people, organizations, products, projects and places.",
  "Answer with one JSON object and nothing else.",
].join(" ");
export const MAP_INSTRUCTION = `Reply as {"summary": "<summary>", "entities": [{"name": "<as written>", "kind": "${ENTITY_KINDS.join("|")}"}]}.`;

export const REDUCE_SYSTEM = [
  "You combine partial summaries of one document from a private document library into one structured summary,",
  "in the document's language. Do not add facts the summaries do not contain.",
  "Answer with one JSON object and nothing else.",
].join(" ");
const REDUCE_FIELDS =
  '{"tldr": "<2-3 sentences>", "keyPoints": ["…"], "entities": ["…"], "topics": ["…"], "suggestedQuestions": ["questions a reader could ask about this document"], "suggestedTags": ["…"]}';

/**
 * The reduce call's instruction: the JSON shape of the answer and the one line that asks for tags (the owner's existing tag
 * names, quoted as JSON, so the model prefers them; none: up to 3 new names). The reduce is the only call that produces the
 * final summary, for one group as for many.
 */
export const reduceInstruction = (existingTags: readonly string[] = []): string =>
  `Reply as ${REDUCE_FIELDS}. ${tagInstruction(existingTags)}`;

export const MapAnswer = z.object({
  summary: z.string().transform((s) => s.slice(0, 4_000)),
  entities: z
    .array(z.object({ name: z.string().min(1), kind: z.enum(ENTITY_KINDS).catch("other") }))
    .transform((a) => a.slice(0, 50).map((e) => ({ ...e, name: e.name.slice(0, 200) }))),
});
export type MapAnswer = z.infer<typeof MapAnswer>;

export const ReduceAnswer = z
  .object({
    tldr: z.string().transform((s) => s.slice(0, 2_000)),
    keyPoints: capped(12, 500),
    entities: capped(30, 200),
    topics: capped(12, 100),
    suggestedQuestions: capped(8, 300),
    // Lenient: a missing or malformed field is [], never a failed summary.
    suggestedTags: z.unknown().transform(parseSuggestedTags),
  })
  .pipe(DocumentSummary.extend({ suggestedTags: z.array(z.string()) }));
