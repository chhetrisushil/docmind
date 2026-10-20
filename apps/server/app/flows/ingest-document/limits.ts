import { OllamaEmbeddingProvider } from "@docmind/embeddings";
import { AnthropicMessagesProvider } from "@docmind/llm-anthropic";
import { ParseRunner, ParserRegistry, createDefaultParsers } from "@docmind/parsers";
import type { ParseLimits } from "@docmind/parsers";
import type { LlmProvider } from "@loom/llm";
import { EmbeddingError, type EmbeddingProvider } from "@loom/memory";
import { loadLimits, positiveInt } from "../../documents/limits";
import { InMemoryProgressBus, type ProgressBus } from "../../documents/progress";
import { StartupConfigError } from "../../startupError";
import { IngestGate } from "./gate";
import { STEP_TIMEOUT_MS } from "./stepEffect";
import { VISION_PDF_MAX_REQUESTS } from "./vision";

/** The ingest flow's dependencies, built once by the composition root and passed down. */
export interface IngestWiring {
  registry: ParserRegistry;
  runner: ParseRunner;
  bus: ProgressBus;
  /** Holds no resources (a stateless HTTP client), so `closeIngest` has nothing to close for it. */
  embedder: EmbeddingProvider;
  /** Aborted by `closeIngest` before the runner closes, so steps treat what follows as an interruption, not a failure. */
  shutdown: AbortController;
  /** Fair sharing of ingest work across tenants; every step attempt waits on it. */
  gate: IngestGate;
  /** The parse limits the runner was built with; parse's attempt timeout derives from them. */
  runnerLimits: ParseLimits;
  /** Claude providers; both are undefined without ANTHROPIC_API_KEY (summaries skipped, images fail as vision_unavailable). */
  /** The most document text a summary reads. */
  summaryMaxChars: number;
  llm: { summary?: LlmProvider; vision?: LlmProvider; config: LlmSettings };
  /** Test seam: the wait between retry attempts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * One parse attempt: a wait for a runner slot, its own run, up to VISION_PDF_MAX_REQUESTS sequential
 * vision requests, and database and blob slack.
 */
export const parseStepTimeoutMs = (limits: ParseLimits, visionTimeoutMs: number): number =>
  2 * limits.wallClockMs + VISION_PDF_MAX_REQUESTS * visionTimeoutMs + 30_000;

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
/** Each embed attempt is cut off at STEP_TIMEOUT_MS, so a request timeout at or above it could never fire: it must be below. */
const MAX_EMBED_TIMEOUT_MS = STEP_TIMEOUT_MS - 1;

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

const MODEL_ID = /^[a-z0-9][a-z0-9.\-]{0,99}$/;
const MAX_LLM_TIMEOUT_MS = 300_000;
const MAX_VISION_TIMEOUT_MS = 600_000;
const SUMMARY_MAX_TOKENS = 2_048;
const VISION_MAX_TOKENS = 16_000;

/** Claude settings kept on the wiring. It never holds the API key (R10): the key lives only inside the providers. */
export interface LlmSettings {
  baseUrl?: string;
  summaryModel: string;
  visionModel: string;
  timeoutMs: number;
  visionTimeoutMs: number;
}

const modelId = (env: NodeJS.ProcessEnv, name: string, fallback: string): string => {
  const v = env[name]?.trim() || fallback;
  if (!MODEL_ID.test(v)) throw new StartupConfigError(`${name} must be a model id`);
  return v;
};

/** Claude settings. The key is optional (D7): without it summaries are skipped and images fail as vision_unavailable. */
export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmSettings {
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim() || undefined;
  return {
    ...(baseUrl && { baseUrl }),
    summaryModel: modelId(env, "DOCMIND_SUMMARY_MODEL", "claude-haiku-5-5"),
    visionModel: modelId(env, "DOCMIND_VISION_MODEL", "claude-sonnet-5-5"),
    timeoutMs: positiveInt(env, "DOCMIND_LLM_TIMEOUT_MS", 60_000, MAX_LLM_TIMEOUT_MS),
    // A vision request reads up to VISION_PDF_PAGES_PER_REQUEST dense pages: far slower than a summary.
    visionTimeoutMs: positiveInt(env, "DOCMIND_VISION_TIMEOUT_MS", 180_000, MAX_VISION_TIMEOUT_MS),
  };
}

function createLlm(env: NodeJS.ProcessEnv): IngestWiring["llm"] {
  const config = loadLlmConfig(env);
  const { baseUrl } = config;
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  if (!apiKey) return { config };
  const make = (model: string, maxTokens: number, timeoutMs: number) => {
    try {
      return new AnthropicMessagesProvider({
        apiKey,
        model,
        maxTokens,
        timeoutMs,
        ...(baseUrl && { baseUrl }),
      });
    } catch (err) {
      // The provider's messages name an option, never a value; say which variable it came from.
      if (err instanceof TypeError && /^baseUrl/.test(err.message))
        throw new StartupConfigError(err.message.replace(/^baseUrl/, "ANTHROPIC_BASE_URL"));
      if (err instanceof TypeError && /^apiKey/.test(err.message))
        throw new StartupConfigError("ANTHROPIC_API_KEY must be a header-safe string");
      throw err;
    }
  };
  return {
    config,
    summary: make(config.summaryModel, SUMMARY_MAX_TOKENS, config.timeoutMs),
    vision: make(config.visionModel, VISION_MAX_TOKENS, config.visionTimeoutMs),
  };
}

const MAX_SUMMARY_CHARS = 5_000_000;

/** The most document text one summary reads (the reduce prompt grows with it); an invalid variable throws an error naming it. */
export const loadSummaryMaxChars = (env: NodeJS.ProcessEnv = process.env): number =>
  positiveInt(env, "DOCMIND_SUMMARY_MAX_CHARS", 400_000, MAX_SUMMARY_CHARS);

const MAX_INGEST_CONCURRENCY = 64;

/** Gate limits from the environment; an invalid variable throws an error naming it, never its value. */
export function loadGateLimits(env: NodeJS.ProcessEnv = process.env): {
  concurrency: number;
  tenantConcurrency: number;
} {
  const concurrency = positiveInt(env, "DOCMIND_INGEST_CONCURRENCY", 4, MAX_INGEST_CONCURRENCY);
  const tenantConcurrency = positiveInt(
    env,
    "DOCMIND_INGEST_TENANT_CONCURRENCY",
    2,
    MAX_INGEST_CONCURRENCY,
  );
  if (tenantConcurrency > concurrency)
    throw new StartupConfigError(
      "DOCMIND_INGEST_TENANT_CONCURRENCY must not exceed DOCMIND_INGEST_CONCURRENCY",
    );
  return { concurrency, tenantConcurrency };
}

export function createIngestWiring(env: NodeJS.ProcessEnv = process.env): IngestWiring {
  const limits = loadParseLimits(env);
  // An explicit options object: nothing config-derived reaches the runner except these two fields.
  const maxConcurrent = positiveInt(env, "DOCMIND_PARSE_CONCURRENCY", 2, MAX_CONCURRENCY);
  return {
    registry: new ParserRegistry(createDefaultParsers()),
    runner: new ParseRunner({ limits, maxConcurrent }),
    runnerLimits: limits,
    bus: new InMemoryProgressBus(),
    embedder: createEmbedder(env),
    shutdown: new AbortController(),
    gate: new IngestGate(loadGateLimits(env)),
    llm: createLlm(env),
    summaryMaxChars: loadSummaryMaxChars(env),
  };
}
