import type { Intent } from "@docmind/contracts";
import type { Api } from "../api/client";
import { ApiError } from "../api/http";
import { report } from "../report";
import type { Router } from "../router";
import type { Outbox } from "../state/outbox";
import type { Store } from "../state/store";
import type { ToastStore } from "../state/toasts";
import type { ViewSession } from "../ui/session";

export interface PerformContext {
  api: Api;
  router: Router;
  toasts: ToastStore;
  session: Pick<ViewSession, "invalidate" | "setParams">;
  /** The document the page has open and was served (set by the document page only). */
  documentId?: string;
  /** Where a suggested question waits for the chat page that sends it. */
  outbox?: Store<Outbox>;
  /** The page size the content handle has now. */
  upto?(): number;
  /** False once the page that asked has gone or moved on: a late answer then navigates nowhere. */
  active?(): boolean;
  /** The page leaves the deleted document itself: called instead of refreshing the view. */
  onDeleted?(): void;
  confirm(heading: string, body: string, confirmLabel: string, danger?: boolean): Promise<boolean>;
  /** A text prompt (the sidebar's rename): undefined for cancel, empty or unchanged. */
  prompt?(
    heading: string,
    label: string,
    initial: string,
    confirmLabel: string,
  ): Promise<string | undefined>;
  /** The title the served table holds for a chat ("" when untitled). */
  titleOf?(id: string): string;
  /** The chat the route has open, read when needed. */
  readonly openChatId?: string | undefined;
}

/** At most 200 UTF-16 units (the contract's limit), never ending in half a surrogate pair. */
const clip = (title: string): string => {
  const cut = title.slice(0, 200);
  const last = cut.charCodeAt(cut.length - 1);
  return cut.length === 200 && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

const err = (toasts: ToastStore, text: string) => toasts.push({ kind: "err", text });

/** Row actions in flight, by action and id: a repeat is ignored until the first one is done (loom-ui's disabled buttons are not the only guard). */
const busy = new Set<string>();

/** The web's execution of the surface-neutral intents. Returns false for an intent another page handles. Texts are fixed sentences. */
export async function performIntent(intent: Intent, c: PerformContext): Promise<boolean> {
  const key =
    "id" in intent
      ? `${intent.type}:${intent.id}`
      : intent.type === "document.ask-question" && c.documentId !== undefined
        ? `${intent.type}:${c.documentId}`
        : undefined;
  if (key === undefined) return perform(intent, c);
  if (busy.has(key)) return true;
  busy.add(key);
  try {
    return await perform(intent, c);
  } finally {
    busy.delete(key);
  }
}

async function perform(intent: Intent, c: PerformContext): Promise<boolean> {
  switch (intent.type) {
    case "document.open":
      c.router.navigate({ name: "document", id: intent.id });
      return true;
    case "document.ask":
      try {
        const chat = await c.api.createChat({ scope: { documentIds: [intent.id] } });
        if (c.active?.() !== false) c.router.navigate({ name: "chat", chatId: chat.id });
      } catch {
        err(c.toasts, "Could not start a chat about that document.");
      }
      return true;
    case "document.retry":
      try {
        await c.api.retryDocument(intent.id);
        c.session.invalidate();
        c.toasts.push({ kind: "ok", text: "Retrying." });
      } catch (e) {
        err(
          c.toasts,
          e instanceof ApiError && e.code === "not_failed"
            ? "That document is not in a failed state."
            : "Could not retry that document.",
        );
      }
      return true;
    case "document.delete": {
      if (
        !(await c.confirm(
          "Delete this document?",
          "It is removed for good, and chats can no longer cite it.",
          "Delete",
          true,
        ))
      )
        return true;
      try {
        await c.api.deleteDocument(intent.id);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) {
          err(c.toasts, "Could not delete that document.");
          return true;
        }
      }
      c.toasts.push({ kind: "ok", text: "Document deleted." });
      if (c.onDeleted) c.onDeleted();
      else c.session.invalidate();
      return true;
    }
    case "document.ask-question": {
      if (c.documentId === undefined) return false;
      try {
        const chat = await c.api.createChat({ scope: { documentIds: [c.documentId] } });
        if (c.active?.() !== false) c.outbox?.set({ chatId: chat.id, text: intent.question });
        if (c.active?.() !== false) c.router.navigate({ name: "chat", chatId: chat.id });
      } catch {
        err(c.toasts, "Could not start a chat about that document.");
      }
      return true;
    }
    case "source.open":
      c.router.navigate({ name: "document", id: intent.documentId, passage: intent.passageId });
      return true;
    case "content.more":
      c.session.setParams({ upto: Math.min(200, (c.upto?.() ?? 20) + 20) }, "doc-content");
      return true;
    case "chat.open":
      c.router.navigate({ name: "chat", chatId: intent.id });
      return true;
    case "chat.rename": {
      const title = await c.prompt?.("Rename chat", "Title", c.titleOf?.(intent.id) ?? "", "Save");
      if (title === undefined || c.active?.() === false) return true;
      try {
        await c.api.patchChat(intent.id, { title: clip(title) });
        c.session.invalidate("chats");
      } catch (e) {
        report("intent", e);
        err(c.toasts, "Could not rename that chat.");
      }
      return true;
    }
    case "chat.delete": {
      if (
        !(await c.confirm(
          "Delete this chat?",
          "Its messages are removed for good.",
          "Delete",
          true,
        ))
      )
        return true;
      try {
        await c.api.deleteChat(intent.id);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) {
          report("intent", e);
          err(c.toasts, "Could not delete that chat.");
          return true;
        }
      }
      c.session.invalidate("chats");
      if (c.openChatId === intent.id && c.active?.() !== false) c.router.navigate({ name: "chat" });
      return true;
    }
    case "chats.search":
      c.session.setParams({ q: intent.q }, "chats");
      return true;
    case "documents.filter":
      c.session.setParams({ status: intent.status }, "documents");
      return true;
    default:
      return false;
  }
}
