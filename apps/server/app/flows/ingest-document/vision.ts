import { type LlmProvider, UNTRUSTED_CONTENT_SYSTEM_NOTE, guardRequest } from "@loom/llm";
import { z } from "zod";
import { jsonAnswer } from "./llmJson";

export const VISION_MAX_BYTES = 5 * 1024 * 1024; // the Messages API's per-image limit
export const VISION_MAX_SIDE = 8000;
const TEXT_CAP = 200_000;
const DESCRIPTION_CAP = 20_000;
// guardRequest's inline caps are for the event log's sake; these requests never reach the log, and
// the reader enforces its own limits (VISION_MAX_BYTES; 32 MiB for a PDF) before building them.
const GUARD = { maxInlineBytes: 48 * 1024 * 1024, maxInlineTotalBytes: 48 * 1024 * 1024 };

const SYSTEM = [
  "You read documents for a private document library.",
  "Transcribe the visible text exactly, in reading order, preserving line breaks; do not translate or correct it.",
  "Describe what the image shows in two to four plain sentences.",
  "Answer with one JSON object and nothing else.",
].join(" ");

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
}
