import { OllamaEmbeddingProvider } from "@docmind/embeddings";
import { ParseRunner, ParserRegistry, createDefaultParsers } from "@docmind/parsers";
import type { ParseLimits } from "@docmind/parsers";
import { EmbeddingError, type EmbeddingProvider } from "@loom/memory";
import { loadLimits, positiveInt } from "../../documents/limits";
import { InMemoryProgressBus, type ProgressBus } from "../../documents/progress";
import { StartupConfigError } from "../../startupError";

/** The ingest flow's dependencies, built once by the composition root and passed down. */
export interface IngestWiring {
  registry: ParserRegistry;
  runner: ParseRunner;
  bus: ProgressBus;
  /** Holds no resources (a stateless HTTP client), so `closeIngest` has nothing to close for it. */
  embedder: EmbeddingProvider;
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

export interface EmbedConfig {
  baseUrl: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
}

const MAX_EMBED_DIMENSIONS = 16_000; // pgvector's `vector` column limit
const MAX_EMBED_TIMEOUT_MS = 600_000;

/** Embedder config from the environment; an invalid variable throws an error naming it, never its value. The URL is validated by the provider. */
export function loadEmbedConfig(env: NodeJS.ProcessEnv = process.env): EmbedConfig {
  return {
    baseUrl: env.DOCMIND_OLLAMA_URL?.trim() || "http://127.0.0.1:11434",
    model: env.DOCMIND_EMBED_MODEL?.trim() || "nomic-embed-text",
    dimensions: positiveInt(env, "DOCMIND_EMBED_DIMENSIONS", 768, MAX_EMBED_DIMENSIONS),
    timeoutMs: positiveInt(env, "DOCMIND_EMBED_TIMEOUT_MS", 30_000, MAX_EMBED_TIMEOUT_MS),
  };
}

/** The provider's own messages name a variable and never a value, so they are safe as a startup error. */
function createEmbedder(env: NodeJS.ProcessEnv): EmbeddingProvider {
  try {
    return new OllamaEmbeddingProvider(loadEmbedConfig(env));
  } catch (err) {
    if (err instanceof EmbeddingError) throw new StartupConfigError(err.message);
    throw err;
  }
}

export function createIngestWiring(env: NodeJS.ProcessEnv = process.env): IngestWiring {
  const limits = loadParseLimits(env);
  // An explicit options object: nothing config-derived reaches the runner except these two fields.
  const maxConcurrent = positiveInt(env, "DOCMIND_PARSE_CONCURRENCY", 2, MAX_CONCURRENCY);
  return {
    registry: new ParserRegistry(createDefaultParsers()),
    runner: new ParseRunner({ limits, maxConcurrent }),
    bus: new InMemoryProgressBus(),
    embedder: createEmbedder(env),
    shutdown: new AbortController(),
  };
}
