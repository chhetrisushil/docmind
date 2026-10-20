import { tool$ } from "@loom/core";
import { z } from "zod";
import type { Passage, PassageReader, Retriever } from "../retrieval";
import { SECTION_MAX_CHARS, SECTION_MAX_CHUNKS } from "../retrieval/passages";
import {
  type ToolHarnessDeps,
  type ToolResult,
  clip,
  inScope,
  modelPassageOf,
  notFound,
  toolEffect,
} from "./harness";

export const LINK_KINDS = ["structure", "reference", "entity", "similar"] as const;
export { SECTION_MAX_CHARS };
export const SECTION_MAX_PASSAGES = SECTION_MAX_CHUNKS;
/** A passage that would only keep this much of its text is left out instead of cut. */
const MIN_USEFUL_CHARS = 200;

export const RelatedInput = z
  .object({
    passageId: z.string().uuid(),
    kinds: z.array(z.enum(LINK_KINDS)).min(1).max(LINK_KINDS.length).optional(),
  })
  .strict();

export const ReadSectionInput = z
  .object({
    passageId: z.string().uuid(),
    span: z.enum(["section", "neighbours"]).optional(),
  })
  .strict();

export const relatedTool = tool$({
  id: "related",
  name: "related",
  description:
    "Follow links from a passage you already hold to related passages in the user's documents: the same named entity, an explicit reference, a similar passage, or the same document structure. Optionally restrict to some link kinds. Returns up to 8 passages, each with its own passageId.",
  inputSchema: RelatedInput,
  outputSchema: z.unknown(),
  idempotent: true,
});

export const readSectionTool = tool$({
  id: "read_section",
  name: "read_section",
  description:
    'Read more of a document around a passage you already hold: its whole section (the default) or its neighbouring passages (span "neighbours"). Use it when a passage is cut off or needs its context. The requested passage comes first.',
  inputSchema: ReadSectionInput,
  outputSchema: z.unknown(),
  idempotent: true,
});

/** The section the model reads: the requested passage first, then the rest in order, within the passage and character caps. */
export function capSection(passages: readonly Passage[], firstId: string): Passage[] {
  const first = passages.find((p) => p.passageId === firstId);
  const ordered = first ? [first, ...passages.filter((p) => p !== first)] : [...passages];
  const out: Passage[] = [];
  let left = SECTION_MAX_CHARS;
  for (const p of ordered) {
    if (out.length >= SECTION_MAX_PASSAGES || left <= 0) break;
    if (p.text.length <= left) {
      out.push(p);
      left -= p.text.length;
      continue;
    }
    if (out.length === 0 || left >= MIN_USEFUL_CHARS)
      out.push({ ...p, text: `${p.text.slice(0, left)}…` });
    break;
  }
  return out;
}

type ReadOut = { passages: ReturnType<typeof modelPassageOf>[] } | { error: "not_found" };

export interface ReadDeps extends ToolHarnessDeps {
  retriever: Pick<Retriever, "related">;
  passages: Pick<PassageReader, "read" | "section">;
}

export function readEffects(deps: ReadDeps) {
  return {
    related: toolEffect(
      deps,
      RelatedInput,
      async ({ passageId, kinds }, call): Promise<ToolResult<ReadOut>> => {
        const id = passageId.toLowerCase();
        const seed = (await deps.passages.read(call.vector, [id])).get(id);
        if (!seed || !inScope(call.chat, seed.documentId)) return notFound("related");
        const passages = await deps.retriever.related(call.vector, call.chat, id, kinds);
        return {
          out: { passages: passages.map(modelPassageOf) },
          step: {
            name: "related" as const,
            label: `Followed links from "${clip(seed.docTitle, 60)}"`,
            count: passages.length,
          },
          passages,
        };
      },
    ),
    read_section: toolEffect(
      deps,
      ReadSectionInput,
      async ({ passageId, span }, call): Promise<ToolResult<ReadOut>> => {
        const id = passageId.toLowerCase();
        const section = await deps.passages.section(call.vector, id, span ?? "section");
        const asked = section.find((p) => p.passageId === id);
        if (!asked || !inScope(call.chat, asked.documentId)) return notFound("read_section");
        const passages = capSection(
          section.filter((p) => inScope(call.chat, p.documentId)),
          id,
        );
        return {
          out: { passages: passages.map(modelPassageOf) },
          step: {
            name: "read_section" as const,
            label: `Read ${span === "neighbours" ? "around" : "a section of"} "${clip(asked.docTitle, 60)}"`,
            count: passages.length,
          },
          passages,
        };
      },
    ),
  };
}
