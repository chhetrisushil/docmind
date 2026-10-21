import { describe, expect, it, vi } from "vitest";
import { type SseCloseReason, type SseFrame, SseOverflowError, SseParser, openSse } from "./sse";

describe("SseParser", () => {
  it("parses events across chunk boundaries, CRLF, comments, multi-line data and the id", () => {
    const p = new SseParser();
    expect(p.push("retry: 3000\n\n: heartbeat\n\nid: 1.4\nevent: me")).toEqual([]);
    expect(p.retryMs).toBe(3000);
    const frames = p.push('ssage\r\ndata: {"a":1}\r\ndata: more\r\n\r\ndata: bare\n\n');
    expect(frames).toEqual([
      { event: "message", data: '{"a":1}\nmore', id: "1.4" },
      { event: "message", data: "bare", id: "1.4" }, // the id stays until another arrives
    ]);
    expect(p.lastEventId).toBe("1.4");
  });
  it("does not end an event early when a CRLF is split between two chunks", () => {
    const p = new SseParser();
    expect(p.push("data: x\r")).toEqual([]);
    expect(p.push("\ndata: y\r\n\r\n")).toEqual([
      { event: "message", data: "x\ny", id: undefined },
    ]);
  });
  it("ignores an event with no data, an unknown field and an id containing NUL", () => {
    const p = new SseParser();
    expect(p.push("event: x\n\nfoo: bar\nid: a\u0000b\ndata: y\n\n")).toEqual([
      { event: "message", data: "y", id: undefined },
    ]);
  });
});

describe("SseParser bounds", () => {
  it("throws on a line that never ends, and on an event whose data grows past the bound", () => {
    expect(() => new SseParser(100).push(`data: ${"x".repeat(200)}`)).toThrow(SseOverflowError);
    const p = new SseParser(100);
    expect(p.push(`data: ${"y".repeat(60)}\n`)).toEqual([]);
    expect(() => p.push(`data: ${"y".repeat(60)}\n`)).toThrow(SseOverflowError);
    // after the reset it parses again
    expect(p.push("data: ok\n\n")).toEqual([{ event: "message", data: "ok", id: undefined }]);
  });
  it("does not grow on endless comments", () => {
    const p = new SseParser(100);
    for (let i = 0; i < 1000; i++) expect(p.push(": hb\n")).toEqual([]);
  });
});

/** A fetch whose body yields the given chunks and then ends (or stays open when `hang` is set). */
function body(chunks: string[], opts: { hang?: boolean } = {}): Response {
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (i < chunks.length) ctl.enqueue(enc.encode(chunks[i++] as string));
      else if (!opts.hang) ctl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const status = (code: number) => new Response(null, { status: code });

function harness(
  responses: (Response | Error)[],
  extra: Partial<Parameters<typeof openSse>[0]> = {},
) {
  const frames: SseFrame[] = [];
  const closes: SseCloseReason[] = [];
  const sleeps: number[] = [];
  const seen: { url: string; lastEventId: string | null }[] = [];
  let opens = 0;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({
      url,
      lastEventId: (init.headers as Record<string, string>)["last-event-id"] ?? null,
    });
    const next = responses.shift();
    if (!next) return body([], { hang: true });
    if (next instanceof Error) throw next;
    return next;
  });
  const done = new Promise<void>((resolve) => {
    harnessResolve = resolve;
  });
  const handle = openSse({
    url: "/api/x",
    fetch: fetch as never,
    random: () => 1,
    ...extra,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onOpen: () => {
      opens++;
    },
    onFrame: (f) => {
      frames.push(f);
    },
    onClose: (r) => {
      closes.push(r);
      harnessResolve();
    },
  });
  return { handle, frames, closes, sleeps, seen, done, opens: () => opens };
}
let harnessResolve: () => void = () => {};

