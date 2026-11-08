import { RecordOrd } from "@docmind/contracts";
import type { RetryPolicy } from "@loom/core";
import { z } from "zod";
import { FAILURE_CODES } from "../ingest-document/errors";
import { MAX_FACTS, StoredFact } from "../visualize-document/facts";

/** 3 attempts, 2 s backoff, ×2: the numbers of `CHAT_TITLE_RETRY`. Declared metadata (part of the flow's identity); `stepEffect` applies it. */
export const TURN_RETRY: RetryPolicy = { maxAttempts: 3, backoffMs: 2_000, backoffMultiplier: 2 };

/** Ids only, strict. The execution id is `turnExecutionId(...)` (ids.ts). */
export const TurnInput = z
  .object({
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    chatId: z.string().uuid(),
    ord: RecordOrd,
  })
  .strict();
export type TurnInput = z.infer<typeof TurnInput>;

const Outcome = z.enum(["done", "document_gone", "failed"]);
const FactRefOut = z
  .object({ documentId: z.string().uuid(), ordinal: z.number().int().min(0).max(15) })
  .strict();

/** What `turn-load` leaves in the log: references only (document id, ordinal), never a fact's text. */
export const TurnLoadOutput = z
  .object({
    outcome: Outcome,
    code: z.enum(FAILURE_CODES).optional(),
    cited: z.boolean(),
    refs: z.array(FactRefOut).max(12),
  })
  .strict();
export type TurnLoadOutput = z.infer<typeof TurnLoadOutput>;

export const TurnFactsInput = TurnInput.extend({ refs: z.array(FactRefOut).max(12) });
export type TurnFactsInput = z.infer<typeof TurnFactsInput>;

/**
 * What `turn-facts` leaves in the log: the facts themselves (labels, values, table cells), so `output.facts` is sealed in
 * S/sensitive.ts (the path `visualize-load` already registers). Empty unless done.
 */
export const TurnFactsOutput = z
  .object({
    outcome: Outcome,
    code: z.enum(FAILURE_CODES).optional(),
    facts: z
      .array(
        z
          .object({
            origin: z.union([
              z.object({ kind: z.literal("doc"), documentId: z.string().uuid() }).strict(),
              z.object({ kind: z.literal("turn") }).strict(),
            ]),
            fact: StoredFact,
          })
          .strict(),
      )
      .max(MAX_FACTS),
  })
  .strict();
export type TurnFactsOutput = z.infer<typeof TurnFactsOutput>;
