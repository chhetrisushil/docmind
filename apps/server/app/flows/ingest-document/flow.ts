import { flow$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { STEP_RETRY, StepResult } from "./stepEffect";

/**
 * Start input: ids only (never a filename, title or text), and strict so a field added later fails
 * loudly. The execution id is `executionIdFor(userId, "ingest-" + documentId)`, which is also the
 * idempotency key: Loom starts a caller-chosen id once.
 */
export const IngestStartInput = z
  .object({ tenantId: z.string().uuid(), userId: z.string().uuid(), documentId: z.string().uuid() })
  .strict();
export type IngestStartInput = z.infer<typeof IngestStartInput>;

export const IngestOutput = z
  .object({ outcome: StepResult.shape.outcome, code: StepResult.shape.code })
  .strict();
export type IngestOutput = z.infer<typeof IngestOutput>;

// A step id doubles as its tool id; `security.ts` grants exactly these. The steps have no inline
// handler: their effects (see `deps.ts`) are registered per app by `buildApp`.
export const ingestParseStep = step$({
  id: "ingest-parse",
  name: "IngestParse",
  inputSchema: IngestStartInput,
  outputSchema: StepResult,
  // Declared policy; stepEffect enforces it (STEP_RETRY).
  retry: STEP_RETRY,
});

export const ingestChunkStep = step$({
  id: "ingest-chunk",
  name: "IngestChunk",
  inputSchema: IngestStartInput,
  outputSchema: StepResult,
  retry: STEP_RETRY,
});

export const ingestEmbedStep = step$({
  id: "ingest-embed",
  name: "IngestEmbed",
  inputSchema: IngestStartInput,
  outputSchema: StepResult,
  retry: STEP_RETRY,
});

/** Spec 5.2 order. Later tasks append analyze, summarize, link and finalize. */
export const INGEST_STEPS = [ingestParseStep, ingestChunkStep, ingestEmbedStep];

/** Runs each step in order; a `document_gone` or `failed` outcome ends the flow, later steps never run. */
export const runIngestSteps =
  (steps: readonly (typeof INGEST_STEPS)[number][]): FlowRunner<IngestStartInput, IngestOutput> =>
  async (ctx, input) => {
    for (const step of steps) {
      const result = await ctx.run(step, input);
      if (result.outcome !== "done") {
        return { outcome: result.outcome, ...(result.code !== undefined && { code: result.code }) };
      }
    }
    return { outcome: "done" };
  };

export const ingestDocumentFlow: RegisteredFlow = {
  definition: flow$({
    id: "ingest-document",
    name: "IngestDocument",
    version: "2.0.0",
    inputSchema: IngestStartInput,
    outputSchema: IngestOutput,
    steps: INGEST_STEPS,
  }),
  runner: runIngestSteps(INGEST_STEPS) as FlowRunner<unknown, unknown>,
};
