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

describe("performIntent: one request per row action at a time", () => {
  it("ignores a repeat of an action still in flight, then allows it again", async () => {
    let release: () => void = () => {};
    const t = ctx({
      retryDocument: vi.fn(
        () =>
          new Promise((r) => {
            release = () => r({});
          }),
      ),
    });
    const a = performIntent({ type: "document.retry", id: A }, t.c);
    const b = performIntent({ type: "document.retry", id: A }, t.c);
    release();
    await Promise.all([a, b]);
    expect(t.api.retryDocument).toHaveBeenCalledTimes(1);
    t.api.retryDocument.mockResolvedValueOnce({});
    await performIntent({ type: "document.retry", id: A }, t.c);
    expect(t.api.retryDocument).toHaveBeenCalledTimes(2);
  });
  it("a second delete while the confirmation is open does not open a second one", async () => {
    let answer: (v: boolean) => void = () => {};
    const t = ctx();
    t.confirm.mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          answer = r;
        }),
    );
    const a = performIntent({ type: "document.delete", id: A }, t.c);
    await performIntent({ type: "document.delete", id: A }, t.c);
    expect(t.confirm).toHaveBeenCalledTimes(1);
    answer(true);
    await a;
    expect(t.api.deleteDocument).toHaveBeenCalledTimes(1);
  });
});

describe("performIntent: the document", () => {
  it("shows more passages by raising the page size of the content handle, up to the cap", async () => {
    const t = ctx();
    const upto = { n: 20 };
    const c = { ...(t.c as object), upto: () => upto.n } as never;
    await performIntent({ type: "content.more" }, c);
    expect(t.session.setParams).toHaveBeenCalledWith({ upto: 40 }, "doc-content");
    upto.n = 200;
    await performIntent({ type: "content.more" }, c);
    expect(t.session.setParams).toHaveBeenLastCalledWith({ upto: 200 }, "doc-content");
  });
  it("opens a chat scoped to the open document for a suggested question", async () => {
    const t = ctx();
    const c = { ...(t.c as object), documentId: A } as never;
    await performIntent({ type: "document.ask-question", question: "When is it due?" }, c);
    expect(t.api.createChat).toHaveBeenCalledWith({ scope: { documentIds: [A] } });
    expect(t.router.navigate).toHaveBeenCalledWith({ name: "chat", chatId: "c1" });
    expect(JSON.stringify(t.router.navigate.mock.calls)).not.toContain("due");
    expect(t.toasts.push).not.toHaveBeenCalled();
  });
  it("refuses a question when no document is open", async () => {
    const t = ctx();
    expect(await performIntent({ type: "document.ask-question", question: "Q?" }, t.c)).toBe(false);
    expect(t.api.createChat).not.toHaveBeenCalled();
  });
  it("a double activation of a question starts one chat", async () => {
    let release: () => void = () => {};
    const t = ctx({
      createChat: vi.fn(
        () =>
          new Promise((r) => {
            release = () => r({ id: "c1" });
          }),
      ),
    });
    const c = { ...(t.c as object), documentId: A } as never;
    const a = performIntent({ type: "document.ask-question", question: "Q?" }, c);
    const b = performIntent({ type: "document.ask-question", question: "Q?" }, c);
    release();
    await Promise.all([a, b]);
    expect(t.api.createChat).toHaveBeenCalledTimes(1);
  });
  it("after a delete, hands over to onDeleted instead of refreshing the view", async () => {
    const t = ctx();
    const onDeleted = vi.fn();
    await performIntent({ type: "document.delete", id: A }, {
      ...(t.c as object),
      onDeleted,
    } as never);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(t.session.invalidate).not.toHaveBeenCalled();
  });
  it("does not navigate to the new chat when the page is no longer active", async () => {
    const t = ctx();
    const c = { ...(t.c as object), documentId: A, active: () => false } as never;
    await performIntent({ type: "document.ask-question", question: "Q?" }, c);
    expect(t.router.navigate).not.toHaveBeenCalled();
  });
});
