import { flow$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

/**
 * Start input: ids only (never a filename, title or text), and strict so a field added later fails
 * loudly. The execution id is `executionIdFor(userId, "ingest-" + documentId)`, which is also the
 * idempotency key: Loom starts a caller-chosen id once.
 */
export const IngestStartInput = z
  .object({ tenantId: z.string().uuid(), userId: z.string().uuid(), documentId: z.string().uuid() })
  .strict();
export type IngestStartInput = z.infer<typeof IngestStartInput>;

/** A two-value enum on purpose: it cannot carry user content. */
export const IngestOutput = z.object({ outcome: z.enum(["accepted", "document_gone"]) });
export type IngestOutput = z.infer<typeof IngestOutput>;

/**
 * The M2 skeleton of spec §5.2: confirm the document is still there and stop. It writes nothing,
 * so the document stays `uploaded`. The step has no inline handler: its effect (see `deps.ts`) is
 * registered per app by `buildApp`. M3 item 14 replaces it with the parse/chunk/embed/analyze/
 * summarize/finalize steps and reuses the same existence guard at the top of each.
 */
export const ingestBeginStep = step$({
  id: "ingest-begin",
  name: "IngestBegin",
  inputSchema: IngestStartInput,
  outputSchema: IngestOutput,
});

const runner: FlowRunner<IngestStartInput, IngestOutput> = (ctx, input) =>
  ctx.run(ingestBeginStep, input);

export const ingestDocumentFlow: RegisteredFlow = {
  definition: flow$({
    id: "ingest-document",
    name: "IngestDocument",
    version: "1.0.0",
    inputSchema: IngestStartInput,
    outputSchema: IngestOutput,
    steps: [ingestBeginStep],
  }),
  runner: runner as FlowRunner<unknown, unknown>,
};
