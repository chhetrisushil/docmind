import type { ChatSessionDto, DocumentDto, DocumentPassage } from "@docmind/contracts";
import { checkKindValue } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { formatBytes } from "./format";
import { shape } from "./reshapers";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const doc = (n: number, over: Partial<DocumentDto> = {}): DocumentDto => ({
  id: id(n),
  title: `Title ${n}`,
  filename: `f${n}.pdf`,
  mime: "application/pdf",
  sizeBytes: 1536,
  status: "ready",
  error: null,
  stats: null,
  summary: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  ...over,
});
const stats = {
  wordCount: 1200,
  pageCount: 4,
  readingTimeMinutes: 6,
  language: "en",
  outline: ["Terms"],
  dates: ["2026-01-01"],
  numbers: ["30"],
};
const summary = {
  tldr: "Due in 30 days.",
  keyPoints: ["Net 30"],
  entities: ["Acme"],
  topics: ["Payment"],
  suggestedQuestions: ["When is it due?"],
};
const raw = (items: DocumentDto[], truncated = false) => ({ items, truncated });

const valid = (kind: string, value: unknown) =>
  expect(checkKindValue(kind, value).ok, `${kind}: ${JSON.stringify(value).slice(0, 120)}`).toBe(
    true,
  );

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1536, "1.5 KB"],
    [3.2 * 1024 * 1024, "3.2 MB"],
  ])("%s is %s", (n, s) => expect(formatBytes(n)).toBe(s));
});

describe("the library shapes", () => {
  const items = [
    doc(1),
    doc(2, { status: "failed", error: "Could not read this file." }),
    doc(3, { status: "parsing" }),
  ];
  it("count the library and the ready documents", () => {
    expect(shape("library-total", raw(items))).toEqual({ value: 3, label: "in your library" });
    expect(shape("library-total", raw(items, true))).toMatchObject({ label: "Newest 200 shown" });
    expect(shape("library-ready", raw(items))).toEqual({ value: 1 });
    valid("Kpi", shape("library-total", raw(items)));
    expect(shape("library-total", raw(items, true))).toEqual({
      value: 3,
      label: "Newest 200 shown",
    });
  });
  it("never present a count of a capped list as exact", () => {
    expect(shape("library-ready", raw(items, true))).toEqual({
      value: 1,
      label: "among the newest 200",
    });
    expect(shape("library-ready", raw(items))).toEqual({ value: 1 });
    valid("Kpi", shape("library-ready", raw(items, true)));
    expect(shape("library-health", raw([doc(1)], true))).toMatchObject({
      level: "ok",
      detail: "Only the newest 200 documents are counted.",
    });
    valid("StatusCard", shape("library-health", raw([doc(1)], true)));
    expect(shape("library-health", raw(items, true))).toMatchObject({
      level: "critical",
      headline: "at least 1 document failed",
    });
  });
  it("say how the ingest is going: failed beats processing beats ok", () => {
    expect(shape("library-health", raw(items))).toMatchObject({
      level: "critical",
      headline: "1 document failed",
    });
    expect(
      shape(
        "library-health",
        raw([doc(1), doc(3, { status: "parsing" }), doc(4, { status: "embedding" })]),
      ),
    ).toMatchObject({ level: "warning", headline: "2 documents being processed" });
    expect(shape("library-health", raw([doc(1)]))).toMatchObject({
      level: "ok",
      headline: "Everything is ready",
    });
    valid("StatusCard", shape("library-health", raw(items)));
  });
  it("draw the table with keys and only the actions that fit each row", () => {
    const t = shape("library-table", raw(items)) as {
      columns: string[];
      rows: unknown[][];
      rowKeys: string[];
      rowActions: { id: string }[][];
    };
    expect(t.columns).toEqual(["Name", "Type", "Size", "Status", "Added"]);
    expect(t.rows[0]).toEqual(["Title 1", "PDF", "1.5 KB", "Ready", "2026-10-01"]);
    expect(t.rows[1]?.[3]).toBe("Failed");
    expect(t.rowKeys).toEqual([id(1), id(2), id(3)]);
    expect(t.rowActions.map((a) => a.map((x) => x.id))).toEqual([
      ["open", "ask", "delete"],
      ["open", "retry", "delete"],
      ["open", "delete"],
    ]);
    valid("Table", t);
  });
});

describe("the detail shapes", () => {
  const ready = doc(1, { stats, summary });
  it("status: the level follows the document, a failure carries the fixed sentence", () => {
    expect(shape("detail-status", ready)).toEqual({ level: "ok", headline: "Ready" });
    expect(
      shape("detail-status", doc(2, { status: "failed", error: "Could not read this file." })),
    ).toEqual({ level: "critical", headline: "Failed", detail: "Could not read this file." });
    expect(shape("detail-status", doc(3, { status: "embedding" }))).toMatchObject({
      level: "warning",
      headline: "Indexing",
    });
  });
  it("summary: text, points, meta and questions with their index", () => {
    expect(shape("detail-summary", ready)).toEqual({
      tldr: "Due in 30 days.",
      keyPoints: [{ text: "Net 30" }],
      meta: "Topics: Payment. Entities: Acme.",
      questions: [{ label: "When is it due?", index: 0 }],
    });
    expect(shape("detail-summary", doc(2))).toMatchObject({
      tldr: "The summary appears when the document is ready.",
      keyPoints: [],
      questions: [],
    });
  });
  it("statistics as Kpis, and facts as a table", () => {
    expect(shape("detail-words", ready)).toEqual({ value: 1200, unit: "words" });
    expect(shape("detail-pages", ready)).toEqual({ value: 4, unit: "pages" });
    expect(shape("detail-pages", doc(4, { stats: { ...stats, pageCount: null } }))).toEqual({
      value: 0,
      unit: "pages",
      label: "not applicable",
    });
    expect(shape("detail-minutes", doc(5))).toEqual({ value: 0, unit: "min", label: "not ready" });
    expect(shape("detail-facts", ready)).toEqual({
      columns: ["Fact", "Value"],
      rows: [
        ["Language", "en"],
        ["Date", "2026-01-01"],
        ["Key figure", "30"],
        ["Outline", "Terms"],
      ],
    });
    for (const h of ["detail-words", "detail-pages", "detail-minutes"])
      valid("Kpi", shape(h, ready));
    valid("Table", shape("detail-facts", ready));
  });
});

