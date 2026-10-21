import type { Intent } from "@docmind/contracts";
import type { Api } from "../api/client";
import { ApiError } from "../api/http";
import type { Router } from "../router";
import type { ToastStore } from "../state/toasts";
import type { ViewSession } from "../ui/session";

export interface PerformContext {
  api: Api;
  router: Router;
  toasts: ToastStore;
  session: Pick<ViewSession, "invalidate" | "setParams">;
  confirm(heading: string, body: string, confirmLabel: string, danger?: boolean): Promise<boolean>;
}

const err = (toasts: ToastStore, text: string) => toasts.push({ kind: "err", text });

/** Row actions in flight, by action and id: a repeat is ignored until the first one is done (loom-ui's disabled buttons are not the only guard). */
const busy = new Set<string>();

/** The web's execution of the surface-neutral intents. Returns false for an intent another page handles. Texts are fixed sentences. */
export async function performIntent(intent: Intent, c: PerformContext): Promise<boolean> {
  const key = "id" in intent ? `${intent.type}:${intent.id}` : undefined;
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
        c.router.navigate({ name: "chat", chatId: chat.id });
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
      c.session.invalidate();
      c.toasts.push({ kind: "ok", text: "Document deleted." });
      return true;
    }
    case "documents.filter":
      c.session.setParams({ status: intent.status }, "documents");
      return true;
    default:
      return false;
  }
}
