import type { DocumentStats, DocumentSummary } from "@docmind/contracts";
import { ParserRegistry, createDefaultParsers } from "@docmind/parsers";
import { InMemoryChunkVectors } from "@docmind/vector-pg";
import { HashingEmbeddingProvider } from "@loom/memory";
import { isBase64Of } from "../../crypto/fields";
import { ingestExecutionId } from "../../documents/ingest";
import type { IngestDeps } from "./deps";
import { INGEST_STEPS, type IngestStartInput } from "./flow";
import type { DocumentResults } from "./pgResults";

const PARSED = {
  text: "h",
  sections: [{ headingPath: [], text: "h", locator: { kind: "chars" as const, start: 0, end: 1 } }],
  media: [],
};

const EMBEDDER = new HashingEmbeddingProvider({ dimensions: 8 });

/** In-memory DocumentResults: stats and summaries keyed by document id. */
export function fakeResults(): DocumentResults & {
  stats: Map<string, DocumentStats>;
  summaries: Map<string, DocumentSummary>;
} {
  const stats = new Map<string, DocumentStats>();
  const summaries = new Map<string, DocumentSummary>();
  return {
    stats,
    summaries,
    putStats: async (ref, v) => void stats.set(ref.documentId, v),
    hasSummary: async (ref) => summaries.has(ref.documentId),
    putSummary: async (ref, v) => void summaries.set(ref.documentId, v),
  };
}

/** Fakes of every ingest port, for tests that run the flow over an in-memory Loom app. */
export function fakeIngestDeps(over: Partial<IngestDeps> = {}): IngestDeps {
  return {
    guard: { begin: async () => {} },
    source: {
      meta: async () => ({ mime: "text/plain", contentAddress: "a" }),
      read: async () => new Uint8Array([104]),
    },
    parsed: {
      put: async () => {},
      take: async () => PARSED,
      has: async () => false,
      drop: async () => {},
    },
    results: fakeResults(),
    chunks: { replace: async (_r, c) => c.length, count: async () => 0, read: async () => [] },
    vectors: new InMemoryChunkVectors({
      modelId: EMBEDDER.modelId,
      dimensions: EMBEDDER.dimensions,
      chunkIds: async () => [],
    }),
    embedder: EMBEDDER,
    registry: new ParserRegistry(createDefaultParsers()),
    runner: {
      run: async () => ({
        text: "h",
        sections: [
          { headingPath: [], text: "h", locator: { kind: "chars" as const, start: 0, end: 1 } },
        ],
        media: [],
      }),
    },
    maxChars: 20_000_000,
    ...over,
  };
}

// ---- the event-log proof (Task 81, shared with Tasks 83, 91, 92 and 95a) ----

type Leaf = (v: unknown) => boolean;
interface Shape {
  [key: string]: Leaf | Shape | { optional: Leaf | Shape };
}
const oneOf =
  (...values: string[]): Leaf =>
  (v) =>
    typeof v === "string" && values.includes(v);
const matches =
  (re: RegExp): Leaf =>
  (v) =>
    typeof v === "string" && re.test(v);
const exactly =
  (want: unknown): Leaf =>
  (v) =>
    v === want;
const count: Leaf = (v) => Number.isInteger(v) && (v as number) >= 0;
/**
 * Loom's sealed field: ciphertext, so it is allowed where Loom sealed it, and nothing else is. Its
 * leaves are FieldCrypto's real encoding: strict base64, a 12-byte IV and a 16-byte GCM tag.
 */
const sealed: Leaf = (v) => {
  const o = v as Record<string, unknown> | null;
  return (
    typeof o === "object" &&
    o !== null &&
    Object.keys(o).sort().join() === "__loomEnc,data,iv,tag" &&
    o.__loomEnc === "loom/aes-256-gcm" &&
    isBase64Of(o.data) &&
    isBase64Of(o.iv, 12) &&
    isBase64Of(o.tag, 16)
  );
};
/** The closed set of step ids: a step added to the flow is allowed here by being in INGEST_STEPS. */
const STEP_IDS: readonly string[] = INGEST_STEPS.map((s) => s.id);
const STEP_NAMES = STEP_IDS.map((id) => id.replace(/^ingest-/, ""));
const fixedFailure: Leaf = (v) =>
  typeof v === "string" && STEP_NAMES.some((name) => v === `Error: ingest step failed: ${name}`);
const stepId = oneOf(...STEP_IDS);
const flowOutput: Shape = {
  outcome: oneOf("done", "document_gone", "failed"),
  code: { optional: oneOf("unsupported_content", "corrupt_content", "too_large") },
};
/** Embed's `model` is exactly the configured provider's id: a closed value, never a free pattern. */
const stepOutput = (modelId: string | undefined): Shape => ({
  ...flowOutput,
  count: { optional: count },
  model: { optional: (v) => modelId !== undefined && v === modelId },
});

