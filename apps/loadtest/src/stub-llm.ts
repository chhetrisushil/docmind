import { createServer } from "node:http";
import { parseArgs } from "node:util";

/**
 * A stand-in for Ollama with knobs, so a load test measures DocMind and not a model provider.
 * It serves what DocMind calls: `POST /v1/chat/completions` (streamed or not; chat, title and summary
 * all use it) and `POST /api/embed`. Embeddings are deterministic for a given text.
 */
const { values } = parseArgs({
  options: {
    port: { type: "string" },
    "first-token-ms": { type: "string" },
    tokens: { type: "string" },
    "token-delay-ms": { type: "string" },
    "embed-ms": { type: "string" },
    dimensions: { type: "string" },
    "tool-call": { type: "boolean" },
  },
});
const num = (flag: string | undefined, env: string, fallback: number): number =>
  Number(flag ?? process.env[env] ?? fallback);

const port = num(values.port, "STUB_PORT", 11500);
const firstTokenMs = num(values["first-token-ms"], "STUB_FIRST_TOKEN_MS", 300);
const tokens = num(values.tokens, "STUB_TOKENS", 120);
const tokenDelayMs = num(values["token-delay-ms"], "STUB_TOKEN_DELAY_MS", 15);
const embedMs = num(values["embed-ms"], "STUB_EMBED_MS", 20);
const dimensions = num(values.dimensions, "STUB_DIMENSIONS", 768);
/** The chat's first model call asks for `search_docs`, so a turn also runs retrieval (embed + pgvector). */
const toolCall = values["tool-call"] ?? process.env.STUB_TOOL_CALL === "1";

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/** FNV-1a seeds a small PRNG; the vector is unit length, so cosine distance is well defined. */
function embedding(text: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  const v = Array.from({ length: dimensions }, () => {
    h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9) | 0;
    return (h >>> 0) / 2 ** 31 - 1;
  });
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const counts = { chat: 0, embed: 0 };
let inFlight = 0;
let peak = 0;

function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        ok({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  inFlight++;
  peak = Math.max(peak, inFlight);
  try {
    if (req.method === "POST" && req.url === "/api/embed") {
      counts.embed++;
      await sleep(embedMs);
      const input = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input)];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: body.model, embeddings: input.map(embedding) }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
      counts.chat++;
      await sleep(firstTokenMs);
      if (closed) return;
      const messages = Array.isArray(body.messages) ? (body.messages as { role?: string }[]) : [];
      const searched = messages.some((m) => m.role === "tool");
      const wantsSearch =
        toolCall && !searched && JSON.stringify(body.tools ?? "").includes('"search_docs"');
      const head = { id: "chatcmpl-stub", created: 1_700_000_000, model: body.model ?? "stub" };
      const usage = { prompt_tokens: 200, completion_tokens: tokens, total_tokens: 200 + tokens };
      if (body.stream !== true) {
        // Not streamed: a chat title, or the summarize step, which wants JSON (map, then reduce).
        const asked = JSON.stringify(body.messages);
        const content = asked.includes('Reply as {\\"tldr\\"')
          ? JSON.stringify({
              tldr: "A stub summary.",
              keyPoints: ["point"],
              entities: ["Acme"],
              topics: ["topic"],
              suggestedQuestions: ["What is this about?"],
            })
          : asked.includes('Reply as {\\"summary\\"')
            ? JSON.stringify({
                summary: "A stub part summary.",
                entities: [{ name: "Acme", kind: "other" }],
              })
            : "Stub title";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...head,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content },
                finish_reason: "stop",
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
      if (wantsSearch) {
        const call = {
          id: "call_stub",
          index: 0,
          type: "function",
          function: { name: "search_docs", arguments: JSON.stringify({ query: "summary" }) },
        };
        chunk([{ index: 0, delta: { tool_calls: [call] } }]);
        chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
      } else {
        for (let i = 0; i < tokens && !closed; i++) {
          chunk([{ index: 0, delta: { content: i === 0 ? "word" : " word" } }]);
          if (tokenDelayMs > 0) await sleep(tokenDelayMs);
        }
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
      }
      const opts = body.stream_options as { include_usage?: boolean } | undefined;
      if (opts?.include_usage) chunk([], { usage });
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404).end();
  } finally {
    inFlight--;
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `stub llm on http://127.0.0.1:${port} first-token=${firstTokenMs}ms tokens=${tokens} delay=${tokenDelayMs}ms embed=${embedMs}ms dims=${dimensions} tool-call=${toolCall}`,
  );
});
const stop = () => {
  console.log(
    `stub llm: ${counts.chat} chat calls, ${counts.embed} embed calls, peak ${peak} in flight`,
  );
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
