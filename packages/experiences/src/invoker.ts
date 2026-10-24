import type { ChatSessionDto, DocumentDto, DocumentPassage } from "@docmind/contracts";
import { Uuid } from "@docmind/contracts";
import type { TransientInvoker } from "@loom-ui/hydration";
import { TypedFailure } from "@loom/core";
import { z } from "zod";
import { CHAT_LIST_CAP, CONTENT_CAP, LIST_CAP, citedWindow } from "./providers";

export interface RawDocuments {
  items: DocumentDto[];
  truncated: boolean;
}
export interface RawContent {
  items: DocumentPassage[];
  more: boolean;
}

/** A document's original text for the page to render; a document that cannot be rendered is the value `{ applicable: false }`, never an error. */
export type SourceResult =
  | { applicable: false }
  | {
      applicable: true;
      format: "md" | "org" | "txt";
      text: string;
      truncated: boolean;
      focus?: { from: number; to: number };
    };

/** What the server must supply, already bound to the caller's identity. Every method is owner-scoped and tenant-scoped by its implementation. */
export interface UiReaders {
  documents(a: {
    limit: number;
    status: "all" | "ready" | "processing" | "failed";
  }): Promise<RawDocuments>;
  document(a: { id: string }): Promise<DocumentDto | null>;
  content(a: { id: string; upto: number; passage?: string }): Promise<RawContent | null>;
  source(a: { id: string; passage: string }): Promise<SourceResult | null>;
  chats(a: { q: string }): Promise<ChatSessionDto[]>;
}

/** The tool id the data provider calls through the transient invoker. */
export const INVOKE_ID = "docmind.read";

const Id = Uuid.transform((s) => s.toLowerCase());
const ARGS = {
  "documents.list": z
    .object({
      limit: z.number().int().min(1).max(LIST_CAP),
      status: z.enum(["all", "ready", "processing", "failed"]).default("all"),
    })
    .strict(),
  "document.get": z.object({ id: Id }).strict(),
  "document.content": z
    .object({
      id: Id,
      upto: z.number().int().min(1).max(CONTENT_CAP),
      passage: z.union([Id, z.literal("")]).default(""),
    })
    .strict(),
  "document.source": z.object({ id: Id, passage: Id.or(z.literal("")).default("") }).strict(),
  "chats.list": z.object({ q: z.string().max(100) }).strict(),
} as const;

/** Distinct reads one invoker (one hydrate POST) may start; identical reads share one and cost nothing. The rest are refused. */
export const MAX_READS_PER_BATCH = 8;

const fail = (channel: string): never => {
  throw new TypedFailure(channel, {});
};

/** A stable text for a call's input, so the same step asked twice (keys in any order) is one key. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : x,
  );

type Call = { key: unknown; exec: () => Promise<unknown> };

/**
 * An invoker over one request's readers. Arguments are parsed again here: a parameter is untrusted input, whatever the controller let through.
 * Identical calls (same tool id and PARSED input, so defaults and key order do not matter) share one read for the life of this invoker, which is one request: build a new one per hydrate call, never keep one.
 * A reader's answer is also clipped to the cap its call asked for, so a reader that over-returns cannot widen a view.
 */
export function createInvoker(readers: UiReaders): TransientInvoker {
  const memo = new Map<string, Promise<unknown>>();
  let started = 0;
  /** Validates synchronously and returns what to key and run; throws a TypedFailure on a refusal. */
  const plan = (toolId: string, input: unknown): Call => {
    if (toolId !== INVOKE_ID) return fail("unknownTool");
    const { target, args } = (input ?? {}) as { target?: unknown; args?: unknown };
    switch (target) {
      case "documents.list": {
        const a = ARGS["documents.list"].safeParse(args);
        if (!a.success) return fail("invalidArgs");
        return {
          key: [target, a.data],
          exec: async () => {
            const raw = await readers.documents(a.data);
            return {
              items: raw.items.slice(0, a.data.limit),
              truncated: raw.truncated || raw.items.length > a.data.limit,
            };
          },
        };
      }
      case "document.get": {
        const a = ARGS["document.get"].safeParse(args);
        if (!a.success) return fail("invalidArgs");
        return {
          key: [target, a.data],
          exec: async () => (await readers.document({ id: a.data.id })) ?? fail("notFound"),
        };
      }
      case "document.content": {
        const a = ARGS["document.content"].safeParse(args);
        if (!a.success) return fail("invalidArgs");
        return {
          key: [target, a.data],
          exec: async () => {
            const raw =
              (await readers.content({
                id: a.data.id,
                upto: a.data.upto,
                ...(a.data.passage !== "" && { passage: a.data.passage }),
              })) ?? fail("notFound");
            const keep = citedWindow(raw.items, a.data.upto, a.data.passage);
            const content: RawContent = {
              items: raw.items.slice(0, keep),
              more: raw.more || raw.items.length > keep,
            };
            return { content, cited: a.data.passage === "" ? undefined : a.data.passage };
          },
        };
      }
      case "document.source": {
        const a = ARGS["document.source"].safeParse(args);
        if (!a.success) return fail("invalidArgs");
        return {
          key: [target, a.data],
          exec: async () => (await readers.source(a.data)) ?? fail("notFound"),
        };
      }
      case "chats.list": {
        const a = ARGS["chats.list"].safeParse(args);
        if (!a.success) return fail("invalidArgs");
        return {
          key: [target, a.data],
          exec: async () => (await readers.chats({ q: a.data.q })).slice(0, CHAT_LIST_CAP),
        };
      }
      default:
        return fail("unknownTool");
    }
  };
  return {
    invokeTransient<TIn, TOut>(toolId: string, input: TIn): Promise<TOut> {
      try {
        const { key: k, exec } = plan(toolId, input);
        const key = stable(k);
        let p = memo.get(key);
        if (p === undefined) {
          if (started >= MAX_READS_PER_BATCH)
            return Promise.reject(new TypedFailure("readBudget", {}));
          started++;
          p = exec();
          memo.set(key, p);
          // A failure is not remembered: only the calls already waiting on it share it.
          p.catch(() => memo.delete(key));
        }
        return p as Promise<TOut>;
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
}
