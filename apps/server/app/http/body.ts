import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import { sendError } from "./respond";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_ISSUES = 10;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The raw body bytes, or null when they exceed the limit (reading stops there). */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        resolve(null);
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

/** 413 without reading further; the socket is dropped once the answer is flushed. */
function tooLarge(req: IncomingMessage, res: ServerResponse): undefined {
  res.setHeader("connection", "close");
  sendError(res, 413, "payload_too_large", "request body is too large");
  res.once("finish", () => req.destroy());
  return undefined;
}

/**
 * Reads and validates a JSON request body. On any problem it has already answered (415, 413 or
 * 400) and returns undefined, so a route does `if (!body) return;`. Requiring application/json
 * also keeps a cross-site HTML form from posting to the API: a form cannot send that type.
 */
export async function readJson<S extends z.ZodTypeAny>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: S,
): Promise<z.infer<S> | undefined> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    res.setHeader("connection", "close");
    sendError(res, 415, "unsupported_media_type", "send application/json");
    return undefined;
  }
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) return tooLarge(req, res);
  const bytes = await readBody(req);
  if (bytes === null) return tooLarge(req, res);
  let raw: unknown;
  try {
    raw = JSON.parse(utf8.decode(bytes));
  } catch {
    sendError(res, 400, "invalid_request", "body is not valid JSON");
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Only the path and the zod issue code: zod's message can echo the submitted value.
    const problems = parsed.error.issues
      .slice(0, MAX_ISSUES)
      .map((i) => `${i.path.join(".") || "body"}: ${i.code}`);
    sendError(res, 400, "invalid_request", problems.join("; "));
    return undefined;
  }
  return parsed.data;
}
