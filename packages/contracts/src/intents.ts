import { Uuid } from "./common";
import type { ViewName } from "./ui";

export type Intent =
  | { type: "document.open"; id: string }
  | { type: "document.ask"; id: string }
  | { type: "document.retry"; id: string }
  | { type: "document.delete"; id: string }
  | { type: "documents.filter"; status: "all" | "ready" | "processing" | "failed" }
  | { type: "document.ask-question"; question: string }
  | { type: "content.more" }
  | { type: "source.open"; passageId: string; documentId: string }
  | { type: "chat.open"; id: string }
  | { type: "chat.rename"; id: string }
  | { type: "chat.delete"; id: string }
  | { type: "chats.search"; q: string }
  | { type: "chat.send"; text: string; key: string }
  | { type: "chat.scope"; scope: "all" | "started" }
  | { type: "chat.cite"; entryId: string; refId: string }
  | { type: "chat.older" };

/** What the surface itself holds, so an action is looked up and never believed: the row keys of the table it drew, the list it published. */
export interface Held {
  rowKeys?: readonly string[];
  list?: readonly unknown[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** An own property only: a payload cannot reach the prototype chain. */
const own = (r: Record<string, unknown>, k: string): unknown =>
  Object.hasOwn(r, k) ? r[k] : undefined;
const isUuid = (v: unknown): v is string => typeof v === "string" && Uuid.safeParse(v).success;

const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_KEY = 200;
const STATUSES = ["all", "ready", "processing", "failed"] as const;
type Status = (typeof STATUSES)[number];

const DOCUMENT_ROW = ["open", "ask", "retry", "delete"] as const;
const CHAT_ROW = ["open", "rename", "delete"] as const;

/** The row key as the surface was given it (never the payload's spelling), or undefined when it was not given. */
const heldId = (key: unknown, held: Held): string | undefined => {
  if (!isUuid(key) || !Array.isArray(held.rowKeys)) return undefined;
  const want = key.toLowerCase();
  const found = (held.rowKeys as readonly unknown[]).find(
    (k) => typeof k === "string" && k.toLowerCase() === want,
  );
  return isUuid(found) ? found : undefined;
};
const heldAt = (context: unknown, list: unknown): unknown => {
  if (!isRecord(context) || !Array.isArray(list)) return undefined;
  const i = own(context, "index");
  return typeof i === "number" && Number.isInteger(i) && i >= 0 && i < list.length
    ? (list as readonly unknown[])[i]
    : undefined;
};
const member = <T extends string>(set: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" ? set.find((s) => s === v) : undefined;

function resolve(
  view: ViewName,
  type: string,
  p: Record<string, unknown>,
  held: Held,
): Intent | undefined {
  switch (view) {
    case "library": {
      if (type === "TABLE_ROW_ACTION") {
        const a = member(DOCUMENT_ROW, own(p, "action"));
        const id = a === undefined ? undefined : heldId(own(p, "rowKey"), held);
        return a !== undefined && id !== undefined ? { type: `document.${a}`, id } : undefined;
      }
      if (type === "SELECT") {
        const status: Status | undefined = member(STATUSES, own(p, "value"));
        return status === undefined ? undefined : { type: "documents.filter", status };
      }
      return undefined;
    }
    case "detail": {
      if (type !== "A2UI_ACTION") return undefined;
      const a = own(p, "action");
      if (a === "show-more") return { type: "content.more" };
      if (a === "ask-question") {
        const q = heldAt(own(p, "context"), held.list);
        return typeof q === "string" ? { type: "document.ask-question", question: q } : undefined;
      }
      return undefined;
    }
    case "sessions": {
      if (type === "TABLE_ROW_ACTION") {
        const a = member(CHAT_ROW, own(p, "action"));
        const id = a === undefined ? undefined : heldId(own(p, "rowKey"), held);
        return a !== undefined && id !== undefined ? { type: `chat.${a}`, id } : undefined;
      }
      const text = own(p, "text");
      if (type === "SUBMIT_TEXT" && typeof text === "string") {
        const q = text.trim();
        return q.length <= 100 ? { type: "chats.search", q } : undefined;
      }
      return undefined;
    }
    case "chat": {
      if (type === "SUBMIT_TEXT") {
        const raw = own(p, "text");
        const key = own(p, "key");
        if (typeof raw !== "string" || typeof key !== "string") return undefined;
        const text = raw.trim();
        return text.length >= 1 && text.length <= 4000 && key.length >= 1 && key.length <= MAX_KEY
          ? { type: "chat.send", text, key }
          : undefined;
      }
      if (type === "SELECT") {
        const v = own(p, "value");
        return v === "all" || v === "started" ? { type: "chat.scope", scope: v } : undefined;
      }
      if (type === "CHAT_REF_OPEN") {
        const entryId = own(p, "entryId");
        const refId = own(p, "refId");
        return typeof entryId === "string" &&
          ENTRY_ID.test(entryId) &&
          typeof refId === "string" &&
          ENTRY_ID.test(refId)
          ? { type: "chat.cite", entryId, refId }
          : undefined;
      }
      if (type === "LOAD_OLDER") return { type: "chat.older" };
      return undefined;
    }
    case "sources": {
      if (type !== "A2UI_ACTION" || own(p, "action") !== "open-source") return undefined;
      const s = heldAt(own(p, "context"), held.list);
      if (!isRecord(s)) return undefined;
      const passageId = own(s, "passageId");
      const documentId = own(s, "documentId");
      return isUuid(passageId) && isUuid(documentId)
        ? { type: "source.open", passageId, documentId }
        : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * The one place that says what a widget action means for DocMind, for every surface. Total: it never throws, and
 * `undefined` means "not an action of this view". The action is untrusted: its name must be on its view's closed list,
 * and an id or a text is taken from what the surface holds (`held`), never from the payload.
 */
export function intentOf(
  view: ViewName,
  action: { type: string; payload?: unknown },
  held: Held = {},
): Intent | undefined {
  try {
    if (!isRecord(action) || typeof action.type !== "string" || !isRecord(held)) return undefined;
    const p = action.payload;
    return isRecord(p) ? resolve(view, action.type, p, held) : undefined;
  } catch {
    return undefined;
  }
}
