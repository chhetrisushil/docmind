import { type LlmProvider, UNTRUSTED_CONTENT_SYSTEM_NOTE, guardRequest } from "@loom/llm";
import { z } from "zod";
import { jsonAnswer } from "./llmJson";

/** The Messages API's per-image limit, which applies to the base64 `source.data`, not the raw bytes. */
export const VISION_MAX_BYTES = 5 * 1024 * 1024;
/** Length of the base64 encoding of `n` raw bytes. */
export const base64Length = (n: number): number => 4 * Math.ceil(n / 3);
export const VISION_MAX_SIDE = 8000;
/**
 * Largest PDF (RAW bytes) sent for vision. The Messages API caps the whole request at 32 MB and
 * base64 inflates by 4/3, so 22 MiB raw is about 29.3 MiB encoded: under the cap with room for the prompt.
 */
export const VISION_PDF_MAX_BYTES = 22 * 1024 * 1024;
/** Pages in the whole PDF; above this no page is sent. */
export const VISION_PDF_MAX_PAGES = 100;
/** Textless pages sent per document. */
export const VISION_PDF_MAX_SCANNED = 20;
const PAGE_TEXT_CAP = 100_000;
const TEXT_CAP = 200_000;
const DESCRIPTION_CAP = 20_000;
// guardRequest's inline caps are for the event log's sake; these requests never reach the log, and
// the reader enforces the API's size limit itself (readImage checks VISION_MAX_BYTES before building).
const GUARD = { maxInlineBytes: 48 * 1024 * 1024, maxInlineTotalBytes: 48 * 1024 * 1024 };

const SYSTEM = [
  "You read documents for a private document library.",
  "Transcribe the visible text exactly, in reading order, preserving line breaks; do not translate or correct it.",
  "Describe what the image shows in two to four plain sentences.",
  "Answer with one JSON object and nothing else.",
].join(" ");

const PdfAnswer = z.array(z.object({ page: z.number().int().min(1), text: z.string() }));
const ImageAnswer = z.object({ text: z.string(), description: z.string() });

/**
 * Reads images (and, from Task 113, textless PDF pages) with Claude, in the server process: the bytes
 * go to the API as an untrusted part and are never decoded here (M3b D8). The answer is document text:
 * the caller seals it like any parsed text and never logs it.
 */
export class VisionReader {
  constructor(private readonly provider: LlmProvider) {}

  async readImage(
    bytes: Uint8Array,
    mime: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; description: string }> {
    // Defense in depth: the parse step checks first, so it never reaches this.
    if (base64Length(bytes.length) > VISION_MAX_BYTES)
      throw new RangeError("image exceeds the size limit");
    const request = guardRequest(
      {
        system: `${SYSTEM}\n\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                mediaType: mime,
                source: { kind: "data", data: Buffer.from(bytes).toString("base64") },
                untrusted: { origin: "document" },
              },
              {
                type: "text",
                text: 'Reply as {"text": "<the transcription, empty if none>", "description": "<the description>"}.',
              },
            ],
          },
        ],
        temperature: 0,
      },
      GUARD,
    );
    const res = await this.provider.complete({ ...request, ...(signal && { signal }) });
    const out = jsonAnswer(res.content, ImageAnswer);
    return {
      text: out.text.slice(0, TEXT_CAP),
      description: out.description.slice(0, DESCRIPTION_CAP),
    };
  }

  /** One request for the requested pages of a PDF; returns page -> text for those pages only. */
  async readPdfPages(
    bytes: Uint8Array,
    pages: number[],
    signal?: AbortSignal,
  ): Promise<Map<number, string>> {
    // Defense in depth: the parse step checks first, so it never reaches this.
    if (bytes.length > VISION_PDF_MAX_BYTES) throw new RangeError("pdf exceeds the size limit");
    const request = guardRequest(
      {
        system: `${SYSTEM}\n\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "application/pdf",
                source: { kind: "data", data: Buffer.from(bytes).toString("base64") },
                untrusted: { origin: "document" },
              },
              {
                type: "text",
                text: `Reply as a JSON array of {"page": <number>, "text": "<the transcription of that page, empty if none>"} for exactly these page numbers: ${JSON.stringify(pages)}.`,
              },
            ],
          },
        ],
        temperature: 0,
      },
      GUARD,
    );
    const res = await this.provider.complete({ ...request, ...(signal && { signal }) });
    const asked = new Set(pages);
    const out = new Map<number, string>();
    for (const { page, text } of jsonAnswer(res.content, PdfAnswer)) {
      if (asked.has(page) && !out.has(page)) out.set(page, text.slice(0, PAGE_TEXT_CAP));
    }
    return out;
  }
}
