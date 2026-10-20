import type { ChatScope, ChatToolStep } from "@docmind/contracts";
import type { VectorScope } from "@docmind/vector-pg";
import { type TaintedValue, tainted } from "@loom/classify";
import { type EffectContext, ToolEffect } from "@loom/effect-runtime";
import type { ZodType, ZodTypeDef } from "zod";
import type { ChatBus } from "../bus";
import type { Passage } from "../retrieval";
import { ChatScopeError, scopeOfEffect } from "../scope";
import type { ChatRef, PgTurnItems, StoredPassage } from "../turnItems";

/** Where the chat's scope lives: a wrapper over `getChat` (live rows only) that returns null for a deleted or foreign chat. */
export interface ChatLookup {
  scopeOf(ref: ChatRef): Promise<ChatScope | null>;
}

export interface ToolHarnessDeps {
  chats: ChatLookup;
  items: Pick<PgTurnItems, "put" | "remove">;
  bus: Pick<ChatBus, "publish">;
}

/** The model's arguments did not fit the tool's schema. The message names nothing the model sent. */
export class ChatToolInputError extends Error {
  constructor() {
    super("invalid tool input");
    this.name = "ChatToolInputError";
  }
}

/** Everything a tool text is: third-party document content, fenced at the prompt boundary (D10). */
export const TOOL_ORIGIN = "document";

export interface ToolCall {
  /** Owner of the data: tenant and user from the principal. */
  vector: VectorScope;
  /** The chat's scope, read from its row for this call. */
  chat: ChatScope;
  signal?: AbortSignal;
}

export interface ToolResult<Out> {
  out: Out;
  step: ChatToolStep;
  /** The passages the model was shown; stored for citation checks and history. */
  passages?: readonly Passage[];
}

export function parseInput<T>(schema: ZodType<T, ZodTypeDef, unknown>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ChatToolInputError();
  return parsed.data;
}

export function toolEffect<In, Out>(
  deps: ToolHarnessDeps,
  schema: ZodType<In, ZodTypeDef, unknown>,
  run: (input: In, call: ToolCall, ctx: EffectContext) => Promise<ToolResult<Out>>,
): ToolEffect<unknown, TaintedValue<Out>> {
  return new ToolEffect<unknown, TaintedValue<Out>>(
    async (raw, ctx) => {
      const scope = scopeOfEffect(ctx);
      const input = parseInput(schema, raw);
      const chat = await deps.chats.scopeOf(scope);
      if (chat === null) throw new ChatScopeError();
      const call: ToolCall = {
        vector: { tenantId: scope.tenantId, ownerId: scope.userId },
        chat,
        ...(ctx.signal && { signal: ctx.signal }),
      };
      const result = await run(input, call, ctx);
      // Stored before the frame can complete: a recovered turn serves the frame from the log and
      // never calls the tool again, so the items must already be there.
      if (result.passages && result.passages.length > 0) {
        await deps.items.put(scope, scope.turnKey, scope.stepKey, {
          kind: "passages",
          body: { passages: result.passages.map(storedOf) },
        });
      } else {
        // A retried attempt of this step that finds nothing must not leave the earlier attempt's passages.
        await deps.items.remove(scope, scope.turnKey, scope.stepKey, "passages");
      }
      await deps.items.put(scope, scope.turnKey, scope.stepKey, {
        kind: "tool",
        body: result.step,
      });
      deps.bus.publish(scope.chatId, { kind: "tool", turnKey: scope.turnKey, step: result.step });
      return tainted(result.out, TOOL_ORIGIN);
    },
    // Read-only: a re-run after a crash is safe, and the effect needs no in-doubt parking.
    { idempotent: true },
  );
}

/** Whether a document is inside the chat's scope. */
export function inScope(chat: ChatScope, documentId: string): boolean {
  return chat === "all" || chat.documentIds.includes(documentId);
}

/** The same answer for a missing, foreign or out-of-scope id, so a tool cannot be used to probe for ids (D10). */
export function notFound(name: ChatToolStep["name"]): ToolResult<{ error: "not_found" }> {
  return { out: { error: "not_found" }, step: { name, label: "Not found", count: 0 } };
}

/** One line of at most `max` characters: whitespace collapsed, cut on a character boundary. */
export function clip(text: string, max: number): string {
  const flat = [...text.replace(/\s+/g, " ").trim()];
  return flat.length <= max ? flat.join("") : `${flat.slice(0, max - 1).join("")}…`;
}

export const SNIPPET_CHARS = 280;
export const snippetOf = (text: string): string => clip(text, SNIPPET_CHARS);

/** The passage as stored for citations and history: where it is, and a snippet. The full text is not kept. */
export const storedOf = (p: Passage): StoredPassage => ({
  passageId: p.passageId,
  documentId: p.documentId,
  locator: p.locator,
  headingPath: p.headingPath,
  snippet: snippetOf(p.text),
});

/** The passage as the model sees it. */
export const modelPassageOf = (p: Passage) => ({
  passageId: p.passageId,
  documentId: p.documentId,
  document: p.docTitle,
  locator: p.locator,
  headingPath: p.headingPath,
  text: p.text,
  ...(p.via && { via: p.via }),
});
