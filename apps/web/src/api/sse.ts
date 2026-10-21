import { report } from "../report";

export interface SseFrame {
  event: string;
  data: string;
  id: string | undefined;
}

/** Longest unterminated line, and most data in one event, that the parser will hold (characters). */
export const SSE_MAX_BUFFER = 1_048_576;

/** A frame or line grew past the bound. Carries no content. */
export class SseOverflowError extends Error {
  constructor() {
    super("sse overflow");
    this.name = "SseOverflowError";
  }
}

/** The text/event-stream line protocol. Feed it decoded text in any chunking; it returns the frames completed so far. */
export class SseParser {
  lastEventId: string | undefined;
  retryMs: number | undefined;
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private dataSize = 0;

  /** @throws SseOverflowError when a line or an event exceeds `maxBuffer`; the parser is then reset. */
  constructor(private readonly maxBuffer = SSE_MAX_BUFFER) {}

  push(chunk: string): SseFrame[] {
    const text = this.buffer + chunk;
    const lines = text.split(/\r\n|\r|\n/);
    this.buffer = lines.pop() ?? ""; // an unterminated last line waits for more text
    // A chunk that ends in CR may be the first half of CRLF: hold that line back until the next chunk shows which.
    if (text.endsWith("\r")) this.buffer = `${lines.pop() ?? ""}\r`;
    if (this.buffer.length > this.maxBuffer) return this.overflow();
    const out: SseFrame[] = [];
    for (const line of lines) {
      if (line === "") {
        if (this.data.length > 0)
          out.push({
            event: this.event || "message",
            data: this.data.join("\n"),
            id: this.lastEventId,
          });
        this.event = "";
        this.data = [];
        this.dataSize = 0;
        continue;
      }
      if (line.startsWith(":")) continue;
      const at = line.indexOf(":");
      const field = at === -1 ? line : line.slice(0, at);
      let value = at === -1 ? "" : line.slice(at + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") {
        this.dataSize += value.length + 1;
        if (value.length > this.maxBuffer || this.dataSize > this.maxBuffer) return this.overflow();
        this.data.push(value);
      } else if (field === "id" && !value.includes("\u0000")) this.lastEventId = value;
      else if (field === "retry" && /^\d{1,6}$/.test(value)) this.retryMs = Number(value);
    }
    return out;
  }

  private overflow(): never {
    this.buffer = "";
    this.event = "";
    this.data = [];
    this.dataSize = 0;
    throw new SseOverflowError();
  }
}

export type SseCloseReason = "unauthorized" | "not_found" | "rejected" | "closed";

export interface SseOptions {
  /** Read again before every attempt, so a resume cursor can live in the query. */
  url: string | (() => string);
  fetch?: typeof fetch;
  /** The id to send as `Last-Event-ID` on the first attempt; later attempts use the last id received. */
  lastEventId?: () => string | undefined;
  onOpen?(): void;
  onFrame(frame: SseFrame): void;
  onClose?(reason: SseCloseReason): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  baseDelayMs?: number;
  maxDelayMs?: number;
}
export type OpenSse = typeof openSse;

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * A resumable event-stream reader over fetch. It reconnects with `Last-Event-ID` and backs off (the server's `retry:` wins
 * over the base delay; failures double up to the maximum; a good open resets the count). 401, 404 and 400/403 end it for
 * good and say why. Frames are delivered in order; a handler that throws is reported by class and the stream goes on.
 */
export function openSse(o: SseOptions): { close(): void } {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = o.sleep ?? realSleep;
  const base = o.baseDelayMs ?? 1000;
  const max = o.maxDelayMs ?? 30_000;
  const ctl = new AbortController();
  let closed = false;
  let reading: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stop = (reason: SseCloseReason) => {
    if (closed) return;
    closed = true;
    ctl.abort();
    void reading?.cancel().catch(() => {}); // release the body even when the platform does not tie it to the signal
    o.onClose?.(reason);
  };

  void (async () => {
    let failures = 0;
    let lastId = o.lastEventId?.();
    while (!closed) {
      let wait = base * 2 ** Math.min(failures, 10);
      try {
        const headers: Record<string, string> = {
          accept: "text/event-stream",
          ...(lastId !== undefined && { "last-event-id": lastId }),
        };
        const res = await doFetch(typeof o.url === "function" ? o.url() : o.url, {
          headers,
          credentials: "same-origin",
          cache: "no-store",
          signal: ctl.signal,
        });
        if (res.status === 401) return stop("unauthorized");
        if (res.status === 404) return stop("not_found");
        if (res.status === 400 || res.status === 403) return stop("rejected");
        if (!res.ok || !res.body) throw new Error("not open");
        failures = 0;
        wait = base;
        if (!closed) o.onOpen?.();
        const parser = new SseParser();
        const reader = res.body.getReader();
        reading = reader;
        const text = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done || closed) break;
          for (const frame of parser.push(text.decode(value, { stream: true }))) {
            if (closed) break;
            try {
              o.onFrame(frame);
            } catch (err) {
              report("sse-frame", err);
            }
          }
          if (parser.retryMs !== undefined) wait = parser.retryMs;
          lastId = parser.lastEventId ?? lastId;
        }
      } catch {
        if (closed) return;
        failures++; // includes an oversized frame: drop the connection and resume from the last id
      } finally {
        void reading?.cancel().catch(() => {});
        reading = undefined;
      }
      if (closed) return;
      await sleep(wait, ctl.signal);
    }
  })();

  return { close: () => stop("closed") };
}
