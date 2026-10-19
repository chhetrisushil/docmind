import { describe, expect, it } from "vitest";
import {
  DocumentDto,
  DocumentProgressEvent,
  IngestStep,
  ListDocumentsQuery,
  Locator,
} from "./index";

const ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-10-18T10:00:00.000Z";
const doc = {
  id: ID,
  title: "Q3 report",
  filename: "q3.pdf",
  mime: "application/pdf",
  sizeBytes: 1024,
  status: "ready",
  error: null,
  stats: null,
  summary: null,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("document contracts", () => {
  it("accepts a ready document and round-trips it", () => {
    expect(DocumentDto.parse(doc)).toEqual(doc);
  });

  it("rejects an unknown status and a negative size", () => {
    expect(DocumentDto.safeParse({ ...doc, status: "done" }).success).toBe(false);
    expect(DocumentDto.safeParse({ ...doc, sizeBytes: -1 }).success).toBe(false);
  });

  it("coerces list query strings and defaults the page size to 50", () => {
    expect(ListDocumentsQuery.parse({})).toEqual({ limit: 50 });
    expect(ListDocumentsQuery.parse({ limit: "20", cursor: "abc" })).toEqual({
      limit: 20,
      cursor: "abc",
    });
    expect(ListDocumentsQuery.safeParse({ limit: "500" }).success).toBe(false);
  });

  it("only accepts known ingest steps in progress events", () => {
    const event = { documentId: ID, step: "embed", status: "embedding" };
    expect(DocumentProgressEvent.parse(event)).toEqual(event);
    expect(DocumentProgressEvent.safeParse({ ...event, step: "ocr" }).success).toBe(false);
  });
});

describe("Locator", () => {
  it.each([
    { kind: "chars", start: 0, end: 10 },
    { kind: "section", index: 3 },
    { kind: "page", page: 1 },
    { kind: "paragraphs", from: 2, to: 4 },
    { kind: "region", page: 1, x: 0, y: 0, w: 10, h: 10 },
  ])("accepts %j", (locator) => {
    expect(Locator.parse(locator)).toEqual(locator);
  });

  it.each([
    [{ kind: "chars", start: 5, end: 4 }, "end before start"],
    [{ kind: "chars", start: -1, end: 4 }, "negative offset"],
    [{ kind: "page", page: 0 }, "page numbers start at 1"],
    [{ kind: "heading", path: ["Intro"] }, "heading text is content and has no place in a locator"],
    [{ kind: "chars", start: 0, end: 4, text: "secret" }, "extra field"],
  ])("rejects %j (%s)", (locator, _reason) => {
    expect(Locator.safeParse(locator).success).toBe(false);
  });
});

describe("progress events without a step", () => {
  it("accepts a terminal failed event that names no step, and still rejects an unknown step", () => {
    const failed = { documentId: ID, status: "failed", detail: "internal" };
    expect(DocumentProgressEvent.parse(failed)).toEqual(failed);
    expect(DocumentProgressEvent.safeParse({ ...failed, step: "ocr" }).success).toBe(false);
  });
});

describe("IngestStep", () => {
  it("lists the steps in flow order, with link after summarize", () => {
    expect(IngestStep.options).toEqual([
      "parse",
      "chunk",
      "embed",
      "analyze",
      "summarize",
      "link",
      "finalize",
    ]);
  });
});
