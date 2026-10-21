import { describe, expect, it } from "vitest";
import { intentOf } from "./intents";

const A = "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10";
const B = "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11";
const row = (action: string, rowKey: string) => ({
  type: "TABLE_ROW_ACTION",
  payload: { action, rowKey },
});
const held = { rowKeys: [A, B] };

describe("intentOf: the library", () => {
  it.each(["open", "ask", "retry", "delete"])("%s a row the surface holds", (a) =>
    expect(intentOf("library", row(a, A), held)).toEqual({ type: `document.${a}`, id: A }),
  );
  it("refuses a row key the surface was not given, an id that is not a uuid, and an action name that is not on the list", () => {
    expect(
      intentOf("library", row("open", "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a99"), held),
    ).toBeUndefined();
    expect(intentOf("library", row("open", "nope"), { rowKeys: ["nope"] })).toBeUndefined();
    expect(intentOf("library", row("rename", A), held)).toBeUndefined();
    expect(intentOf("library", row("open", A))).toBeUndefined();
  });
  it("turns a status choice into a filter, and refuses any other value", () => {
    expect(intentOf("library", { type: "SELECT", payload: { value: "failed", key: "k" } })).toEqual(
      { type: "documents.filter", status: "failed" },
    );
    expect(
      intentOf("library", { type: "SELECT", payload: { value: "; drop", key: "k" } }),
    ).toBeUndefined();
  });
});

describe("intentOf: the document", () => {
  it("asks a suggested question by index into the list the surface holds, never by the text in the action", () => {
    expect(
      intentOf(
        "detail",
        {
          type: "A2UI_ACTION",
          payload: { action: "ask-question", context: { label: "FORGED", index: 1 } },
        },
        { list: ["a?", "b?"] },
      ),
    ).toEqual({ type: "document.ask-question", question: "b?" });
    expect(
      intentOf(
        "detail",
        { type: "A2UI_ACTION", payload: { action: "ask-question", context: { index: 5 } } },
        { list: ["a?"] },
      ),
    ).toBeUndefined();
    expect(
      intentOf(
        "detail",
        { type: "A2UI_ACTION", payload: { action: "ask-question", context: "x" } },
        { list: ["a?"] },
      ),
    ).toBeUndefined();
  });
  it("shows more passages, and nothing else from the A2UI vocabulary", () => {
    expect(
      intentOf("detail", { type: "A2UI_ACTION", payload: { action: "show-more", context: {} } }),
    ).toEqual({ type: "content.more" });
    expect(
      intentOf("detail", {
        type: "A2UI_ACTION",
        payload: { action: "delete-everything", context: {} },
      }),
    ).toBeUndefined();
  });
});

describe("intentOf: chats", () => {
  it("opens, renames and deletes a chat the surface holds; the sessions view cannot delete a document", () => {
    expect(intentOf("sessions", row("rename", B), held)).toEqual({ type: "chat.rename", id: B });
    expect(intentOf("sessions", row("delete", A), held)).toEqual({ type: "chat.delete", id: A });
    expect(intentOf("sessions", row("retry", A), held)).toBeUndefined();
  });
  it("searches with trimmed text of at most 100 characters", () => {
    expect(
      intentOf("sessions", {
        type: "SUBMIT_TEXT",
        payload: { text: "  invoices ", key: "k".repeat(20) },
      }),
    ).toEqual({ type: "chats.search", q: "invoices" });
    expect(
      intentOf("sessions", { type: "SUBMIT_TEXT", payload: { text: "x".repeat(101), key: "k" } }),
    ).toBeUndefined();
  });
  it("sends a trimmed message with the widget's key, and refuses an empty or over-long one", () => {
    expect(
      intentOf("chat", {
        type: "SUBMIT_TEXT",
        payload: { text: " hello ", key: "key-0123456789abcdef" },
      }),
    ).toEqual({ type: "chat.send", text: "hello", key: "key-0123456789abcdef" });
    expect(
      intentOf("chat", {
        type: "SUBMIT_TEXT",
        payload: { text: "   ", key: "key-0123456789abcdef" },
      }),
    ).toBeUndefined();
    expect(
      intentOf("chat", {
        type: "SUBMIT_TEXT",
        payload: { text: "x".repeat(4001), key: "key-0123456789abcdef" },
      }),
    ).toBeUndefined();
  });
  it("switches the scope, cites a source, and loads older turns", () => {
    expect(intentOf("chat", { type: "SELECT", payload: { value: "started", key: "k" } })).toEqual({
      type: "chat.scope",
      scope: "started",
    });
    expect(
      intentOf("chat", { type: "SELECT", payload: { value: "everything", key: "k" } }),
    ).toBeUndefined();
    expect(
      intentOf(
        "chat",
        {
          type: "CHAT_REF_OPEN",
          payload: { entryId: "t1.assistant", refId: A, n: 1 },
        },
        { refs: new Map([["t1.assistant", [A]]]) },
      ),
    ).toEqual({ type: "chat.cite", entryId: "t1.assistant", refId: A });
    expect(
      intentOf("chat", { type: "CHAT_REF_OPEN", payload: { entryId: "bad id", refId: A, n: 1 } }),
    ).toBeUndefined();
    expect(intentOf("chat", { type: "LOAD_OLDER", payload: { cursor: "1.2" } })).toEqual({
      type: "chat.older",
    });
  });
});

