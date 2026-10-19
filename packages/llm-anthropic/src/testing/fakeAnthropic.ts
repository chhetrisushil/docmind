/**
 * FakeAnthropic: a 127.0.0.1 HTTP server that speaks enough of POST /v1/messages for tests.
 *
 * The default reply is the text "ok" with `stop_reason: "end_turn"`. Usage is deterministic:
 * `input_tokens` is the character count of all user text parts plus 1, and `output_tokens` is 1,
 * so a request of "hi" reports 3 / 1. `close()` destroys every open socket, so a request parked
 * by `hang` never outlives the server.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AnthropicBody } from "../request";

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
}

export interface FakeAnthropic {
  url: string;
  requests: FakeRequest[];
  reply(fn: (body: AnthropicBody) => FakeReply): void;
  failNext(status: number, times?: number): void;
  close(): Promise<void>;
}

const MAX_BODY = 8 * 1024 * 1024;

const userChars = (body: AnthropicBody): number =>
  body.messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content)
    .reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0);

export async function startFakeAnthropic(
  options: { reply?: (body: AnthropicBody) => FakeReply } = {},
): Promise<FakeAnthropic> {
  let replyFn: (body: AnthropicBody) => FakeReply = options.reply ?? (() => ({}));
  const requests: FakeRequest[] = [];
  const failures: number[] = [];
  const sockets = new Set<import("node:net").Socket>();
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
    req.on("end", () => {
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
      const r = replyFn(body);
      if (r.hang) return;
      if (r.rawBody !== undefined || r.status !== undefined) {
        res.writeHead(r.status ?? 200, { "content-type": "application/json" });
        res.end(r.rawBody ?? "");
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      }),
  };
}
