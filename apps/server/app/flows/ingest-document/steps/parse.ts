import { LlmRefusalError, LlmRequestError } from "@docmind/llm-anthropic";
import type {
  DocumentParser,
  ParseRunner,
  ParsedDocument,
  ParsedSection,
  ParserRegistry,
} from "@docmind/parsers";
import type { Effect } from "@loom/effect-runtime";
import { BlobMissingError, PermanentIngestError } from "../errors";
import type { IngestStartInput } from "../flow";
import { imageSize } from "../imageSize";
import type { ParsedStore } from "../pgParsed";
import type { DocumentSource } from "../pgSource";
import {
  type StepGuard,
  type StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffect,
} from "../stepEffect";
import {
  VISION_MAX_BYTES,
  VISION_MAX_SIDE,
  VISION_PDF_MAX_BYTES,
  VISION_PDF_MAX_PAGES,
  VISION_PDF_MAX_SCANNED,
  type VisionReader,
  base64Length,
} from "../vision";

export interface ParseDeps extends StepSeams {
  guard: StepGuard;
  source: DocumentSource;
  parsed: ParsedStore;
  registry: ParserRegistry;
  runner: Pick<ParseRunner, "run">;
  /** Reads images and textless PDF pages with Claude; absent without an API key (images then fail as vision_unavailable). */
  vision?: Pick<VisionReader, "readImage" | "readPdfPages">;
  /** The parsed text bound (limits.ts maxChars); vision text is added after the runner's own check. */
  maxChars: number;
  /**
   * Parse's own attempt bound. The deps object is shared by every step, so this is not the generic
   * `stepTimeoutMs`: parse must outlast a runner slot wait and its own run (see parseStepTimeoutMs).
   */
  parseStepTimeoutMs?: number;
}

/** A parser that throws from accepts() is rejected with a fixed code; its message is never kept. */
function select(registry: ParserRegistry, mime: string): DocumentParser {
  let parser: DocumentParser | undefined;
  try {
    parser = registry.select(mime);
  } catch {
    throw new PermanentIngestError("unsupported_content");
  }
  if (!parser) throw new PermanentIngestError("unsupported_content");
  return parser;
}

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

type ParsedResult = Awaited<ReturnType<ParseRunner["run"]>>;

/** Maps a vision failure to its fixed code; unavailable and output errors are retried, other request errors are fatal (isFatal). */
async function visionCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof LlmRefusalError) throw new PermanentIngestError("unsupported_content");
    if (err instanceof LlmRequestError && err.status === 400)
      throw new PermanentIngestError("corrupt_content");
    throw err;
  }
}

/** D8: images are read by Claude, in this process, from the original bytes; nothing decodes them here. */
async function readImageDocument(
  deps: ParseDeps,
  bytes: Uint8Array,
  mime: string,
  signal?: AbortSignal,
): Promise<ParsedResult> {
  if (!deps.vision) throw new PermanentIngestError("vision_unavailable");
  if (base64Length(bytes.length) > VISION_MAX_BYTES) throw new PermanentIngestError("too_large");
  const size = imageSize(bytes, mime);
  if (!size) throw new PermanentIngestError("corrupt_content");
  if (size.width > VISION_MAX_SIDE || size.height > VISION_MAX_SIDE)
    throw new PermanentIngestError("too_large");
  const out = await visionCall(() =>
    (deps.vision as NonNullable<typeof deps.vision>).readImage(bytes, mime, signal),
  );
  const locator = { kind: "region" as const, page: 1, x: 0, y: 0, w: size.width, h: size.height };
  const sections = [
    { headingPath: ["Text in the image"], text: out.text.trim(), locator },
    { headingPath: ["Description"], text: out.description.trim(), locator },
  ].filter((s) => s.text !== "");
  return { text: sections.map((s) => s.text).join("\n\n"), sections, media: [] };
}

/** D8: pages the pdf parser listed as textless (media of type application/pdf) are read by vision, within bounds. */
async function withScannedPages(
  deps: ParseDeps,
  bytes: Uint8Array,
  parsed: ParsedDocument,
  signal?: AbortSignal,
): Promise<ParsedDocument> {
  const scanned = parsed.media
    .filter((m) => m.mime === "application/pdf" && m.locator.kind === "page")
    .map((m) => (m.locator as { page: number }).page);
  if (scanned.length === 0) return parsed;
  const vision = deps.vision;
  const totalPages = parsed.sections.length + scanned.length;
  if (!vision || bytes.length > VISION_PDF_MAX_BYTES || totalPages > VISION_PDF_MAX_PAGES) {
    if (parsed.sections.length > 0) return { ...parsed, media: [] };
    throw new PermanentIngestError(vision ? "too_large" : "vision_unavailable");
  }
  const read = await visionCall(() =>
    vision.readPdfPages(bytes, scanned.slice(0, VISION_PDF_MAX_SCANNED), signal),
  );
  const pageOf = (s: ParsedSection) => (s.locator.kind === "page" ? s.locator.page : 0);
  const added: ParsedSection[] = [...read]
    .filter(([, text]) => text.trim() !== "")
    .map(([page, text]) => ({
      headingPath: [],
      text: text.trim(),
      locator: { kind: "page" as const, page },
    }));
  const sections = [...parsed.sections, ...added].sort((a, b) => pageOf(a) - pageOf(b));
  return { text: sections.map((s) => s.text).join("\n\n"), sections, media: [] };
}

/**
 * Parse step: guard first, pick a parser by mime, read the bytes, run the sandboxed parser, seal the
 * result. Rejections, memory and input limits map to codes in stepEffect (by class, never message);
 * timeouts too (errors.ts permanentCode). A crash is retried (STEP_RETRY); a shutdown leaves the step un-completed.
 */
export function parseEffect(deps: ParseDeps): Effect<IngestStartInput, StepResult> {
  return stepEffect(
    "parse",
    deps.guard,
    async (ref, signal) => {
      // D2: a retry under a new generation resumes. The parsed row outlives a failure (finalize drops
      // it), so its presence means parse already succeeded for these bytes.
      if (await deps.parsed.has(ref)) return undefined; // no count: opening the body only to count it is not worth it
      const { mime, contentAddress } = await deps.source.meta(ref);
      const isImage = IMAGE_MIMES.has(mime);
      const parser = isImage ? undefined : select(deps.registry, mime);
      let bytes: Uint8Array;
      try {
        bytes = await deps.source.read(ref, contentAddress);
      } catch (err) {
        // A missing blob is "gone" only if the row is gone too; the guard throws DocumentGoneError then.
        if (err instanceof BlobMissingError) await deps.guard.begin(ref, "parse");
        throw err;
      }
      const parsed = parser
        ? await deps.runner.run(parser.id, bytes, signal ? { signal } : undefined)
        : await readImageDocument(deps, bytes, mime, signal);
      const merged = parser ? await withScannedPages(deps, bytes, parsed, signal) : parsed;
      if (merged.text.length > deps.maxChars) throw new PermanentIngestError("too_large");
      await deps.parsed.put(ref, merged, signal);
      return { count: merged.sections.length };
    },
    ingestStepOptions({
      ...deps,
      ...(deps.parseStepTimeoutMs !== undefined && { stepTimeoutMs: deps.parseStepTimeoutMs }),
    }),
  );
}
