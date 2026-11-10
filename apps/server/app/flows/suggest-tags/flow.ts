import { flow$, step$ } from "@loom/core";
import type { RetryPolicy } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

export const SUGGEST_TAGS_FLOW_ID = "suggest-tags";

/** Ids only. The execution id is built by `opaqueIds`. */
export const SuggestTagsInput = z
  .object({ tenantId: z.string().uuid(), userId: z.string().uuid(), documentId: z.string().uuid() })
  .strict();
export type SuggestTagsInput = z.infer<typeof SuggestTagsInput>;

/** One word: never a tag name. */
export const SuggestTagsOutput = z
  .object({ outcome: z.enum(["suggested", "empty", "failed"]) })
  .strict();
export type SuggestTagsOutput = z.infer<typeof SuggestTagsOutput>;

/** Declared metadata (part of the flow's identity); the effect applies it. */
export const SUGGEST_TAGS_RETRY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 2_000,
  backoffMultiplier: 2,
};

// A step id doubles as its tool id; `security.ts` grants it and `config.ts` registers its effect.
export const suggestTagsStep = step$({
  id: "suggest-tags",
  name: "SuggestTags",
  inputSchema: SuggestTagsInput,
  outputSchema: SuggestTagsOutput,
  retry: SUGGEST_TAGS_RETRY,
});

const runSuggestTags: FlowRunner<SuggestTagsInput, SuggestTagsOutput> = async (ctx, input) =>
  ctx.run(suggestTagsStep, input);

export const suggestTagsFlow: RegisteredFlow = {
  definition: flow$({
    id: SUGGEST_TAGS_FLOW_ID,
    name: "SuggestTags",
    version: "1.0.0",
    inputSchema: SuggestTagsInput,
    outputSchema: SuggestTagsOutput,
    steps: [suggestTagsStep],
  }),
  runner: runSuggestTags as FlowRunner<unknown, unknown>,
};
