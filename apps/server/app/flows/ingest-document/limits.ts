import { ParseRunner, ParserRegistry, createDefaultParsers } from "@docmind/parsers";
import type { ParseLimits } from "@docmind/parsers";
import { loadLimits, positiveInt } from "../../documents/limits";
import { InMemoryProgressBus, type ProgressBus } from "../../documents/progress";

/** The ingest flow's dependencies, built once by the composition root and passed down. */
export interface IngestWiring {
  registry: ParserRegistry;
  runner: ParseRunner;
  bus: ProgressBus;
  /** Aborted by `closeIngest` before the runner closes, so steps treat what follows as an interruption, not a failure. */
  shutdown: AbortController;
  /** Test seam: the wait between retry attempts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The one way to stop ingest: signals the steps first, then kills the in-flight parses. */
export function closeIngest(wiring: IngestWiring): Promise<void> {
  wiring.shutdown.abort();
  return wiring.runner.close();
}

// Ceilings that bound ONE child (and the wait for one slot); the host-wide cap is a deployment
// concern (container or cgroup memory limit).
const MAX_TIMEOUT_MS = 600_000;
const MAX_MEMORY_MB = 8_192;
const MAX_CHARS = 100_000_000; // the runner's own ceiling
const MAX_CONCURRENCY = 16;

/** Parse limits from the environment; an invalid variable throws an error naming it, never its value. */
export function loadParseLimits(env: NodeJS.ProcessEnv = process.env): ParseLimits {
  return {
    wallClockMs: positiveInt(env, "DOCMIND_PARSE_TIMEOUT_MS", 30_000, MAX_TIMEOUT_MS),
    memoryMb: positiveInt(env, "DOCMIND_PARSE_MEMORY_MB", 512, MAX_MEMORY_MB),
    // One source: nothing the upload accepted (maxFileBytes) may be refused at parse.
    maxInputBytes: loadLimits(env).maxFileBytes,
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
    shutdown: new AbortController(),
  };
}
