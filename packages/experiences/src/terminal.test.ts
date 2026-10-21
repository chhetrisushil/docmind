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
const readersFor = (titles: [string, string]): UiReaders => ({
  documents: async () => ({
    items: [
      doc(1, { title: titles[0] }),
      doc(2, { title: titles[1], status: "failed", error: "Could not read this file." }),
    ],
    truncated: false,
  }),
  document: async (a) => (a.id === id(1) ? doc(1, { title: titles[0] }) : null),
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
});
const readers = readersFor(["Contract 1", "Contract 2"]);
const views = createViews({ placeholderKey: "k".repeat(32), revisionKey: "r".repeat(32) });
type View = "library" | "library-empty" | "detail" | "sessions" | "chat" | "sources";

/**
 * A terminal surface in miniature: fetch the compiled view, hydrate it through the same server function, bind it.
 * `hydrate` runs with outputKinds for the web because it is the one shared server function: values do not depend on the surface.
 */
function open(
  view: View,
  params: Record<string, string> = {},
  rd: UiReaders = readers,
  who = "user-1",
) {
  const p = views.payload(view, "terminal");
  const store = new HydrationStore(new InMemoryProjectionRuntime(), {
    experienceId: p.experienceId,
  });
  const loader = {
    load: async (r: never, _s: AbortSignal) => (await views.hydrate(view, [r], rd, who))[0],
    loadMany: async (rs: readonly never[]) => views.hydrate(view, rs, rd, who),
  };
  const split = new SplitHydrationController({ loader: loader as never, store, batchWindowMs: 0 });
  split.setParams(params);
  split.load(p.inventory);
  return { p, store, split };
}
const draw = (h: ReturnType<typeof open>) => renderExperience(h.p.blueprint, h.store);

const settled = (h: ReturnType<typeof open>) =>
  vi.waitFor(() =>
    expect(Object.values(h.store.state().status).every((s) => s.state !== "pending")).toBe(true),
  );
async function frame(
  view: View,
  params: Record<string, string> = {},
  rd: UiReaders = readers,
  who = "user-1",
): Promise<string> {
  const h = open(view, params, rd, who);
  await settled(h);
  return draw(h);
}
const A2UI_PLACEHOLDER = "A2UIView: [A2UI view — rendered on the web]";

describe("the terminal surface", () => {
  it("draws the library: counts, health and the table, from the very data the web is given", async () => {
    const out = await frame("library");
    expect(out).toContain("Contract 1");
    expect(out.split("\n").some((l) => l.includes("Contract 2") && l.includes("Failed"))).toBe(
      true,
    );
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
  it("a document the reader does not return (null) is an error row on the terminal, with no content", async () => {
    const out = await frame("detail", { id: id(9) });
    expect(out).not.toContain("Contract");
    expect(out).toContain('✗ Status: handle "doc-status": could not be loaded');
  });
  it("draws a published markdown reply as readable lines and lets no hostile code point through", async () => {
    const h = open("chat");
    await settled(h);
    const c = String.fromCharCode;
    const hostile = `${c(27)}[2J${c(27)}]52;c;cGF5${c(7)} ${c(0x202e)}${c(0x9b)}31m${c(0)}`;
    const forbidden = [c(27), c(7), c(0), c(0x202e), c(0x9b)];
    const r = h.split.publishValue(
      "transcript",
      {
        entries: [
          {
            id: "t1.user",
            turn: 1,
            role: "user",
            status: "complete",
            parts: [{ type: "text", text: `When${hostile} is it due?` }],
          },
          {
            id: "t1.assistant",
            turn: 1,
            role: "assistant",
            status: "complete",
            parts: [
              {
                type: "text",
                text: `# Terms\n\nDue${hostile} **30 days** [[a1]]\n\n- Net 30 ${hostile}paid`,
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
    for (const ch of forbidden)
      expect(out.includes(ch), `U+${ch.charCodeAt(0).toString(16)}`).toBe(false);
    for (const word of ["When", "is it due?", "# Terms", "Due", "- Net 30", "paid"])
      expect(out).toContain(word);
    // Intentional: the loom-ui terminal leaves emphasis as typed; only the [[ref]] marker is rewritten to a number.
    expect(out).toContain("**30 days** [1]");
  });
  // Cross-user isolation is not provable here: the server binds readers to an identity. It is tested in Task 188's UI-plane pg test.
});
