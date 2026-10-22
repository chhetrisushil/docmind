import { flow$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { EMBED_RETRY, LLM_RETRY, STEP_RETRY, StepResult } from "./stepEffect";

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
  // Declared policy; stepEffect enforces it. Parse calls the LLM for images and scanned pages.
  retry: LLM_RETRY,
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
  retry: EMBED_RETRY, // an embedder outage outlasts STEP_RETRY (see EMBED_RETRY)
});

export const ingestAnalyzeStep = step$({
  id: "ingest-analyze",
  name: "IngestAnalyze",
  inputSchema: IngestStartInput,
  outputSchema: StepResult,
  retry: STEP_RETRY,
});

export const ingestSummarizeStep = step$({
  id: "ingest-summarize",
  name: "IngestSummarize",
  inputSchema: IngestStartInput,
  outputSchema: StepResult,
  retry: LLM_RETRY,
});

export const ingestLinkStep = step$({
  id: "ingest-link",
  name: "IngestLink",
  inputSchema: IngestStartInput,
  outputSchema: StepResult,
  retry: STEP_RETRY,
});

/** Completing it with `outcome: "done"` is what the ingest-status model folds to `ready`. */
export const ingestFinalizeStep = step$({
  id: "ingest-finalize",
  name: "IngestFinalize",
  inputSchema: IngestStartInput,
  outputSchema: StepResult,
  retry: STEP_RETRY,
});

/** Spec 5.2 order. */
export const INGEST_STEPS = [
  ingestParseStep,
  ingestChunkStep,
  ingestEmbedStep,
  ingestAnalyzeStep,
  ingestSummarizeStep,
  ingestLinkStep,
  ingestFinalizeStep,
];

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
    // Loom refuses a changed flow under an old version. 2.3.0: embed got its own retry policy (EMBED_RETRY).
    // 3.0.0: parse and summarize retry with LLM_RETRY (provider outages).
    version: "3.0.0",
    inputSchema: IngestStartInput,
    outputSchema: IngestOutput,
    steps: INGEST_STEPS,
  }),
  runner: runIngestSteps(INGEST_STEPS) as FlowRunner<unknown, unknown>,
};
