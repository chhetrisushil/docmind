import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobMissingError, DocumentGoneError } from "../errors";
import { type ParseDeps, parseEffect } from "./parse";

const ref = { tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() };
const parser = { id: "txt", accepts: () => true, parse: async () => ({}) };

function deps(over: Partial<ParseDeps> & { guardGone?: { after: number } } = {}) {
  let guardCalls = 0;
  const d: ParseDeps = {
    guard: {
      begin: async () => {
        guardCalls += 1;
        if (over.guardGone && guardCalls > over.guardGone.after) throw new DocumentGoneError();
      },
    },
    source: {
      meta: async () => ({ mime: "text/plain", contentAddress: "x" }),
      read: async () => {
        throw new BlobMissingError();
      },
    },
    parsed: {
      put: async () => {},
      take: async () => null,
      has: async () => false,
      drop: async () => {},
    } as never,
    registry: { select: () => parser } as never,
    runner: { run: async () => ({ text: "", sections: [], media: [] }) } as never,
    sleep: async () => {},
    ...over,
  };
  return d;
}

afterEach(() => vi.restoreAllMocks());

describe("parseEffect with a missing blob", () => {
  it("fails a live document fatally as internal, once, logging the class and a fixed reason", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const read = vi.fn(async () => {
      throw new BlobMissingError();
    });
    const d = deps({
      source: { meta: async () => ({ mime: "text/plain", contentAddress: "x" }), read },
    });
    await expect(parseEffect(d).execute(ref, {} as never)).rejects.toThrow(
      /^ingest step failed: parse$/,
    );
    expect(read).toHaveBeenCalledTimes(1); // fatal: no retry
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([
      "ingest step failed",
      "parse",
      "BlobMissingError",
      "blob missing for a live document",
    ]);
  });

  it("stays document_gone when the row is gone too", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await parseEffect(deps({ guardGone: { after: 1 } })).execute(ref, {} as never);
    expect(out).toEqual({ outcome: "document_gone" });
    expect(spy).not.toHaveBeenCalled();
  });
});
