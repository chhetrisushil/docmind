/**
 * FakeAnthropic: a 127.0.0.1 HTTP server that speaks enough of POST /v1/messages for tests.
 *
 * The default reply is the text "ok" with `stop_reason: "end_turn"`. Usage is deterministic:
 * `input_tokens` is the character count of all user text parts plus 1, and `output_tokens` is 1,
 * so a request of "hi" reports 3 / 1. A reply with a `stream` script (or any streaming request) is served as server-sent events; see streamScript.ts. `close()` destroys every open socket, so a request parked
 * by `hang` never outlives the server.
 */
import { type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AnthropicBody } from "../request";
import { type StreamScript, normalize, renderEvents, renderJson } from "./streamScript";

export type { StreamScript, StreamStep } from "./streamScript";

export interface FakeRequest {
  headers: Record<string, string | string[] | undefined>;
  body: AnthropicBody;
}

export interface FakeReply {
  text?: string;
  stopReason?: string;
  status?: number;
  rawBody?: string;
  /** Accept the request and never answer. */
  hang?: true;
  /** Send 200 headers and part of a body, then stall (the socket stays open until close()). */
  stallAfterHeaders?: true;
  /** Extra response headers (for example `location` on a 302). */
  headers?: Record<string, string>;
  /** Steps rendered as SSE for a streaming request and as a JSON message otherwise. */
  stream?: StreamScript;
}

export interface FakeAnthropic {
  url: string;
  requests: FakeRequest[];
  reply(fn: (body: AnthropicBody) => FakeReply): void;
  failNext(status: number, times?: number): void;
  /** The next request parks before it is answered: `reached` resolves once it has arrived, `release()` lets it answer. */
  holdNext(): { reached: Promise<void>; release(): void };
  /** Resolves when a streaming response reaches a `{hold: true}` step; `release()` lets it go on. Rejects if close() runs first. */
  streamHold(): Promise<{ release(): void }>;
  close(): Promise<void>;
}

const MAX_BODY = 8 * 1024 * 1024;

const userChars = (body: AnthropicBody): number =>
  body.messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content)
    .reduce((n, b) => n + (b.type === "text" && typeof b.text === "string" ? b.text.length : 0), 0);

const stopOf = (s: string | undefined): "end_turn" | "tool_use" | "max_tokens" | "refusal" =>
  s === "tool_use" || s === "max_tokens" || s === "refusal" ? s : "end_turn";

export async function startFakeAnthropic(
  options: { reply?: (body: AnthropicBody) => FakeReply } = {},
): Promise<FakeAnthropic> {
  let replyFn: (body: AnthropicBody) => FakeReply = options.reply ?? (() => ({}));
  const requests: FakeRequest[] = [];
  const failures: number[] = [];
  const holds: { arrive(): void; released: Promise<void>; release(): void }[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const reachedHolds: { release(): void }[] = [];
  const holdWaiters: {
    resolve: (gate: { release(): void }) => void;
    reject: (e: Error) => void;
  }[] = [];
  const openHolds = new Set<{ release(): void }>();
  /** Parks a streaming response until the gate is released, the client leaves or the server closes. */
  const hold = (res: ServerResponse): Promise<void> => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = {
      release: () => {
        const at = reachedHolds.indexOf(gate);
        if (at >= 0) reachedHolds.splice(at, 1); // a dead gate must not satisfy a later streamHold()
        release();
      },
    };
    openHolds.add(gate);
    res.once("close", gate.release);
    const waiter = holdWaiters.shift();
    if (waiter) waiter.resolve(gate);
    else reachedHolds.push(gate);
    return released.then(() => {
      openHolds.delete(gate);
    });
  };
  const respondScript = async (res: ServerResponse, body: AnthropicBody, r: FakeReply) => {
    let norm: ReturnType<typeof normalize>;
    try {
      norm = normalize(
        r.stream ?? { steps: [{ text: r.text ?? "ok" }, { stop: stopOf(r.stopReason) }] },
        userChars(body) + 1,
      );
    } catch {
      res.writeHead(500).end(); // a malformed script is the test's bug
      return;
    }
    if (body.stream !== true) {
      if (norm.failure) {
        res.writeHead(norm.failure === "overloaded_error" ? 529 : 500).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(renderJson(norm, body.model)));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const item of renderEvents(norm, body.model)) {
      if (res.destroyed) return;
      if ("hold" in item) {
        await hold(res);
        continue;
      }
      const frame = `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`;
      await new Promise<void>((done) => res.write(frame, () => done()));
    }
    res.end();
  };
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/messages") {
      req.resume();
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", async () => {
      let body: AnthropicBody;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicBody;
      } catch {
        res.writeHead(400).end();
        return;
      }
      requests.push({ headers: req.headers, body });
      const failure = failures.shift();
      if (failure) {
        res.writeHead(failure).end();
        return;
      }
      const hold = holds.shift();
      if (hold) {
        hold.arrive();
        await hold.released;
      }
      const r = replyFn(body);
      if (r.hang) return;
      if (r.stallAfterHeaders) {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"content":[');
        return;
      }
      if (r.rawBody !== undefined || r.status !== undefined) {
        res.writeHead(r.status ?? 200, { "content-type": "application/json", ...r.headers });
        res.end(r.rawBody ?? "");
        return;
      }
      if (r.stream !== undefined || body.stream === true) {
        await respondScript(res, body, r);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: r.text ?? "ok" }],
          stop_reason: r.stopReason ?? "end_turn",
          usage: { input_tokens: userChars(body) + 1, output_tokens: 1 },
        }),
      );
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    reply: (fn) => {
      replyFn = fn;
    },
    failNext: (status, times = 1) => {
      for (let i = 0; i < times; i++) failures.push(status);
    },
    holdNext: () => {
      let arrive: () => void = () => {};
      let release: () => void = () => {};
      const reached = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.push({ arrive, released, release });
      return { reached, release };
    },
    streamHold: () => {
      const gate = reachedHolds.shift();
      return gate
        ? Promise.resolve(gate)
        : new Promise<{ release(): void }>((resolve, reject) =>
            holdWaiters.push({ resolve, reject }),
          );
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const h of holds) h.release();
        for (const g of [...openHolds]) g.release();
        // A pending streamHold() rejects once the server is closed, so a test never hangs on it.
        for (const w of holdWaiters.splice(0)) w.reject(new Error("FakeAnthropic closed"));
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      }),
  };
}
