import type { DocumentSummary } from "@docmind/contracts";
import { z } from "zod";
import { parseSuggestedTags, tagInstruction } from "../../tags/suggestions";

export const SUGGEST_SYSTEM = [
  "You suggest tags for one document from a private document library, using only its stored summary.",
  "Answer with one JSON object and nothing else.",
].join(" ");

export const suggestInstruction = (existingTags: readonly string[]): string =>
  `Reply as {"suggestedTags": ["…"]}. ${tagInstruction(existingTags)}`;

/** The same lenient `suggestedTags` as the ingest reduce answer: missing or malformed is []. */
export const SuggestAnswer = z
  .object({ suggestedTags: z.unknown().transform(parseSuggestedTags) })
  .transform((a) => a.suggestedTags);

const MAX_SUMMARY_CHARS = 6_000;

/** What the model reads: the stored summary's tldr, topics and key points. Never a passage, the title or the filename. */
export function summaryText(s: Pick<DocumentSummary, "tldr" | "topics" | "keyPoints">): string {
  return [
    `Summary: ${s.tldr}`,
    `Topics: ${s.topics.join("; ")}`,
    "Key points:",
    ...s.keyPoints.map((k) => `- ${k}`),
  ]
    .join("\n")
    .slice(0, MAX_SUMMARY_CHARS);
}
