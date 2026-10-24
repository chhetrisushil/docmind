import { describe, expect, it } from "vitest";
import {
  DocumentContentResponse,
  DocumentDto,
  DocumentProgressEvent,
  DocumentSourceResponse,
  IngestStep,
  ListDocumentsQuery,
  Locator,
  ProgressDetail,
  RetryDocumentResponse,
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

  it("parses a retry response and refuses one without a document", () => {
    expect(RetryDocumentResponse.parse({ document: doc })).toEqual({ document: doc });
    expect(RetryDocumentResponse.safeParse({}).success).toBe(false);
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

  it("allows a step-less event only when failed, and detail only as a fixed code", () => {
    expect(DocumentProgressEvent.safeParse({ documentId: ID, status: "parsing" }).success).toBe(
      false,
    );
    expect(
      DocumentProgressEvent.safeParse({ documentId: ID, status: "failed", detail: "free text" })
        .success,
    ).toBe(false);
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

describe("ProgressDetail", () => {
  it("accepts vision_unavailable", () => {
    expect(ProgressDetail.parse("vision_unavailable")).toBe("vision_unavailable");
  });
});

describe("document content contract", () => {
  const passage = {
    passageId: ID,
    ordinal: 0,
    locator: { kind: "page", page: 1 },
    headingPath: ["Terms"],
    text: "Payment is due in 30 days.",
  };
  it("accepts a page of passages and a null cursor", () => {
    expect(DocumentContentResponse.parse({ items: [passage], nextCursor: null })).toEqual({
      items: [passage],
      nextCursor: null,
    });
  });
  it("refuses a passage with a bad id, a negative ordinal or a locator of an unknown kind", () => {
    for (const bad of [
      { ...passage, passageId: "x" },
      { ...passage, ordinal: -1 },
      { ...passage, locator: { kind: "line", n: 1 } },
    ])
      expect(DocumentContentResponse.safeParse({ items: [bad], nextCursor: null }).success).toBe(
        false,
      );
  });

  it("DocumentSourceResponse is strict and bounds focus", () => {
    expect(
      DocumentSourceResponse.safeParse({ format: "md", text: "x", truncated: false }).success,
    ).toBe(true);
    expect(
      DocumentSourceResponse.safeParse({ format: "pdf", text: "x", truncated: false }).success,
    ).toBe(false);
    expect(
      DocumentSourceResponse.safeParse({
        format: "md",
        text: "x",
        truncated: false,
        focus: { from: -1, to: 0 },
      }).success,
    ).toBe(false);
  });
});