describe("intentOf: sources", () => {
  const list = [{ passageId: A, documentId: B }];
  it("opens a source by index into the sources the surface published", () => {
    expect(
      intentOf(
        "sources",
        {
          type: "A2UI_ACTION",
          payload: { action: "open-source", context: { index: 0, passageId: "FORGED" } },
        },
        { list },
      ),
    ).toEqual({ type: "source.open", passageId: A, documentId: B });
    expect(
      intentOf(
        "sources",
        { type: "A2UI_ACTION", payload: { action: "open-source", context: { index: 1 } } },
        { list },
      ),
    ).toBeUndefined();
  });
});

describe("intentOf: anything else", () => {
  it("an action type no view lists, a missing payload and a view with no actions are refused", () => {
    expect(intentOf("library", { type: "SANDBOX_ACTION", payload: {} })).toBeUndefined();
    expect(intentOf("library", { type: "TABLE_ROW_ACTION" })).toBeUndefined();
    expect(
      intentOf("library-empty", { type: "SELECT", payload: { value: "all", key: "k" } }),
    ).toBeUndefined();
  });
});

describe("intentOf: hostile payloads (actions are untrusted)", () => {
  const act = (action: string, context: unknown) => ({
    type: "A2UI_ACTION",
    payload: { action, context },
  });
  it("an index must be an own, non-negative integer inside the held list", () => {
    const list = ["a?", "b?"];
    for (const index of [
      "0",
      1.5,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2,
      null,
      [0],
      { valueOf: () => 0 },
    ])
      expect(intentOf("detail", act("ask-question", { index }), { list })).toBeUndefined();
    expect(intentOf("detail", act("ask-question", {}), { list })).toBeUndefined();
    expect(intentOf("detail", act("ask-question", { index: 0 }))).toBeUndefined();
    expect(
      intentOf("detail", act("ask-question", JSON.parse('{"__proto__":{"index":0}}')), { list }),
    ).toBeUndefined();
    expect(intentOf("sources", act("open-source", { index: 0 }), { list: [] })).toBeUndefined();
    expect(
      intentOf("sources", act("open-source", {}), { list: [{ passageId: A, documentId: B }] }),
    ).toBeUndefined();
  });
  it("a held entry of the wrong shape is refused, not trusted", () => {
    for (const s of [{ passageId: "x", documentId: B }, { passageId: A }, "str", null, [A, B]])
      expect(intentOf("sources", act("open-source", { index: 0 }), { list: [s] })).toBeUndefined();
    expect(
      intentOf("detail", act("ask-question", { index: 0 }), { list: [{ q: 1 }] }),
    ).toBeUndefined();
  });
  it("prototype keys are not action names, row keys or views", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(intentOf("library", row(name, A), held)).toBeUndefined();
      expect(intentOf("library", row("open", name), { rowKeys: [name] })).toBeUndefined();
      expect(intentOf(name as never, row("open", A), held)).toBeUndefined();
      expect(intentOf("detail", act(name, {}))).toBeUndefined();
      expect(intentOf("library", { type: name, payload: {} })).toBeUndefined();
    }
    expect(intentOf("library", row("open", "__proto__"), { rowKeys: [] })).toBeUndefined();
  });
  it("the id comes from what the surface holds, in the held spelling; a key is matched case-insensitively", () => {
    const upper = A.toUpperCase();
    expect(intentOf("library", row("open", upper), held)).toEqual({ type: "document.open", id: A });
  });
  it("a row action on a view that has no table, and the wrong type for the view, are refused", () => {
    expect(intentOf("chat", row("open", A), held)).toBeUndefined();
    expect(intentOf("detail", row("open", A), held)).toBeUndefined();
    expect(intentOf("sources", row("open", A), held)).toBeUndefined();
    expect(
      intentOf("library", { type: "SUBMIT_TEXT", payload: { text: "x", key: "k" } }),
    ).toBeUndefined();
    expect(
      intentOf("sessions", { type: "SELECT", payload: { value: "all", key: "k" } }),
    ).toBeUndefined();
    expect(
      intentOf("chat", { type: "A2UI_ACTION", payload: { action: "show-more", context: {} } }),
    ).toBeUndefined();
  });
  it("text and keys: non-strings, a missing or over-long key, and a ref that is not an id", () => {
    expect(
      intentOf("chat", { type: "SUBMIT_TEXT", payload: { text: 5, key: "k" } }),
    ).toBeUndefined();
    expect(intentOf("chat", { type: "SUBMIT_TEXT", payload: { text: "hi" } })).toBeUndefined();
    expect(
      intentOf("chat", { type: "SUBMIT_TEXT", payload: { text: "hi", key: "k".repeat(129) } }),
    ).toBeUndefined();
    expect(
      intentOf("chat", { type: "CHAT_REF_OPEN", payload: { entryId: "t1", refId: "a b", n: 1 } }),
    ).toBeUndefined();
    expect(
      intentOf(
        "chat",
        { type: "CHAT_REF_OPEN", payload: { entryId: "t1", refId: A } },
        { refs: new Map([["t1", [A]]]) },
      ),
    ).toEqual({ type: "chat.cite", entryId: "t1", refId: A });
    expect(
      intentOf("sessions", { type: "SUBMIT_TEXT", payload: { text: 5, key: "k" } }),
    ).toBeUndefined();
  });
  it("never throws: a throwing getter, a null action, a non-object payload", () => {
    const evil = {
      type: "TABLE_ROW_ACTION",
      get payload(): unknown {
        throw new Error("boom");
      },
    };
    expect(intentOf("library", evil, held)).toBeUndefined();
    for (const a of [
      null,
      undefined,
      5,
      "x",
      { type: 5, payload: {} },
      { type: "SELECT", payload: [] },
      { type: "SELECT", payload: "x" },
    ])
      expect(intentOf("library", a as never, held)).toBeUndefined();
    expect(intentOf("library", row("open", A), { rowKeys: 5 as never })).toBeUndefined();
    expect(intentOf("library", row("open", A), null as never)).toBeUndefined();
  });
});