describe("openSse", () => {
  it("delivers frames, remembers the last id, and reconnects with it after the server ends the stream", async () => {
    const h = harness([
      body(["retry: 250\nid: 1.1\ndata: a\n\n"]),
      body(["id: 1.2\ndata: b\n\n"], { hang: true }),
    ]);
    await vi.waitFor(() => expect(h.frames.map((f) => f.data)).toEqual(["a", "b"]));
    expect(h.seen.map((s) => s.lastEventId)).toEqual([null, "1.1"]);
    expect(h.sleeps).toEqual([250]); // the server's retry: wins over the base delay
    expect(h.opens()).toBe(2);
    h.handle.close();
  });

  it("backs off 1s, 2s, 4s on failures and resets after a successful open", async () => {
    const h = harness([
      status(503),
      new TypeError("x"),
      status(429),
      body(["data: ok\n\n"]),
      status(500),
      body([], { hang: true }),
    ]);
    await vi.waitFor(() => expect(h.seen.length).toBe(6));
    expect(h.sleeps).toEqual([1000, 2000, 4000, 1000, 1000]); // after the good open the counter restarts, and an ended stream waits the base delay
    h.handle.close();
  });

  it.each([
    [401, "unauthorized"],
    [404, "not_found"],
    [400, "rejected"],
    [403, "rejected"],
  ] as const)("a %i stops for good and says %s", async (code, reason) => {
    const h = harness([status(code)]);
    await h.done;
    expect(h.closes).toEqual([reason]);
    expect(h.seen.length).toBe(1);
  });

  it("a throwing frame handler is reported by class and does not end the stream", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    const handle = openSse({
      url: "/api/x",
      fetch: (async () => body(["data: one\n\ndata: two\n\n"], { hang: true })) as never,
      sleep: async () => {},
      onFrame: (f) => {
        seen.push(f.data);
        if (f.data === "one") throw new RangeError("sentinel-answer-0123456789");
      },
    });
    await vi.waitFor(() => expect(seen).toEqual(["one", "two"]));
    expect(error.mock.calls).toEqual([["sse-frame RangeError"]]);
    handle.close();
  });

  it("close() aborts the request, releases the body and calls onClose('closed') once", async () => {
    const aborted: boolean[] = [];
    const frames: string[] = [];
    const closes: SseCloseReason[] = [];
    let cancelled = false;
    const enc = new TextEncoder();
    let sent = false;
    const handle = openSse({
      url: "/api/x",
      fetch: (async (_u: string, init: RequestInit) => {
        init.signal?.addEventListener("abort", () => aborted.push(true));
        const stream = new ReadableStream<Uint8Array>({
          pull(ctl) {
            if (!sent) {
              sent = true;
              ctl.enqueue(enc.encode("data: a\n\n"));
            }
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as never,
      sleep: async () => {},
      onFrame: (f) => {
        frames.push(f.data);
      },
      onClose: (r) => {
        closes.push(r);
      },
    });
    await vi.waitFor(() => expect(frames).toEqual(["a"]));
    handle.close();
    handle.close(); // idempotent
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(aborted).toEqual([true]);
    expect(closes).toEqual(["closed"]);
  });

  it("an oversized frame drops the connection and reconnects from the last id, without logging the data", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness([
      body(["id: 1.1\ndata: a\n\n", `data: ${"z".repeat(1_100_000)}`]),
      body([], { hang: true }),
    ]);
    await vi.waitFor(() => expect(h.seen.length).toBe(2));
    expect(h.seen.map((s) => s.lastEventId)).toEqual([null, "1.1"]);
    expect(h.frames.map((f) => f.data)).toEqual(["a"]);
    expect(error).not.toHaveBeenCalled();
    h.handle.close();
  });

  it("reads the url again on every attempt, so a resume cursor in the query is current", async () => {
    let n = 0;
    const urls: string[] = [];
    const handle = openSse({
      url: () => `/api/x?cursor=${++n}`,
      fetch: (async (u: string) => {
        urls.push(u);
        return urls.length === 1 ? body(["data: a\n\n"]) : body([], { hang: true });
      }) as never,
      sleep: async () => {},
      onFrame: () => {},
    });
    await vi.waitFor(() => expect(urls).toEqual(["/api/x?cursor=1", "/api/x?cursor=2"]));
    handle.close();
  });
});

describe("openSse reconnect policy", () => {
  const sleepsOf = async (responses: (Response | Error)[], n: number, extra = {}) => {
    const h = harness(responses, extra);
    await vi.waitFor(() => expect(h.seen.length).toBe(n));
    h.handle.close();
    return h;
  };

  it("caps every delay at maxDelayMs, the exponential one and the server's retry: alike", async () => {
    const fails = Array.from({ length: 8 }, () => status(503));
    const h = await sleepsOf(fails, 9);
    expect(h.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    const r = await sleepsOf([body(["retry: 999999\ndata: a\n\n"])], 2);
    expect(r.sleeps).toEqual([30000]);
  });

  it("jitters every delay into [50%, 100%] using the injected random", async () => {
    const lo = await sleepsOf([status(503), status(503)], 3, { random: () => 0 });
    expect(lo.sleeps).toEqual([500, 1000]);
    const mid = await sleepsOf([status(503)], 2, { random: () => 0.5 });
    expect(mid.sleeps).toEqual([750]);
  });

  it("clamps a server retry: of 0 to the floor, and keeps the last retry: across later failures", async () => {
    const h = await sleepsOf(
      [body(["retry: 0\ndata: a\n\n"]), body(["retry: 8000\ndata: b\n\n"]), status(503)],
      4,
    );
    expect(h.sleeps).toEqual([250, 8000, 8000]);
  });

  it("honours Retry-After on a refusal, bounded by maxDelayMs", async () => {
    const h = await sleepsOf(
      [
        new Response(null, { status: 429, headers: { "retry-after": "7" } }),
        new Response(null, { status: 503, headers: { "retry-after": "3600" } }),
      ],
      3,
    );
    expect(h.sleeps).toEqual([7000, 30000]);
  });

  it("does not reset the backoff on a bare 200 that dies, and gives up as 'failed' after maxDeadOpens", async () => {
    const h = harness([body([]), body([]), body([]), body([], { hang: true })], {
      maxDeadOpens: 3,
    });
    await h.done;
    expect(h.closes).toEqual(["failed"]);
    expect(h.sleeps).toEqual([1000, 2000]);
    expect(h.seen.length).toBe(3);
  });

  it("gives up as 'failed' when a frame replayed from the last id overflows again and again", async () => {
    const big = () => body(["id: 1.1\ndata: a\n\n", `data: ${"z".repeat(1_100_000)}`]);
    const h = harness([big(), big(), big(), body([], { hang: true })]);
    await h.done;
    expect(h.closes).toEqual(["failed"]);
    expect(h.seen.map((s) => s.lastEventId)).toEqual([null, "1.1", "1.1"]);
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it("delivers the frames completed before an overflow in the same chunk", async () => {
    const h = harness([
      body([`id: 2.1\ndata: ok\n\ndata: ${"z".repeat(1_100_000)}`]),
      body([], { hang: true }),
    ]);
    await vi.waitFor(() => expect(h.seen.length).toBe(2));
    expect(h.frames.map((f) => f.data)).toEqual(["ok"]);
    expect(h.seen[1]?.lastEventId).toBe("2.1");
    h.handle.close();
  });

  it("releases the body of every refusal, and treats a non-event-stream 200 as a failure", async () => {
    let cancelled = 0;
    const res = (code: number, type?: string) =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled++;
          },
        }),
        { status: code, ...(type && { headers: { "content-type": type } }) },
      );
    const h = harness([res(503), res(200, "text/html"), res(200)]);
    await vi.waitFor(() => expect(h.seen.length).toBe(4));
    expect(cancelled).toBe(3);
    expect(h.opens()).toBe(1); // only the hanging fallback after the three bad answers
    h.handle.close();
    for (const code of [401, 404, 403]) {
      const before = cancelled;
      const t = harness([res(code)]);
      await t.done;
      expect(cancelled).toBe(before + 1);
    }
  });

  it("strips a leading BOM, and sends the lastEventId option on the first attempt", async () => {
    const enc = new TextEncoder();
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode("\uFEFFdata: a\n\n"));
        },
      });
    const h = harness(
      [new Response(stream(), { status: 200, headers: { "content-type": "text/event-stream" } })],
      { lastEventId: () => "9.9" },
    );
    await vi.waitFor(() => expect(h.frames.map((f) => f.data)).toEqual(["a"]));
    expect(h.seen[0]?.lastEventId).toBe("9.9");
    h.handle.close();
  });
});

describe("openSse liveness and ids", () => {
  it("a connection that only receives heartbeats then drops is healthy: no dead-open count, no escalation", async () => {
    const beat = () => body([": hb\n\n"]);
    const h = harness([beat(), beat(), beat(), beat(), body([], { hang: true })], {
      maxDeadOpens: 2,
    });
    await vi.waitFor(() => expect(h.seen.length).toBe(5));
    expect(h.closes).toEqual([]);
    expect(h.sleeps).toEqual([1000, 1000, 1000, 1000]);
    h.handle.close();
  });

  it("an id with no data still becomes the resume point", async () => {
    const h = harness([body(["id: 5.5\n\n"]), body([], { hang: true })]);
    await vi.waitFor(() => expect(h.seen.length).toBe(2));
    expect(h.seen.map((s) => s.lastEventId)).toEqual([null, "5.5"]);
    expect(h.frames).toEqual([]);
    h.handle.close();
  });
});
