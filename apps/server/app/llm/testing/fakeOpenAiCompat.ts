import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseBody } from "./parseBody";

export type CompatReply =
  | {
      kind: "text";
      text: string;
      reasoning?: string;
      usage?: { prompt: number; completion: number };
      finish?: "stop" | "length";
    }
  | {
      kind: "tools";
      calls: { name: string; input: unknown }[];
      reasoning?: string;
    }
  | { kind: "error"; status: number }
  /** A stream that sends `text` (and `reasoning`) and then drops the connection, never finishing. */
  | { kind: "cutoff"; text?: string; reasoning?: string };

export interface FakeOpenAiCompat {
  url: string;
  requests: {
    path: string;
    authorization?: string;
    body: Record<string, unknown>;
  }[];
  reply(f: (n: number, body: Record<string, unknown>) => CompatReply): void;
  close(): Promise<void>;
}

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/**
 * An OpenAI-compatible chat-completions server in Ollama's wire shape (reasoning in `reasoning`).
 * 127.0.0.1, port 0. With `forward`, every path outside /v1/ is proxied to that URL (Ollama serves
 * embeddings and chat on one URL, so the embedding fake sits behind this one).
 */
export async function startFakeOpenAiCompat(
  o: { forward?: string } = {},
): Promise<FakeOpenAiCompat> {
  let script: (n: number, body: Record<string, unknown>) => CompatReply = () => ({
    kind: "text",
    text: "ok",
  });
  const requests: FakeOpenAiCompat["requests"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (o.forward !== undefined && !req.url?.startsWith("/v1/")) {
        fetch(`${o.forward}${req.url ?? ""}`, {
          method: req.method ?? "POST",
          headers: { "content-type": "application/json" },
          ...(req.method !== "GET" && req.method !== "HEAD" && { body: Buffer.concat(chunks) }),
        })
          .then(async (r) => {
            res.writeHead(r.status, { "content-type": "application/json" });
            res.end(Buffer.from(await r.arrayBuffer()));
          })
          .catch(() => {
            res.writeHead(502);
            res.end();
          });
        return;
      }
      const body = parseBody(Buffer.concat(chunks).toString("utf8"));
      const n = requests.length;
      requests.push({
        path: req.url ?? "",
        ...(req.headers.authorization !== undefined && {
          authorization: req.headers.authorization,
        }),
        body,
      });
      let r: CompatReply;
      try {
        r = script(n, body);
      } catch {
        res.writeHead(500, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const model = typeof body.model === "string" ? body.model : "fake";
      const created = 1_700_000_000;
      const head = { id: `chatcmpl-${n}`, created, model };
      if (r.kind === "error") {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "sentinel-provider-message",
              type: "server_error",
            },
          }),
        );
        return;
      }
      if (r.kind === "cutoff") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const deltas: object[] = [{ role: "assistant" }];
        if (r.reasoning) deltas.push({ reasoning: r.reasoning });
        if (r.text) deltas.push({ content: r.text });
        deltas.forEach((delta, i) => {
          const data = sse({
            ...head,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta }],
          });
          // Drop the connection once the last chunk is flushed (no timer).
          if (i === deltas.length - 1) res.write(data, () => res.destroy());
          else res.write(data);
        });
        return;
      }
      const calls =
        r.kind === "tools"
          ? r.calls.map((c, i) => ({
              id: `call_${n}_${i}`,
              index: i,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.input) },
            }))
          : [];
      const text = r.kind === "text" ? r.text : "";
      const finish = r.kind === "tools" ? "tool_calls" : (r.finish ?? "stop");
      const usage =
        r.kind === "text" && r.usage
          ? {
              prompt_tokens: r.usage.prompt,
              completion_tokens: r.usage.completion,
              total_tokens: r.usage.prompt + r.usage.completion,
            }
          : { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...head,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: text,
                  ...(r.reasoning !== undefined && { reasoning: r.reasoning }),
                  ...(calls.length > 0 && { tool_calls: calls }),
                },
                finish_reason: finish,
              },
            ],
            usage,
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (choices: unknown[], extra: object = {}) =>
        res.write(sse({ ...head, object: "chat.completion.chunk", choices, ...extra }));
      chunk([{ index: 0, delta: { role: "assistant" } }]);
      if (r.reasoning) chunk([{ index: 0, delta: { reasoning: r.reasoning } }]);
      if (text) chunk([{ index: 0, delta: { content: text } }]);
      if (calls.length > 0) chunk([{ index: 0, delta: { tool_calls: calls } }]);
      chunk([{ index: 0, delta: {}, finish_reason: finish }]);
      const opts = body.stream_options as { include_usage?: boolean } | undefined;
      if (opts?.include_usage) chunk([], { usage });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply: (f) => {
      script = f;
    },
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}
