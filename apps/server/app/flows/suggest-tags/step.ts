import { DocumentSummary } from "@docmind/contracts";
import {
  LlmAbortedError,
  LlmOutputError,
  LlmRefusalError,
  LlmRequestError,
  LlmUnavailableError,
} from "@docmind/llm-anthropic";
import { tainted } from "@loom/classify";
import type { Effect } from "@loom/effect-runtime";
import { type LlmProvider, UNTRUSTED_CONTENT_SYSTEM_NOTE, guardRequest } from "@loom/llm";
import type { Pool } from "pg";
import { type FieldCrypto, FieldKeyStoreError } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import type { ProgressBus } from "../../documents/progress";
import { getDocument, summaryBind } from "../../documents/repo";
import type { TagService } from "../../tags/service";
import { normaliseSuggestions } from "../../tags/suggestions";
import { isAbort, isDocumentGone } from "../ingest-document/errors";
import { jsonAnswer } from "../ingest-document/llmJson";
import { defaultSleep } from "../sleep";
import { SUGGEST_TAGS_RETRY, type SuggestTagsInput, type SuggestTagsOutput } from "./flow";
import { SUGGEST_SYSTEM, SuggestAnswer, suggestInstruction, summaryText } from "./prompts";

export interface SuggestTagsDeps {
  pool: Pool;
  fields: FieldCrypto;
  tags: Pick<TagService, "suggestionContext" | "putSuggestions">;
  bus: ProgressBus;
  /** The `summary` role's provider; absent: every run fails (the route answers 409 `suggest_unavailable` before that). */
  llm?: LlmProvider;
  /** Test seam: the wait between attempts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const FAILED: SuggestTagsOutput = { outcome: "failed" };
const cls = (err: unknown) => (err instanceof Error ? err.constructor.name : typeof err);

/**
 * The one step of `suggest-tags` (spec section 4, on demand). It reads the document's stored summary (tldr, topics, key points)
 * and the owner's tag names, makes one model call with the same lenient answer and normalisation as ingest, replaces the
 * document's suggestions row and tells the owner's open pages. It never reads a passage, the title or the filename. A model
 * problem ends the run `failed` (with the `failed` event, so the page can offer a retry), never an exception; only an abort
 * and a key-store outage are rethrown. The output is one word: no tag name reaches the event log.
 */
export function suggestTagsEffect(
  deps: SuggestTagsDeps,
): Effect<SuggestTagsInput, SuggestTagsOutput> {
  const sleep =
    deps.sleep ??
    ((ms: number, signal?: AbortSignal) => defaultSleep(ms, signal, () => new LlmAbortedError()));
  return {
    kind: "tool",
    execute: async (ref, ctx) => {
      const signal = ctx?.signal;
      const announce = (tags: "suggested" | "failed") => {
        try {
          deps.bus.publish(
            { userId: ref.userId },
            { documentId: ref.documentId, status: "ready", step: "finalize", tags },
          );
        } catch (err) {
          console.error("tag suggestions event not published", cls(err));
        }
      };
      const fail = (): SuggestTagsOutput => {
        announce("failed");
        return FAILED;
      };
      const llm = deps.llm;
      if (!llm) return fail();
      try {
        const row = await withTenant(deps.pool, ref.tenantId, (tx) =>
          getDocument(tx, ref.userId, ref.documentId),
        );
        if (!row) return FAILED; // gone: nobody to tell
        if (row.summary_enc == null) return fail();
        const summary = DocumentSummary.parse(
          await deps.fields.forUser(ref.userId).open(summaryBind(ref.documentId), row.summary_enc),
        );
        const existing = await deps.tags.suggestionContext(ref);
        if (existing === null) return FAILED;
        const request = guardRequest({
          system: `${SUGGEST_SYSTEM}\n\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: tainted(summaryText(summary), "document") },
                { type: "text", text: suggestInstruction(existing.map((t) => t.name)) },
              ],
            },
          ],
          temperature: 0,
        });
        let raw: string[];
        for (let attempt = 1; ; attempt++) {
          try {
            const res = await llm.complete({ ...request, ...(signal && { signal }) });
            if (res.stopReason === "max_tokens") throw new LlmOutputError();
            raw = jsonAnswer(res.content, SuggestAnswer);
            break;
          } catch (err) {
            if (err instanceof LlmAbortedError) throw err;
            if (err instanceof LlmRefusalError || err instanceof LlmRequestError) return fail();
            if (!(err instanceof LlmUnavailableError || err instanceof LlmOutputError)) throw err;
            if (attempt >= SUGGEST_TAGS_RETRY.maxAttempts) return fail();
            await sleep(
              (SUGGEST_TAGS_RETRY.backoffMs ?? 0) *
                (SUGGEST_TAGS_RETRY.backoffMultiplier ?? 1) ** (attempt - 1),
              signal,
            );
          }
        }
        const names = normaliseSuggestions(raw, existing);
        if (!(await deps.tags.putSuggestions(ref, names))) return FAILED; // deleted meanwhile
        announce("suggested");
        return { outcome: names.length > 0 ? "suggested" : "empty" };
      } catch (err) {
        if (isAbort(err)) throw err;
        if (isDocumentGone(err)) return FAILED;
        console.error("suggest tags failed", cls(err));
        announce("failed");
        if (err instanceof FieldKeyStoreError) throw err; // an outage fails the step, as elsewhere
        return FAILED;
      }
    },
  };
}
