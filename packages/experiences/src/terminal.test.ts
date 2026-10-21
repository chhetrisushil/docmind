import type { DocumentDto } from "@docmind/contracts";
import { HydrationStore, SplitHydrationController } from "@loom-ui/hydration";
import { renderExperience } from "@loom-ui/renderer-terminal";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it, vi } from "vitest";
import type { UiReaders } from "./invoker";
import { createViews } from "./views-api";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const doc = (n: number, over: Partial<DocumentDto> = {}): DocumentDto => ({
  id: id(n),
  title: `Contract ${n}`,
  filename: `c${n}.pdf`,
  mime: "application/pdf",
  sizeBytes: 2048,
  status: "ready",
  error: null,
  stats: {
    wordCount: 900,
    pageCount: 3,
    readingTimeMinutes: 4,
    language: "en",
    outline: ["Terms"],
    dates: [],
    numbers: [],
  },
  summary: {
    tldr: "Payment is due in 30 days.",
    keyPoints: ["Net 30"],
    entities: ["Acme"],
    topics: ["Payment"],
    suggestedQuestions: ["When is it due?"],
  },
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  ...over,
});
const readers: UiReaders = {
  documents: async () => ({
    items: [doc(1), doc(2, { status: "failed", error: "Could not read this file." })],
    truncated: false,
  }),
  document: async (a) => (a.id === id(1) ? doc(1) : null),
  content: async () => ({
    items: [
      {
        passageId: id(50),
        ordinal: 0,
        locator: { kind: "page", page: 1 },
        headingPath: ["Terms"],
        text: "Payment is due in 30 days.",
      },
    ],
    more: false,
  }),
  chats: async () => [
    {
      id: id(7),
      title: "Invoices",
      scope: "all",
      createdAt: "2026-10-01T10:00:00.000Z",
      lastMessageAt: null,
      messageCount: 0,
    },
  ],
};
const views = createViews({ placeholderKey: "k".repeat(32), revisionKey: "r".repeat(32) });
type View = "library" | "library-empty" | "detail" | "sessions" | "chat" | "sources";

/** A terminal surface in miniature: fetch the compiled view, hydrate it through the same server function, bind it. */
function open(view: View, params: Record<string, string> = {}) {
  const p = views.payload(view, "terminal");
  const store = new HydrationStore(new InMemoryProjectionRuntime(), {
    experienceId: p.experienceId,
  });
  const loader = {
    load: async (r: never, _s: AbortSignal) =>
      (await views.hydrate(view, [r], readers, "user-1"))[0],
    loadMany: async (rs: readonly never[]) => views.hydrate(view, rs, readers, "user-1"),
  };
  const split = new SplitHydrationController({ loader: loader as never, store, batchWindowMs: 0 });
  split.setParams(params);
  split.load(p.inventory);
  return { p, store, split };
}
const draw = (h: ReturnType<typeof open>) => renderExperience(h.p.blueprint, h.store);

async function frame(view: View, params: Record<string, string> = {}): Promise<string> {
  const h = open(view, params);
  await vi.waitFor(() =>
    expect(Object.values(h.store.state().status).every((s) => s.state !== "pending")).toBe(true),
  );
  return draw(h);
}
const A2UI_PLACEHOLDER = "A2UIView: [A2UI view — rendered on the web]";

describe("the terminal surface", () => {
  it("draws the library: counts, health and the table, from the very data the web is given", async () => {
    const out = await frame("library");
    expect(out).toContain("Contract 1");
    expect(out).toContain("Failed");
    expect(out.split("\n").some((l) => /\b2\b/.test(l) && l.includes("in your library"))).toBe(
      true,
    );
  });
  it("draws the empty state", async () =>
    expect(await frame("library-empty")).toContain("No documents yet"));
  it("draws the document: status, outline and facts; the A2UIView tabs have no terminal drawing", async () => {
    const out = await frame("detail", { id: id(1) });
    expect(out).toContain("Ready");
    expect(out).toContain("Terms");
    expect(out).toContain(A2UI_PLACEHOLDER);
    expect(out).not.toContain("Payment is due in 30 days.");
  });
  it("draws the chat list", async () => expect(await frame("sessions")).toContain("Invoices"));
  it("a document that is not the caller's is an error row on the terminal too, with no content", async () => {
    const out = await frame("detail", { id: id(9) });
    expect(out).not.toContain("Contract");
    expect(out).toContain('✗ Status: handle "doc-status": could not be loaded');
  });
  it("draws a published markdown reply as readable lines, with the cited ref numbered and no control characters", async () => {
    const h = open("chat");
    const r = h.split.publishValue(
      "transcript",
      {
        entries: [
          {
            id: "t1.user",
            turn: 1,
            role: "user",
            status: "complete",
            parts: [{ type: "text", text: "When is it due?" }],
          },
          {
            id: "t1.assistant",
            turn: 1,
            role: "assistant",
            status: "complete",
            parts: [
              {
                type: "text",
                text: "# Terms\n\nDue **30 days** [[a1]]\n\n- Net 30",
                format: "markdown",
              },
            ],
            refs: [{ id: "a1" }],
          },
        ],
        refMarkers: true,
        state: "open",
      },
      { kind: "Chat" },
    );
    expect(r).toEqual({ ok: true });
    const out = draw(h);
    expect(out).toContain("Due **30 days** [1]");
    expect(out).toContain("- Net 30");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
  });
});
