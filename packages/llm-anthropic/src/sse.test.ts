import { describe, expect, it, vi } from "vitest";
import { bodyOf } from "./__helpers__/bodyOf";
import { LlmAbortedError, LlmRequestError, LlmStreamError, LlmUnavailableError } from "./errors";
import { readSse } from "./sse";

const CAPS = { maxEventBytes: 1_000, maxTotalBytes: 10_000 };
const enc = new TextEncoder();
const pieces = (s: string, n: number): Uint8Array[] => {
  const b = enc.encode(s);
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += n) out.push(b.slice(i, i + n));
  return out;
};
async function all(it: AsyncIterable<{ event: string; data: string }>) {
  const out: { event: string; data: string }[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const WIRE =
  ": a comment\n\n" +
  "event: a\ndata: 1\n\n" +
  "data: x\r\ndata: y\r\n\r\n" +
  "event: nodata\n\n" +
  "event: z\ndata:\n\n" +
  "data\n\n" +
  "event: u\ndata: café \u{1F600}\n\n" +
  "data: cr\r\r";

const EXPECTED = [
  { event: "a", data: "1" },
  { event: "message", data: "x\ny" },
  { event: "z", data: "" },
  { event: "message", data: "" },
  { event: "u", data: "café \u{1F600}" },
  { event: "message", data: "cr" },
];

describe("readSse", () => {
  it("parses events, comments, CR/LF/CRLF, multi-line data and defaults, however the bytes are split", async () => {
    for (const n of [1, 2, 3, 7, 1_000]) {
      const { body, state } = bodyOf(pieces(WIRE, n));
      expect(await all(readSse(body, CAPS))).toEqual(EXPECTED);
      expect(state.released).toBe(true);
    }
  });

  it("drops an event that is not terminated by a blank line", async () => {
    const { body } = bodyOf(["data: done\n\ndata: cut off\n"]);
    expect(await all(readSse(body, CAPS))).toEqual([{ event: "message", data: "done" }]);
  });

  it("refuses an event over maxEventBytes, as many lines or one long line, and releases the body", async () => {
    const lines = bodyOf(
      Array.from({ length: 200 }, () => "data: xxxxxxxxxx\n"),
      "stall",
    );
    await expect(all(readSse(lines.body, CAPS))).rejects.toBeInstanceOf(LlmRequestError);
    expect(lines.state.released).toBe(true);
    const long = bodyOf([`data: ${"x".repeat(5_000)}`], "stall");
    await expect(all(readSse(long.body, CAPS))).rejects.toBeInstanceOf(LlmRequestError);
    expect(long.state.released).toBe(true);
  });

  it("refuses a body over maxTotalBytes even when every event is small, and releases the body", async () => {
    const { body, state } = bodyOf(
      Array.from({ length: 10 }, () => `data: ${"x".repeat(20)}\n\n`),
      "stall",
    );
    await expect(
      all(readSse(body, { maxEventBytes: 1_000, maxTotalBytes: 100 })),
    ).rejects.toBeInstanceOf(LlmRequestError);
    expect(state.released).toBe(true);
  });

  it("turns a read failure into LlmStreamError (retryable), after yielding what arrived", async () => {
    const { body, state } = bodyOf(["data: 1\n\n"], "error");
    const seen: string[] = [];
    const run = async () => {
      for await (const e of readSse(body, CAPS)) seen.push(e.data);
    };
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmStreamError);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as Error).message).toBe("the language model is unavailable");
    expect(seen).toEqual(["1"]);
    expect(state.released).toBe(true);
  });

  it("throws LlmAbortedError when the signal fires mid-stream, yields nothing more, and cancels the body", async () => {
    const ac = new AbortController();
    const { body, state } = bodyOf(["data: 1\n\ndata: 2\n\n"], "stall");
    const seen: string[] = [];
    const run = async () => {
      for await (const e of readSse(body, CAPS, ac.signal)) {
        seen.push(e.data);
        ac.abort();
      }
    };
    await expect(run()).rejects.toBeInstanceOf(LlmAbortedError);
    expect(seen).toEqual(["1"]);
    expect(state.released).toBe(true);
  });

  it("throws LlmAbortedError when the signal fires during a pending read, and cancels the body", async () => {
    const ac = new AbortController();
    const { body, state } = bodyOf([], "stall");
    const running = all(readSse(body, CAPS, ac.signal));
    await Promise.resolve();
    expect(state.released).toBe(false);
    ac.abort();
    await expect(running).rejects.toBeInstanceOf(LlmAbortedError);
    expect(state.released).toBe(true);
  });

  it("cancels the reader when a read fails", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const body = {
      getReader: () => ({ read: () => Promise.reject(new Error("reset")), cancel }),
    } as unknown as ReadableStream<Uint8Array>;
    await expect(all(readSse(body, CAPS))).rejects.toBeInstanceOf(LlmStreamError);
    expect(cancel).toHaveBeenCalled();
  });

  it("throws LlmAbortedError for a signal that was already aborted, and releases the body", async () => {
    const { body, state } = bodyOf(["data: 1\n\n"], "stall");
    await expect(all(readSse(body, CAPS, AbortSignal.abort()))).rejects.toBeInstanceOf(
      LlmAbortedError,
    );
    expect(state.released).toBe(true);
  });

  it("cancels the body when the consumer stops early", async () => {
    const { body, state } = bodyOf(["data: 1\n\ndata: 2\n\n"], "stall");
    for await (const e of readSse(body, CAPS)) {
      expect(e.data).toBe("1");
      break;
    }
    expect(state.released).toBe(true);
  });

  it("cancels the body when the consumer returns before the first next()", async () => {
    const { body, state } = bodyOf(["data: 1\n\n"], "stall");
    const it = readSse(body, CAPS)[Symbol.asyncIterator]();
    expect(body.locked).toBe(true);
    await it.return?.();
    expect(state.released).toBe(true);
  });

  it("counts a CRLF terminator as two bytes", async () => {
    const wire = "data: x\r\ndata: y\r\n\r\n"; // 9 + 9 + 2 = 20 bytes
    const ok = bodyOf([wire]);
    expect(await all(readSse(ok.body, { maxEventBytes: 20, maxTotalBytes: 1_000 }))).toEqual([
      { event: "message", data: "x\ny" },
    ]);
    const over = bodyOf([wire], "stall");
    await expect(
      all(readSse(over.body, { maxEventBytes: 19, maxTotalBytes: 1_000 })),
    ).rejects.toBeInstanceOf(LlmRequestError);
    expect(over.state.released).toBe(true);
  });

  it("counts bytes, not characters, against the event cap, and allows exactly the cap", async () => {
    const caps = { maxEventBytes: 21, maxTotalBytes: 1_000 };
    const atCap = bodyOf([`data: ${"x".repeat(13)}\n\n`]); // 21 bytes
    expect(await all(readSse(atCap.body, caps))).toHaveLength(1);
    const oneOver = bodyOf([`data: ${"x".repeat(14)}\n\n`], "stall");
    await expect(all(readSse(oneOver.body, caps))).rejects.toBeInstanceOf(LlmRequestError);
    // 13 characters (21 or fewer) but 2 bytes each: 6 + 26 + 2 = 34 bytes
    const wide = bodyOf([`data: ${"é".repeat(13)}\n\n`], "stall");
    await expect(all(readSse(wide.body, caps))).rejects.toBeInstanceOf(LlmRequestError);
    expect(wide.state.released).toBe(true);
  });

  it("counts bytes, not characters, against the total cap, and allows exactly the cap", async () => {
    const wire = `data: ${"é".repeat(5)}\n\n`; // 6 + 10 + 2 = 18 bytes, 13 characters
    const caps = (maxTotalBytes: number) => ({ maxEventBytes: 1_000, maxTotalBytes });
    expect(await all(readSse(bodyOf([wire]).body, caps(18)))).toHaveLength(1);
    const { body, state } = bodyOf([wire], "stall");
    await expect(all(readSse(body, caps(17)))).rejects.toBeInstanceOf(LlmRequestError);
    expect(state.released).toBe(true);
  });

  it("reads a long line dripped in tiny chunks (the scan is incremental)", async () => {
    const payload = "x".repeat(512 * 1024);
    const { body } = bodyOf(pieces(`data: ${payload}\r\n\r\n`, 16));
    const out = await all(readSse(body, { maxEventBytes: 1_048_576, maxTotalBytes: 2_097_152 }));
    expect(out).toEqual([{ event: "message", data: payload }]);
  });
});
