import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import { sendError } from "./respond";

const MAX_BODY_BYTES = 16 * 1024;

/** The body as text, or null when it is larger than the limit (reading stops there). */
function readBody(req: IncomingMessage): Promise<string | null> {
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
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
    sendError(res, 415, "unsupported_media_type", "send application/json");
    return undefined;
  }
  const text = await readBody(req);
  if (text === null) {
    res.setHeader("connection", "close");
    sendError(res, 413, "payload_too_large", "request body is too large");
    res.once("finish", () => req.destroy());
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    sendError(res, 400, "invalid_request", "body is not valid JSON");
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    sendError(res, 400, "invalid_request", problems.join("; "));
    return undefined;
  }
  return parsed.data;
}