describe("the content shape", () => {
  const p = (n: number, over: Partial<DocumentPassage> = {}): DocumentPassage => ({
    passageId: id(100 + n),
    ordinal: n,
    locator: { kind: "page", page: n + 1 },
    headingPath: ["Terms", `Clause ${n}`],
    text: `passage ${n}`,
    ...over,
  });
  it("lists passages with where they sit, and offers more only when there is more", () => {
    const d = shape("detail-content", {
      content: { items: [p(0), p(1)], more: true },
      cited: undefined,
    }) as { note: string; passages: { head: string; text: string }[]; more: { label: string }[] };
    expect(d.passages).toEqual([
      { head: "Page 1 - Terms > Clause 0", text: "passage 0" },
      { head: "Page 2 - Terms > Clause 1", text: "passage 1" },
    ]);
    expect(d.note).toBe("Showing the first 2 passages.");
    expect(d.more).toEqual([{ label: "Show 20 more passages" }]);
    expect(
      shape("detail-content", { content: { items: [p(0)], more: false }, cited: undefined }),
    ).toMatchObject({ note: "All 1 passages.", more: [] });
    expect(
      shape("detail-content", { content: { items: [], more: false }, cited: undefined }),
    ).toMatchObject({ note: "This document has no extracted text.", passages: [] });
  });
  it("moves the cited passage first and says so", () => {
    const d = shape("detail-content", {
      content: { items: [p(0), p(1), p(2)], more: false },
      cited: id(102),
    }) as { passages: { head: string }[] };
    expect(d.passages[0]?.head).toBe("Cited passage - Page 3 - Terms > Clause 2");
    expect(d.passages).toHaveLength(3);
  });
  it.each([
    [{ kind: "section", index: 2 }, "Section 3"],
    [{ kind: "chars", start: 120, end: 480 }, "Characters 120-480"],
    [{ kind: "paragraphs", from: 4, to: 6 }, "Paragraphs 4-6"],
    [{ kind: "region", page: 2, x: 0, y: 0, w: 1, h: 1 }, "Page 2, region"],
  ])("names the locator %j as %s", (locator, name) => {
    const d = shape("detail-content", {
      content: {
        items: [p(0, { locator: locator as DocumentPassage["locator"], headingPath: [] })],
        more: false,
      },
      cited: undefined,
    }) as { passages: { head: string }[] };
    expect(d.passages[0]?.head).toBe(name);
  });
});

describe("the sessions shape", () => {
  const chat = (n: number, title: string | null): ChatSessionDto => ({
    id: id(n),
    title,
    scope: "all",
    createdAt: "2026-10-01T10:00:00.000Z",
    lastMessageAt: n === 1 ? "2026-10-05T10:00:00.000Z" : null,
    messageCount: 1,
  });
  it("titles, dates, keys and actions", () => {
    const t = shape("sessions-table", [chat(1, "Invoices"), chat(2, null)]) as {
      rows: unknown[][];
      rowKeys: string[];
      rowActions: { id: string }[][];
    };
    expect(t.rows).toEqual([
      ["Invoices", "2026-10-05"],
      ["New chat", "2026-10-01"],
    ]);
    expect(t.rowKeys).toEqual([id(1), id(2)]);
    expect(t.rowActions[0]?.map((a) => a.id)).toEqual(["open", "rename", "delete"]);
    valid("Table", t);
  });
  it("a published handle is never shaped from data", () =>
    expect(() => shape("host-published", {})).toThrow(/published/));
});

describe("detail-source", () => {
  it("maps md/org/txt to Prose formats", () => {
    expect(
      shape("detail-source", { applicable: true, format: "md", text: "# a", truncated: false }),
    ).toEqual({ applicable: true, format: "markdown", text: "# a" });
    expect(
      shape("detail-source", { applicable: true, format: "org", text: "* a", truncated: false }),
    ).toMatchObject({ format: "org" });
    expect(
      shape("detail-source", { applicable: true, format: "txt", text: "a", truncated: false }),
    ).toMatchObject({ format: "plain" });
  });
  it("notes a truncated source and passes focus", () => {
    const out = shape("detail-source", {
      applicable: true,
      format: "md",
      text: "x",
      truncated: true,
      focus: { from: 0, to: 1 },
    });
    expect(out).toEqual({
      applicable: true,
      format: "markdown",
      text: "x",
      truncated: true,
      focus: { from: 0, to: 1 },
      note: "Showing the first part of this document.",
    });
    valid("Prose", out);
  });
  it("is an empty plain value when the format is not rendered", () => {
    const out = shape("detail-source", { applicable: false });
    expect(out).toEqual({ applicable: false, format: "plain", text: "" });
    valid("Prose", out);
  });
});
