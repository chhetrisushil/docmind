import { randomUUID } from "node:crypto";
import {
  type DocumentParser,
  ParseAbortedError,
  ParseCrashedError,
  ParseLimitError,
  ParseMemoryError,
  ParseRejectedError,
  ParseTimeoutError,
  ParserRegistry,
  createDefaultParsers,
} from "@docmind/parsers";
import { describe, expect, it, vi } from "vitest";
import { DocumentGoneError } from "../errors";
import type { IngestStartInput } from "../flow";
import { type ParseDeps, parseEffect } from "./parse";

const ref = (): IngestStartInput => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  documentId: randomUUID(),
});
const parsedDoc = {
  text: "hello big world",
  sections: [
    { headingPath: [], text: "hello", locator: { kind: "chars", start: 0, end: 5 } },
    { headingPath: [], text: "big", locator: { kind: "chars", start: 6, end: 9 } },
    { headingPath: [], text: "world", locator: { kind: "chars", start: 10, end: 15 } },
  ],
  media: [],
} as const;

function deps(over: Partial<ParseDeps> = {}) {
  const calls: string[] = [];
  const stored: unknown[] = [];
  const d: ParseDeps = {
    guard: { begin: async (_r, step) => void calls.push(`begin:${step}`) },
    source: {
      meta: async () => ({ mime: "text/plain", contentAddress: "hmac-sha256:x" }),
      read: async () => {
        calls.push("read");
        return new Uint8Array([104, 105]);
      },
    },
    parsed: {
      put: async (_r, p) => void stored.push(p),
      take: async () => undefined,
      drop: async () => {},
    },
    registry: new ParserRegistry(createDefaultParsers()),
    runner: {
      run: async (id) => {
        calls.push(`run:${id}`);
        return parsedDoc as never;
      },
    },
    ...over,
  };
  return { d, calls, stored };
}
const run = (d: ParseDeps, ctx: object = {}) => parseEffect(d).execute(ref(), ctx as never);
const meta = (mime: string) => ({
  meta: async () => ({ mime, contentAddress: "a" }),
  read: async (): Promise<Uint8Array> => {
    throw new Error("must not read");
  },
});

describe("parse step", () => {
  it("reads, parses with the parser chosen by mime, stores the result, and reports the section count", async () => {
    const { d, calls, stored } = deps();
    expect(await run(d)).toEqual({ outcome: "done", count: 3 });
    expect(calls).toEqual(["begin:parse", "read", "run:txt"]);
    expect(stored).toEqual([parsedDoc]);
  });

  it("fails permanently as unsupported_content when no parser accepts the mime, before reading the blob", async () => {
    const { d, calls } = deps({ source: meta("application/x-nothing") });
    expect(await run(d)).toEqual({ outcome: "failed", code: "unsupported_content" });
    expect(calls).toEqual(["begin:parse"]);
  });

  it("treats a parser whose accepts() throws as unsupported_content, never crashing with its message", async () => {
    const bad: DocumentParser = {
      id: "bad",
      accepts: () => {
        throw new Error("secret-detail");
      },
      parse: () => parsedDoc as never,
    };
    const { d, calls } = deps({ registry: new ParserRegistry([bad]), source: meta("text/plain") });
    expect(await run(d)).toEqual({ outcome: "failed", code: "unsupported_content" });
    expect(calls).toEqual(["begin:parse"]);
  });

  it.each([
    [new ParseRejectedError("corrupt_content"), "corrupt_content"],
    [new ParseRejectedError("too_large"), "too_large"],
    [new ParseRejectedError("unsupported_content"), "unsupported_content"],
    [new ParseTimeoutError(), "too_large"],
    [new ParseMemoryError(), "too_large"],
    [new ParseLimitError("input"), "too_large"],
  ])("maps %s to the failure code %s", async (error, code) => {
    const { d } = deps({
      runner: {
        run: async () => {
          throw error;
        },
      },
    });
    expect(await run(d)).toEqual({ outcome: "failed", code });
  });

  it.each([new ParseCrashedError(), new ParseAbortedError()])(
    "lets %s fail the step with a fixed message and no stored result",
    async (error) => {
      const { d, stored } = deps({
        runner: {
          run: async () => {
            throw error;
          },
        },
      });
      await expect(run(d)).rejects.toThrow(/^ingest step failed: parse$/);
      expect(stored).toEqual([]);
    },
  );

  it("propagates a cancellation without logging it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d } = deps({
      runner: {
        run: async () => {
          throw new ParseAbortedError();
        },
      },
    });
    await expect(run(d)).rejects.toThrow(/^ingest step failed: parse$/);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("hands the effect's AbortSignal to the runner, and none when the effect has none", async () => {
    const seen: unknown[] = [];
    const { d } = deps({
      runner: {
        run: async (_id, _b, opts) => {
          seen.push(opts);
          return parsedDoc as never;
        },
      },
    });
    const ac = new AbortController();
    await run(d, { signal: ac.signal });
    await run(d);
    expect(seen).toEqual([{ signal: ac.signal }, undefined]);
  });

  it("stops as document_gone, running no parser, when the blob is gone", async () => {
    const { d, calls } = deps({
      source: {
        meta: async () => ({ mime: "text/plain", contentAddress: "a" }),
        read: async () => {
          throw new DocumentGoneError();
        },
      },
    });
    expect(await run(d)).toEqual({ outcome: "document_gone" });
    expect(calls).toEqual(["begin:parse"]);
  });

  it("runs the guard first: a gone document reaches neither the source nor the parser", async () => {
    const calls: string[] = [];
    const { d } = deps({
      guard: {
        begin: async () => {
          calls.push("begin");
          throw new DocumentGoneError();
        },
      },
      source: {
        meta: async () => {
          calls.push("meta");
          return { mime: "text/plain", contentAddress: "a" };
        },
        read: async () => new Uint8Array(),
      },
      runner: {
        run: async () => {
          calls.push("run");
          return parsedDoc as never;
        },
      },
    });
    expect(await run(d)).toEqual({ outcome: "document_gone" });
    expect(calls).toEqual(["begin"]);
  });

  it("stops as document_gone when the document row is gone at meta", async () => {
    const { d } = deps({
      source: {
        meta: async () => {
          throw new DocumentGoneError();
        },
        read: async () => new Uint8Array(),
      },
    });
    expect(await run(d)).toEqual({ outcome: "document_gone" });
  });

  it("stops as document_gone when the document is deleted while the result is being stored", async () => {
    const { d } = deps({
      parsed: {
        put: async () => {
          throw Object.assign(new Error("fk"), {
            code: "23503",
            constraint: "parsed_documents_document_fkey",
          });
        },
        take: async () => undefined,
        drop: async () => {},
      },
    });
    expect(await run(d)).toEqual({ outcome: "document_gone" });
  });
});
