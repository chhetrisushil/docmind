import { ParseRunner, ParserRegistry, createDefaultParsers } from "@docmind/parsers";
import type { ParseLimits } from "@docmind/parsers";
import { positiveInt } from "../../documents/limits";
import { InMemoryProgressBus, type ProgressBus } from "../../documents/progress";

/** The ingest flow's dependencies, built once by the composition root and passed down. */
export interface IngestWiring {
  registry: ParserRegistry;
  runner: ParseRunner;
  bus: ProgressBus;
}

// Upper bounds: the runner's own (maxChars, the timer's int32) and sane ceilings for the rest.
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_MEMORY_MB = 65_536;
const MAX_CHARS = 100_000_000;
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024; // the upload ceiling in documents/limits.ts
const MAX_CONCURRENCY = 64;

/** Parse limits from the environment; an invalid variable throws an error naming it, never its value. */
export function loadParseLimits(env: NodeJS.ProcessEnv = process.env): ParseLimits {
  return {
    wallClockMs: positiveInt(env, "DOCMIND_PARSE_TIMEOUT_MS", 30_000, MAX_TIMEOUT_MS),
    memoryMb: positiveInt(env, "DOCMIND_PARSE_MEMORY_MB", 512, MAX_MEMORY_MB),
    maxInputBytes: positiveInt(env, "DOCMIND_MAX_UPLOAD_BYTES", 50 * 1024 * 1024, MAX_UPLOAD_BYTES),
    maxChars: positiveInt(env, "DOCMIND_PARSE_MAX_CHARS", 20_000_000, MAX_CHARS),
  };
}

export function createIngestWiring(env: NodeJS.ProcessEnv = process.env): IngestWiring {
  const limits = loadParseLimits(env);
  // An explicit options object: nothing config-derived reaches the runner except these two fields.
  const maxConcurrent = positiveInt(env, "DOCMIND_PARSE_CONCURRENCY", 2, MAX_CONCURRENCY);
  return {
    registry: new ParserRegistry(createDefaultParsers()),
    runner: new ParseRunner({ limits, maxConcurrent }),
    bus: new InMemoryProgressBus(),
  };
}
