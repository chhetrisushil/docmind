import type { IncomingMessage } from "node:http";
import busboy from "busboy";

/** The file passed the size limit while it was streaming in. */
export class UploadTooLargeError extends Error {
  constructor() {
    super("upload exceeds the size limit");
    this.name = "UploadTooLargeError";
  }
}

export interface IncomingFile {
  /** What the client called it. Untrusted: sanitize before storing, never build a path from it. */
  filename: string;
  /**
   * The file bytes as they arrive; throws `UploadTooLargeError` past `maxFileBytes`. The cap is
   * enforced as the body is consumed, so callers must read it to the end.
   */
  body: AsyncIterable<Uint8Array>;
}

export type ReceiveResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

// Multipart framing around the file (boundaries, the part's headers).
const ENVELOPE_SLACK = 64 * 1024;

const failure = (status: number, code: string, message: string) =>
  ({ ok: false, status, code, message }) as const;

const malformed = () => failure(400, "invalid_request", "malformed multipart request");

/**
 * Reads a `multipart/form-data` request whose first file part is named `file`. The file is handed
 * to `handle` while it streams in; nothing is buffered here. Parser limits (parts, header pairs,
 * name and field sizes) keep a hostile body from costing memory.
 */
export function receiveFile<T>(
  req: IncomingMessage,
  options: { maxFileBytes: number },
  handle: (file: IncomingFile) => Promise<T>,
): Promise<ReceiveResult<T>> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "multipart/form-data") {
    return Promise.resolve(failure(415, "unsupported_media_type", "send multipart/form-data"));
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > options.maxFileBytes + ENVELOPE_SLACK) {
    return Promise.resolve(failure(413, "payload_too_large", "request body is too large"));
  }

  return new Promise<ReceiveResult<T>>((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        defParamCharset: "utf8",
        preservePath: false, // the directory part of a filename is dropped
        limits: {
          files: 1, // later files are dropped by the parser
          fields: 8,
          fieldSize: 1024,
          fieldNameSize: 64,
          parts: 16,
          fileSize: options.maxFileBytes + 1, // busboy's `limit` fires on reaching this: one byte over
          headerPairs: 16,
        },
      });
    } catch {
      return resolve(malformed());
    }

    let outcome: ReceiveResult<T> | undefined;
    let work: Promise<void> | undefined;
    let sawFile = false;
    const settle = (result: ReceiveResult<T>) => {
      outcome ??= result;
    };

    const broken = () => settle(malformed());

    parser.on("file", (name, stream, info) => {
      if (sawFile) return void stream.resume(); // only the first file part counts
      sawFile = true;
      if (name !== "file") {
        stream.resume();
        return settle(failure(400, "invalid_request", "send the document as a part named file"));
      }
      // Never destroy the part stream: the parser must keep consuming it to reach the end of the body.
      let limited = false;
      stream.on("limit", () => {
        limited = true;
      });
      async function* body(): AsyncGenerator<Uint8Array> {
        // Leaving early must not destroy the stream; it is drained once the handler settles.
        for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
          if (limited) throw new UploadTooLargeError();
          yield chunk as Uint8Array;
        }
        if (limited) throw new UploadTooLargeError();
      }
      work = handle({ filename: info.filename ?? "", body: body() }).then(
        (value) => settle({ ok: true, value }),
        (err: unknown) => {
          if (err instanceof UploadTooLargeError) {
            return settle(failure(413, "payload_too_large", "file is too large"));
          }
          throw err;
        },
      );
      // The rejection is surfaced when the parser closes; avoid an unhandled-rejection warning.
      work.catch(() => {});
    });
    // Text fields are not used; busboy discards them (bounded by the limits above).
    parser.on("error", broken);
    parser.on("close", () => {
      (work ?? Promise.resolve()).then(() => {
        if (!sawFile) settle(failure(400, "invalid_request", "no file was sent"));
        resolve(outcome as ReceiveResult<T>);
      }, reject);
    });
    req.on("error", broken);
    req.pipe(parser);
  });
}
