import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseBody } from "./parseBody";

export type GeminiReply = { text: string } | { status: number; apiKeyInvalid?: true };

export interface FakeGemini {
  url: string;
  requests: { path: string; keyHeader?: string; body: Record<string, unknown> }[];
  reply(f: (n: number, body: Record<string, unknown>) => GeminiReply): void;
  close(): Promise<void>;
}

/** A Gemini generateContent server (non-streaming). 127.0.0.1, port 0. */
export async function startFakeGemini(): Promise<FakeGemini> {
  let script: (n: number, body: Record<string, unknown>) => GeminiReply = () => ({ text: "ok" });
  const requests: FakeGemini["requests"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = parseBody(Buffer.concat(chunks).toString("utf8"));
      const n = requests.length;
      const key = req.headers["x-goog-api-key"];
      requests.push({
        path: req.url ?? "",
        ...(typeof key === "string" && { keyHeader: key }),
        body,
      });
      let r: GeminiReply;
      try {
        r = script(n, body);
      } catch {
        res.writeHead(500, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if ("status" in r) {
        res.writeHead(r.status, { "content-type": "application/json" });
        // Google answers a bad key with a 400 whose ErrorInfo names the reason (API_KEY_INVALID).
        res.end(
          JSON.stringify({
            error: {
              code: r.status,
              message: "sentinel-provider-message",
              ...(r.apiKeyInvalid && {
                status: "INVALID_ARGUMENT",
                details: [
                  {
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    reason: "API_KEY_INVALID",
                    domain: "googleapis.com",
                  },
                ],
              }),
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: r.text }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      );
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
