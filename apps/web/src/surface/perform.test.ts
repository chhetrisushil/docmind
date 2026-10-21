import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { performIntent } from "./perform";

const A = "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10";
function ctx(over: Record<string, unknown> = {}) {
  const api = {
    createChat: vi.fn(async () => ({ id: "c1" })),
    retryDocument: vi.fn(async () => ({})),
    deleteDocument: vi.fn(async () => {}),
    ...over,
  };
  const router = { navigate: vi.fn() };
  const toasts = { push: vi.fn() };
  const session = { invalidate: vi.fn(), setParams: vi.fn() };
  const confirm = vi.fn(async () => true);
  return {
    c: { api, router, toasts, session, confirm } as never,
    api,
    router,
    toasts,
    session,
    confirm,
  };
}

describe("performIntent: documents", () => {
  it("opens a document", async () => {
    const t = ctx();
    expect(await performIntent({ type: "document.open", id: A }, t.c)).toBe(true);
    expect(t.router.navigate).toHaveBeenCalledWith({ name: "document", id: A });
  });
  it("starts a chat scoped to the document and opens it", async () => {
    const t = ctx();
    await performIntent({ type: "document.ask", id: A }, t.c);
    expect(t.api.createChat).toHaveBeenCalledWith({ scope: { documentIds: [A] } });
    expect(t.router.navigate).toHaveBeenCalledWith({ name: "chat", chatId: "c1" });
  });
  it("retries, refreshes the view and says so; a failure is a fixed sentence", async () => {
    const t = ctx();
    await performIntent({ type: "document.retry", id: A }, t.c);
    expect(t.session.invalidate).toHaveBeenCalled();
    expect(t.toasts.push).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ok", text: "Retrying." }),
    );
    const bad = ctx({
      retryDocument: vi.fn(async () => {
        throw new ApiError(409, "not_failed");
      }),
    });
    await performIntent({ type: "document.retry", id: A }, bad.c);
    expect(bad.toasts.push).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "err", text: "That document is not in a failed state." }),
    );
  });
  it("deletes only after the user confirms, and treats a missing document as deleted", async () => {
    const no = ctx();
    no.confirm.mockResolvedValueOnce(false);
    await performIntent({ type: "document.delete", id: A }, no.c);
    expect(no.api.deleteDocument).not.toHaveBeenCalled();
    const yes = ctx();
    await performIntent({ type: "document.delete", id: A }, yes.c);
    expect(yes.confirm).toHaveBeenCalledWith(
      "Delete this document?",
      expect.any(String),
      "Delete",
      true,
    );
    expect(yes.api.deleteDocument).toHaveBeenCalledWith(A);
    expect(yes.session.invalidate).toHaveBeenCalled();
    const gone = ctx({
      deleteDocument: vi.fn(async () => {
        throw new ApiError(404, "not_found");
      }),
    });
    await performIntent({ type: "document.delete", id: A }, gone.c);
    expect(gone.toasts.push).toHaveBeenCalledWith(expect.objectContaining({ kind: "ok" }));
  });
  it("filters by status through the table's parameter, and leaves an intent it does not know", async () => {
    const t = ctx();
    await performIntent({ type: "documents.filter", status: "failed" }, t.c);
    expect(t.session.setParams).toHaveBeenCalledWith({ status: "failed" }, "documents");
    expect(await performIntent({ type: "chat.older" }, t.c)).toBe(false);
  });
});
