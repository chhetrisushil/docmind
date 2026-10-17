import { describe, expect, it } from "vitest";
import { DocumentDto, DocumentProgressEvent, ListDocumentsQuery } from "./index";

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
