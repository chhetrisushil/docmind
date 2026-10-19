import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_FKEY_CONSTRAINTS, DocumentGoneError } from "../errors";
import type { IngestStartInput } from "../flow";
import { type ChunkDeps, chunkEffect } from "./chunk";

const SECRET = "Nocturne quarterly revenue forecast";
const parsed = {
  text: `${SECRET}.`,
  sections: [
    {
      headingPath: ["H"],
      text: `${SECRET}.`,
      locator: { kind: "chars", start: 0, end: SECRET.length + 1 },
    },
  ],
  media: [],
} as const;
const ref = (): IngestStartInput => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  documentId: randomUUID(),
});
function deps(over: Partial<ChunkDeps> = {}) {
  const calls: string[] = [];
  const d: ChunkDeps = {
    guard: { begin: async (_r, s) => void calls.push(`begin:${s}`) },
    parsed: {
      put: async () => {},
      take: async () => {
        calls.push("take");
        return parsed as never;
      },
      drop: async () => void calls.push("drop"),
    },
    chunks: {
      replace: async (_r, c) => {
        calls.push(`replace:${c.length}`);
        return c.length;
      },
      count: async () => {
        calls.push("count");
        return 7;
      },
      read: async () => [],
    },
    sleep: async () => {},
    ...over,
  };
  return { d, calls };
}
const run = (d: ChunkDeps) => chunkEffect(d).execute(ref(), {} as never);
const parsedPort = (take: () => Promise<unknown>, drop: () => Promise<void> = async () => {}) => ({
  put: async () => {},
  take: take as never,
  drop,
});

afterEach(() => vi.restoreAllMocks());

describe("the chunk step", () => {
  it("chunks the parsed document, stores the chunks, then drops the parsed row, in that order", async () => {
    const { d, calls } = deps();
    expect(await run(d)).toEqual({ outcome: "done", count: 1 });
    expect(calls).toEqual(["begin:chunk", "take", "replace:1", "drop"]);
  });

  it("after a crash between the drop and the event, finds no parsed row and reports the chunks that exist", async () => {
    const { d, calls } = deps({ parsed: parsedPort(async () => undefined) });
    expect(await run(d)).toEqual({ outcome: "done", count: 7 });
    expect(calls).toEqual(["begin:chunk", "count"]);
  });

  it("when the drop fails after the chunks were stored, the retry stores them again and drops", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let drops = 0;
    const { d, calls } = deps();
    d.parsed.drop = async () => {
      calls.push("drop");
      if (++drops === 1) throw new Error("connection reset");
    };
    expect(await run(d)).toEqual({ outcome: "done", count: 1 });
    expect(calls).toEqual([
      "begin:chunk",
      "take",
      "replace:1",
      "drop",
      "begin:chunk",
      "take",
      "replace:1",
      "drop",
    ]);
  });

  it("an empty document yields zero chunks and still drops the parsed row", async () => {
    const empty = { text: "", sections: [], media: [] };
    const { d, calls } = deps();
    d.parsed.take = async () => empty as never;
    expect(await run(d)).toEqual({ outcome: "done", count: 0 });
    expect(calls).toEqual(["begin:chunk", "replace:0", "drop"]);
  });

  it("returns a count only: no text reaches the result", async () => {
    const { d } = deps();
    const result = await run(d);
    expect(Object.keys(result).sort()).toEqual(["count", "outcome"]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each<[string, Partial<ChunkDeps>]>([
    [
      "the parsed read",
      {
        parsed: parsedPort(async () => {
          throw new DocumentGoneError();
        }),
      },
    ],
    [
      "the chunk write",
      {
        chunks: {
          replace: async () => {
            throw Object.assign(new Error("fk"), {
              code: "23503",
              constraint: DOCUMENT_FKEY_CONSTRAINTS[0],
            });
          },
          count: async () => 0,
          read: async () => [],
        },
      },
    ],
    [
      "the parsed drop",
      {
        parsed: parsedPort(
          async () => parsed,
          async () => {
            throw new DocumentGoneError();
          },
        ),
      },
    ],
    [
      "the chunk count",
      {
        parsed: parsedPort(async () => undefined),
        chunks: {
          replace: async () => 0,
          count: async () => {
            throw new DocumentGoneError();
          },
          read: async () => [],
        },
      },
    ],
  ])("stops as document_gone when the document vanishes at %s", async (_n, over) => {
    expect(await run(deps(over).d)).toEqual({ outcome: "document_gone" });
  });

  it("runs the guard first: a gone document touches no store", async () => {
    const { d, calls } = deps({
      guard: {
        begin: async () => {
          throw new DocumentGoneError();
        },
      },
    });
    expect(await run(d)).toEqual({ outcome: "document_gone" });
    expect(calls).toEqual([]);
  });

  it("retries a transient store failure, then succeeds", async () => {
    let n = 0;
    const { d } = deps();
    d.chunks.replace = async (_r, c) => {
      if (++n === 1) throw new Error("connection reset");
      return c.length;
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(d)).toEqual({ outcome: "done", count: 1 });
  });

  it("a step that never settles fails with the fixed message and is not retried over its zombie", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { d } = deps({
      parsed: parsedPort(() => new Promise(() => {})),
      stepTimeoutMs: 1,
      attemptSettleMs: 1,
    });
    await expect(run(d)).rejects.toThrow(/^ingest step failed: chunk$/);
  });

  it("a shutdown during the step leaves it un-completed instead of failing it", async () => {
    const shutdown = new AbortController();
    const settled = vi.fn();
    const { d } = deps({
      shutdown: shutdown.signal,
      parsed: parsedPort(async () => {
        shutdown.abort();
        throw new Error("interrupted");
      }),
    });
    void run(d).then(settled, settled);
    await new Promise((r) => setImmediate(r));
    expect(settled).not.toHaveBeenCalled();
  });
});