/** The payload of every event type, per key the only values it may hold; an unlisted type or key fails. */
const payloads = (ref: IngestStartInput, modelId: string | undefined): Record<string, Shape> => {
  const ids: Shape = {
    documentId: exactly(ref.documentId),
    tenantId: exactly(ref.tenantId),
    userId: exactly(ref.userId),
  };
  return {
    EXECUTION_STARTED: {
      input: ids,
      flowHash: matches(/^fnv1a:[0-9a-f]+$/),
      principal: { v: exactly(1), identity: { actor: sealed, tenant: sealed } },
    },
    STEP_STARTED: { input: ids, stepId },
    STEP_COMPLETED: { output: stepOutput(modelId), stepId },
    STEP_FAILED: { error: fixedFailure, stepId },
    RESOURCE_METERED: { ms: count, tokens: count },
    EXECUTION_COMPLETED: { output: flowOutput },
    EXECUTION_FAILED: { error: fixedFailure },
    // The delete route's reason, and the two reasons recovery gives an execution up with.
    EXECUTION_CANCELLED: {
      reason: oneOf("document-deleted", "ingest-recovery-exhausted", "ingest-flow-mismatch"),
    },
    STEP_CANCELLED: { stepId },
    EXECUTION_RECOVERED: {},
    // A refused operation by someone else: Loom's fixed text, and the refused actor's id.
    EXECUTION_DENIED: {
      op: oneOf("cancel"),
      actor: matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      reason: exactly("only the execution's owner may do this"),
    },
  };
};

function checkShape(value: unknown, shape: Shape, path: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} is not an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    // Own keys only: `in` would let `toString`, `constructor` or a JSON `__proto__` through.
    if (!Object.hasOwn(shape, key)) throw new Error(`unexpected key ${path}.${key}`);
  }
  for (const [key, rule] of Object.entries(shape)) {
    const here = `${path}.${key}`;
    const optional = typeof rule === "object" && "optional" in rule;
    if (!Object.hasOwn(record, key)) {
      if (optional) continue;
      throw new Error(`missing key ${here}`);
    }
    const inner = optional ? (rule as { optional: Leaf | Shape }).optional : rule;
    if (typeof inner !== "function") checkShape(record[key], inner as Shape, here);
    else if (!inner(record[key])) throw new Error(`${here} is not an id, count, code or enum`);
  }
}

export interface RawEvent {
  id: string;
  sequence: number;
  timestamp: number;
  executionId: string;
  workflowId: string;
  eventType: string;
  payload: unknown;
  metadata?: unknown;
}

/**
 * Walks every field of every raw event of ONE ingest execution (`ref`'s): the envelope, the payload
 * and the metadata. Each value must be this execution's own id, a count, a fixed enum or code, a
 * fixed failure text, or Loom's ciphertext envelope; a key, event type or value it does not list
 * fails, so a filename, title, text, email or error message fails (extend `payloads` per new step).
 */
export function assertEventsAreContentFree(
  events: RawEvent[],
  ref: IngestStartInput,
  /** The configured embedder's `modelId`: the only `model` an embed result may hold (none given: any `model` fails). */
  modelId?: string,
): void {
  if (events.length === 0) throw new Error("no events to check");
  const executionId = ingestExecutionId(ref.userId, ref.documentId);
  const types = payloads(ref, modelId);
  const envelope: Shape = {
    id: (v) =>
      typeof v === "string" &&
      v.startsWith(`${executionId}-`) &&
      /^\d+(-denied)?$/.test(v.slice(executionId.length + 1)),
    sequence: count,
    timestamp: count,
    executionId: exactly(executionId),
    workflowId: exactly("ingest-document"),
    eventType: (v) => typeof v === "string" && Object.hasOwn(types, v),
    payload: (v) => typeof v === "object" && v !== null,
    metadata: { optional: (v) => typeof v === "object" && v !== null },
  };
  for (const [i, e] of events.entries()) {
    const at = `${e.eventType}[${i}]`;
    checkShape(e, envelope, at);
    checkShape(e.payload, types[e.eventType] as Shape, `${at}.payload`);
    if (e.metadata !== undefined) {
      // `seal` lists the sealed paths of the start; `fence` is the counter of a cancel.
      checkShape(
        e.metadata,
        { seal: { optional: SEAL }, fence: { optional: count } },
        `${at}.metadata`,
      );
    }
  }
}

const SEAL: Shape = {
  v: exactly(1),
  cipher: exactly("loom/aes-256-gcm"),
  covers: (v) =>
    Array.isArray(v) &&
    v.every((p) => /^EXECUTION_STARTED\.principal\.identity\.(actor|tenant)$/.test(String(p))),
};
