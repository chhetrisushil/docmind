import type { DocumentParser, ParseRunner, ParserRegistry } from "@docmind/parsers";
import type { Effect } from "@loom/effect-runtime";
import { PermanentIngestError } from "../errors";
import type { IngestStartInput } from "../flow";
import type { ParsedStore } from "../pgParsed";
import type { DocumentSource } from "../pgSource";
import { type StepGuard, type StepResult, stepEffect } from "../stepEffect";

export interface ParseDeps {
  guard: StepGuard;
  source: DocumentSource;
  parsed: ParsedStore;
  registry: ParserRegistry;
  runner: Pick<ParseRunner, "run">;
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

/**
 * Parse step: guard first, pick a parser by mime, read the bytes, run the sandboxed parser, seal the
 * result. Rejections, memory and input limits map to codes in stepEffect (by class, never message);
 * timeouts too (errors.ts permanentCode). A crash or an abort (cancellation) propagates.
 */
export function parseEffect(deps: ParseDeps): Effect<IngestStartInput, StepResult> {
  return stepEffect("parse", deps.guard, async (ref, signal) => {
    const { mime, contentAddress } = await deps.source.meta(ref);
    const parser = select(deps.registry, mime);
    const bytes = await deps.source.read(ref, contentAddress);
    const parsed = await deps.runner.run(parser.id, bytes, signal ? { signal } : undefined);
    await deps.parsed.put(ref, parsed);
    return { count: parsed.sections.length };
  });
}
