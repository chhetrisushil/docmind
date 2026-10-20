import { unwrapTainted } from "@loom/classify";
import { describe, expect, it } from "vitest";
import { type DocumentSummaryView, type ListedDocument, documentEffects } from "./documents";
import { ChatToolInputError } from "./harness";
import { DOC_A, DOC_B, harness, toolCtx, vectorScope } from "./testing";

const VIEW: DocumentSummaryView = {
  title: "Nocturne planning memo",
  summary: {
    tldr: "Plan for Q3.",
    keyPoints: ["Revenue"],
    entities: ["Acme"],
    topics: ["plan"],
    suggestedQuestions: ["What is the forecast?"],
  },
  stats: {
    wordCount: 900,
    pageCount: 3,
    readingTimeMinutes: 4,
    language: "en",
    outline: ["Plan"],
    dates: [],
    numbers: [],
  },
};
const LISTED: ListedDocument = {
  documentId: DOC_A,
  title: "Nocturne planning memo",
  mime: "application/pdf",
  status: "ready",
  createdAt: "2026-10-01T00:00:00.000Z",
};

function setup(opts: {
  view?: DocumentSummaryView | null;
  listed?: ListedDocument[];
  scope?: Parameters<typeof harness>[0];
}) {
  const h = harness(opts.scope ?? "all");
  const calls: { op: string; args: unknown[] }[] = [];
  const documents = {
    async summary(...args: unknown[]) {
      calls.push({ op: "summary", args });
      return opts.view ?? null;
    },
    async list(...args: unknown[]) {
      calls.push({ op: "list", args });
      return opts.listed ?? [];
    },
  };
  return { ...h, calls, e: documentEffects({ ...h.deps, documents }) };
}

describe("get_summary", () => {
  it("returns the title, summary and stats, and records a count-1 step (no passages)", async () => {
    const s = setup({ view: VIEW });
    const out = unwrapTainted(await s.e.get_summary.execute({ documentId: DOC_A }, toolCtx()));
    expect(out).toEqual({ documentId: DOC_A, ...VIEW });
    expect(s.calls).toEqual([{ op: "summary", args: [vectorScope, DOC_A] }]);
    expect(s.items.puts.map((p) => p.item)).toEqual([
      {
        kind: "tool",
        body: {
          name: "get_summary",
          label: 'Read the summary of "Nocturne planning memo"',
          count: 1,
        },
      },
    ]);
  });

  it("answers not_found identically for a missing document and for one outside the chat's scope, and never reads the latter", async () => {
    const missing = setup({ view: null });
    const outside = setup({ view: VIEW, scope: { documentIds: [DOC_B] } });
    const a = unwrapTainted(await missing.e.get_summary.execute({ documentId: DOC_A }, toolCtx()));
    const b = unwrapTainted(await outside.e.get_summary.execute({ documentId: DOC_A }, toolCtx()));
    expect([a, b]).toEqual([{ error: "not_found" }, { error: "not_found" }]);
    expect(missing.items.puts).toEqual(outside.items.puts);
    expect(outside.calls).toEqual([]);
  });

  it("returns null summary and stats for a document the ingest steps have not finished", async () => {
    const s = setup({ view: { title: "T", summary: null, stats: null } });
    expect(unwrapTainted(await s.e.get_summary.execute({ documentId: DOC_A }, toolCtx()))).toEqual({
      documentId: DOC_A,
      title: "T",
      summary: null,
      stats: null,
    });
  });

  it.each([
    ["a non-uuid", { documentId: "doc" }],
    ["an extra key", { documentId: DOC_A, ownerId: "x" }],
  ])("refuses %s", async (_n, input) => {
    const s = setup({ view: VIEW });
    await expect(s.e.get_summary.execute(input, toolCtx())).rejects.toBeInstanceOf(
      ChatToolInputError,
    );
  });
});

describe("list_documents", () => {
  it("lists within the chat's scope with limit 20 by default", async () => {
    const s = setup({ listed: [LISTED], scope: { documentIds: [DOC_A] } });
    const out = unwrapTainted(await s.e.list_documents.execute({}, toolCtx()));
    expect(out).toEqual({ documents: [LISTED] });
    expect(s.calls).toEqual([
      { op: "list", args: [vectorScope, { documentIds: [DOC_A], limit: 20 }] },
    ]);
    expect(s.items.puts.map((p) => p.item)).toEqual([
      { kind: "tool", body: { name: "list_documents", label: "Listed documents", count: 1 } },
    ]);
  });

  it("passes the title filter and limit, and says so in the label", async () => {
    const s = setup({ listed: [] });
    await s.e.list_documents.execute({ titleContains: "  memo ", limit: 50 }, toolCtx());
    expect(s.calls[0]?.args[1]).toEqual({ titleContains: "memo", limit: 50 });
    expect((s.items.puts[0]?.item as { body: { label: string } }).body.label).toBe(
      'Listed documents matching "memo"',
    );
  });

  it.each([
    ["limit 0", { limit: 0 }],
    ["limit 51", { limit: 51 }],
    ["a blank filter", { titleContains: " " }],
    ["a 101-character filter", { titleContains: "x".repeat(101) }],
    ["an extra key", { scope: "all" }],
  ])("refuses %s", async (_n, input) => {
    const s = setup({});
    await expect(s.e.list_documents.execute(input, toolCtx())).rejects.toBeInstanceOf(
      ChatToolInputError,
    );
    expect(s.calls).toEqual([]);
  });
});
