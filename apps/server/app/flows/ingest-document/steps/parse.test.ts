import { randomUUID } from "node:crypto";
import { LlmRefusalError, LlmRequestError, LlmUnavailableError } from "@docmind/llm-anthropic";
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
import { pngBytes } from "../imageFixtures";
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
      has: async () => false,
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

  it("skips the parser when an earlier generation already stored the parsed document", async () => {
    const { d, calls, stored } = deps();
    d.parsed.has = async () => true;
    expect(await run(d)).toEqual({ outcome: "done" });
    expect(calls).toEqual(["begin:parse"]); // no read, no child run
    expect(stored).toEqual([]);
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

  it("hands the runner an attempt signal that follows the effect's own cancel", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const { d } = deps({
      runner: {
        run: async (_id, _b, opts) => {
          signals.push(opts?.signal);
          return parsedDoc as never;
        },
      },
    });
    const ac = new AbortController();
    await run(d, { signal: ac.signal });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
    ac.abort();
    expect(signals[0]?.aborted).toBe(true);
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
        has: async () => false,
        drop: async () => {},
      },
    });
    expect(await run(d)).toEqual({ outcome: "document_gone" });
  });

  it("bounds an attempt whose database read never answers: the step fails with the fixed message, not a hang", async () => {
    let reads = 0;
    const { d } = deps({
      source: {
        meta: () => {
          reads++;
          return new Promise(() => {}); // a hung read that never settles
        },
        read: async () => new Uint8Array([104, 105]),
      },
      parseStepTimeoutMs: 5,
      attemptSettleMs: 0,
    });
    await expect(run(d)).rejects.toThrow(/^ingest step failed: parse$/);
    expect(reads).toBe(1); // a zombie is still running, so no second attempt overlaps it
  });

  it("passes the attempt signal to the parsed store's put", async () => {
    let seen: AbortSignal | undefined;
    const { d } = deps();
    d.parsed.put = async (_r, _p, signal) => {
      seen = signal;
    };
    await run(d, { signal: new AbortController().signal });
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});

describe("parse step: images", () => {
  const png = (w: number, h: number, pad = 0) => {
    const b = new Uint8Array(Math.max(29, pad));
    b.set(pngBytes(w, h));
    return b;
  };
  const imageSource = (bytes: Uint8Array, mime: string) => ({
    meta: async () => ({ mime, contentAddress: "a" }),
    read: async () => bytes,
  });
  const region = { kind: "region", page: 1, x: 0, y: 0, w: 640, h: 480 };

  it("reads an image with vision into two region sections and never calls the parser runner", async () => {
    const vision = { readImage: vi.fn(async () => ({ text: "HELLO", description: "A sign." })) };
    const { d, calls, stored } = deps({ source: imageSource(png(640, 480), "image/png"), vision });
    expect(await run(d)).toEqual({ outcome: "done", count: 2 });
    expect(calls).toEqual(["begin:parse"]);
    expect((stored[0] as { sections: unknown }).sections).toEqual([
      { headingPath: ["Text in the image"], text: "HELLO", locator: region },
      { headingPath: ["Description"], text: "A sign.", locator: region },
    ]);
  });

  it("allows an image whose base64 is exactly 5 MiB and just under it", async () => {
    for (const n of [3_932_160, 3_932_159]) {
      const vision = { readImage: vi.fn(async () => ({ text: "t", description: "d" })) };
      const { d } = deps({ source: imageSource(png(10, 10, n), "image/png"), vision });
      expect(await run(d)).toEqual({ outcome: "done", count: 2 });
    }
  });

  it("fails as vision_unavailable without a vision reader", async () => {
    const { d } = deps({ source: imageSource(png(640, 480), "image/png") });
    expect(await run(d)).toEqual({ outcome: "failed", code: "vision_unavailable" });
  });

  it("fails as too_large over 5 MiB or 8000 px, and corrupt_content when the header does not parse", async () => {
    const vision = { readImage: vi.fn() };
    const failed = async (bytes: Uint8Array) =>
      run(deps({ source: imageSource(bytes, "image/png"), vision }).d);
    // base64 crosses 5 MiB at 3,932,160 raw bytes (exactly 5,242,880 encoded): that is allowed.
    expect(await failed(png(10, 10, 3_932_161))).toMatchObject({ code: "too_large" });
    expect(await failed(png(10, 10, 5 * 1024 * 1024 + 1))).toMatchObject({ code: "too_large" });
    expect(await failed(png(8001, 10))).toMatchObject({ code: "too_large" });
    expect(await failed(new Uint8Array([0x89, 0x50]))).toMatchObject({ code: "corrupt_content" });
    expect(vision.readImage).not.toHaveBeenCalled();
  });

  it("maps a refusal to unsupported_content and a rejected request to corrupt_content; an outage is retried", async () => {
    const source = imageSource(png(640, 480), "image/png");
    const refuse = {
      readImage: vi.fn(async () => {
        throw new LlmRefusalError();
      }),
    };
    expect(await run(deps({ source, vision: refuse }).d)).toMatchObject({
      code: "unsupported_content",
    });
    const bad = {
      readImage: vi.fn(async () => {
        throw new LlmRequestError(400);
      }),
    };
    expect(await run(deps({ source, vision: bad }).d)).toMatchObject({ code: "corrupt_content" });
    let n = 0;
    const flaky = {
      readImage: vi.fn(async () => {
        if (n++ === 0) throw new LlmUnavailableError(529);
        return { text: "t", description: "d" };
      }),
    };
    const sleep = async () => {};
    expect((await run(deps({ source, vision: flaky, sleep }).d)).outcome).toBe("done");
    expect(flaky.readImage).toHaveBeenCalledTimes(2);
  });
});
