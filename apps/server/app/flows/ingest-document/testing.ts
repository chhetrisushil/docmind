import { ParserRegistry, createDefaultParsers } from "@docmind/parsers";
import { ingestExecutionId } from "../../documents/ingest";
import type { IngestDeps } from "./deps";
import type { IngestStartInput } from "./flow";

/** Fakes of every ingest port, for tests that run the flow over an in-memory Loom app. */
export function fakeIngestDeps(over: Partial<IngestDeps> = {}): IngestDeps {
  return {
    guard: { begin: async () => {} },
    source: {
      meta: async () => ({ mime: "text/plain", contentAddress: "a" }),
      read: async () => new Uint8Array([104]),
    },
    parsed: { put: async () => {}, take: async () => undefined, drop: async () => {} },
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
    ...over,
  };
}

// ---- the event-log proof (Task 81, shared with Tasks 83, 91, 92 and 95a) ----

type Leaf = (v: unknown) => boolean;
interface Shape {
  [key: string]: Leaf | Shape | { optional: Leaf };
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
/** Loom's sealed field: ciphertext, so it is allowed where Loom sealed it, and nothing else is. */
const sealed: Leaf = (v) => {
  const o = v as Record<string, unknown> | null;
  return (
    typeof o === "object" &&
    o !== null &&
    Object.keys(o).sort().join() === "__loomEnc,data,iv,tag" &&
    o.__loomEnc === "loom/aes-256-gcm" &&
    Object.values(o).every((x) => typeof x === "string")
  );
};
const fixedFailure = matches(/^Error: ingest step failed: [a-z]+$/);
const stepId = matches(/^ingest-[a-z]+$/);
const flowOutput: Shape = {
  outcome: oneOf("done", "document_gone", "failed"),
  code: { optional: oneOf("unsupported_content", "corrupt_content", "too_large") },
};
// No `model` yet: a step that sets one adds it back as a closed set of configured ids (Task 91).
const stepOutput: Shape = { ...flowOutput, count: { optional: count } };

/** The payload of every event type, per key the only values it may hold; an unlisted type or key fails. */
const payloads = (ref: IngestStartInput): Record<string, Shape> => {
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
    STEP_COMPLETED: { output: stepOutput, stepId },
    STEP_FAILED: { error: fixedFailure, stepId },
    RESOURCE_METERED: { ms: count, tokens: count },
    EXECUTION_COMPLETED: { output: flowOutput },
    EXECUTION_FAILED: { error: fixedFailure },
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
    const leaf =
      typeof rule === "function"
        ? rule
        : optional
          ? (rule as { optional: Leaf }).optional
          : undefined;
    if (!leaf) checkShape(record[key], rule as Shape, here);
    else if (!leaf(record[key])) throw new Error(`${here} is not an id, count, code or enum`);
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
export function assertEventsAreContentFree(events: RawEvent[], ref: IngestStartInput): void {
  if (events.length === 0) throw new Error("no events to check");
  const executionId = ingestExecutionId(ref.userId, ref.documentId);
  const types = payloads(ref);
  const envelope: Shape = {
    id: (v) =>
      typeof v === "string" &&
      v.startsWith(`${executionId}-`) &&
      /^\d+$/.test(v.slice(executionId.length + 1)),
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
      checkShape(e.metadata, { seal: SEAL }, `${at}.metadata`);
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