describe("intentOf: fix round 1", () => {
  const cite = (entryId: string, refId: string) => ({
    type: "CHAT_REF_OPEN",
    payload: { entryId, refId, n: 1 },
  });
  const refs = new Map([["t1.assistant", [A]]]);
  it("chat.cite resolves entry and ref only against the refs the server served", () => {
    expect(intentOf("chat", cite("t1.assistant", A), { refs })).toEqual({
      type: "chat.cite",
      entryId: "t1.assistant",
      refId: A,
    });
    expect(intentOf("chat", cite("t9.assistant", A), { refs })).toBeUndefined();
    expect(intentOf("chat", cite("t1.assistant", B), { refs })).toBeUndefined();
    expect(intentOf("chat", cite("t1.assistant", A))).toBeUndefined();
    expect(intentOf("chat", cite("__proto__", A), { refs })).toBeUndefined();
    expect(intentOf("chat", cite("constructor", A), { refs: {} as never })).toBeUndefined();
  });
  it("chat.cite returns the held spelling of the ref", () => {
    const up = A.toUpperCase();
    expect(
      intentOf("chat", cite("t1.assistant", A), { refs: new Map([["t1.assistant", [up]]]) }),
    ).toEqual({ type: "chat.cite", entryId: "t1.assistant", refId: up });
  });
  it("chat.send needs loom-ui's key shape", () => {
    const send = (key: string) =>
      intentOf("chat", { type: "SUBMIT_TEXT", payload: { text: "hi", key } });
    expect(send("k".repeat(15))).toBeUndefined();
    expect(send(`${"k".repeat(15)}/`)).toBeUndefined();
    expect(send(`${"k".repeat(15)} `)).toBeUndefined();
    expect(send("k".repeat(129))).toBeUndefined();
    expect(send("a_b-".repeat(4))).toEqual({
      type: "chat.send",
      text: "hi",
      key: "a_b-".repeat(4),
    });
  });
  it("held uppercase, payload lowercase: the held spelling is returned", () => {
    const up = A.toUpperCase();
    expect(intentOf("library", row("open", A), { rowKeys: [up] })).toEqual({
      type: "document.open",
      id: up,
    });
  });
  it("a suggested question is capped at 4000 characters", () => {
    const a = { type: "A2UI_ACTION", payload: { action: "ask-question", context: { index: 0 } } };
    expect(intentOf("detail", a, { list: ["x".repeat(4001)] })).toBeUndefined();
    expect(intentOf("detail", a, { list: [""] })).toBeUndefined();
    expect(intentOf("detail", a, { list: ["x".repeat(4000)] })).toBeTruthy();
  });
});
