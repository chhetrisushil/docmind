import { ChatStreamEvent } from "@docmind/contracts";
import { TABLE_ROW_ACTION, compileFingerprint, tableRowProblems } from "@loom-ui/core/browser";
import { ChatFeed } from "@loom-ui/core/chat";
import {
  CHAT_REF_OPEN_ACTION,
  chatMarkdownLines,
  parseChatMarkdown,
  resolveMdMarkers,
  splitRefMarkers,
} from "@loom-ui/core/chat-ui";
import { HydrationStore } from "@loom-ui/hydration/client";
import { type DomRenderHandle, litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import "@loom-ui/renderer-lit/elements/lu-note";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { report } from "./report";

afterEach(() => vi.restoreAllMocks());

// A hand-built blueprint: this test proves the links resolve and the renderer draws; composing views is the server's job.
const note = {
  _tag: "Blueprint",
  irVersion: "2.5.0",
  id: "scaffold@sha256:0",
  title: "",
  layout: {
    type: "grid",
    id: "root",
    columns: 12,
    children: [
      {
        span: 12,
        node: {
          _tag: "Widget",
          id: "n",
          kind: "Note",
          props: { text: "Hello <b>there</b>" },
          source: { type: "Note", version: "1.0.0" },
        },
      },
    ],
  },
  projections: [],
  projectionVersions: {},
};

describe("the web scaffold", () => {
  it("resolves the browser-safe loom-ui entries and Loom's ESM runtime, and renderer-lit draws a Note as text", async () => {
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "scaffold" });
    const host = document.createElement("div");
    document.body.append(host);
    const handle: DomRenderHandle = renderBlueprintDom(host, note as never, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry: litRegistry,
      title: "none",
    });
    await vi.waitFor(() =>
      expect(host.querySelector("lu-note")?.shadowRoot?.textContent).toContain(
        "Hello <b>there</b>",
      ),
    );
    expect(host.querySelector("b")).toBeNull();
    expect(typeof compileFingerprint({ locale: "en" })).toBe("string");
    handle.dispose();
  });

  it("resolves the chat fold entry of @loom-ui/core", () => {
    const feed = new ChatFeed({ mode: "owner", reasoning: true });
    feed.applyEvent("status", { state: "open", running: true });
    expect(feed.value().running).toBe(true);
  });

  it("resolves @docmind/contracts to its sources", () => {
    expect(ChatStreamEvent.safeParse({ kind: "closed" }).success).toBe(true);
    expect(ChatStreamEvent.safeParse({ kind: "answer", turn: 1 }).success).toBe(false);
  });

  it("report logs the scope and the error class, never the message", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    report("sse", new TypeError("sentinel-title-0123456789"));
    report("sse", "a string with sentinel-answer-0123456789");
    expect(error.mock.calls).toEqual([["sse TypeError"], ["sse string"]]);
  });
});

describe("the loom-ui pin carries the generic additions DocMind needs", () => {
  it("has Table row actions (176a)", () => {
    expect(TABLE_ROW_ACTION).toBe("TABLE_ROW_ACTION");
    expect(
      tableRowProblems({ rows: [["a"]], rowActions: [[{ id: "open", label: "Open" }]] }).map(
        (p) => p.message,
      ),
    ).toEqual(["rowActions need rowKeys"]);
  });
  it("has Chat reference markers (176b)", () => {
    expect(CHAT_REF_OPEN_ACTION).toBe("CHAT_REF_OPEN");
    expect(splitRefMarkers("a [[x1]]", new Set(["x1"]), { hideAll: false })).toEqual([
      { type: "text", text: "a " },
      { type: "ref", id: "x1", n: 1 },
    ]);
  });
  it("has opt-in markdown for assistant text (176c to 176k)", () => {
    const doc = parseChatMarkdown("Due **now** [[a1]] [x](javascript:alert(1))", { markers: true });
    const shown = resolveMdMarkers(doc, new Set(["a1"]), { hideAll: false });
    expect(JSON.stringify(shown)).toContain('"type":"strong"');
    expect(JSON.stringify(shown)).toContain('"type":"ref"');
    expect(JSON.stringify(shown)).not.toContain("javascript:");
    expect(chatMarkdownLines(shown).join("\n")).toBe("Due **now** [1] x");
    expect(new ChatFeed({ markdown: true }).value().entries).toEqual([]);
  });
});
