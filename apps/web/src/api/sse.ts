import { report } from "../report";
import { apiErrorFrom } from "./http";

export interface SseFrame {
  event: string;
  data: string;
  id: string | undefined;
}

/** Longest unterminated line, and most data in one event, that the parser will hold (characters). */
export const SSE_MAX_BUFFER = 1_048_576;

/** A frame or line grew past the bound. Carries no content. */
export class SseOverflowError extends Error {
  /** The frames that were completed before the bound was hit, so none is lost. */
  readonly frames: SseFrame[];
  constructor(frames: SseFrame[] = []) {
    super("sse overflow");
    this.name = "SseOverflowError";
    this.frames = frames;
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
    // A partial line that grows without a line end is only appended: no re-splitting (that would be quadratic).
    if (!this.buffer.endsWith("\r") && !/[\r\n]/.test(chunk)) {
      this.buffer += chunk;
      if (this.buffer.length > this.maxBuffer) return this.overflow([]);
      return [];
    }
    const text = this.buffer + chunk;
    const lines = text.split(/\r\n|\r|\n/);
    this.buffer = lines.pop() ?? ""; // an unterminated last line waits for more text
    // A chunk that ends in CR may be the first half of CRLF: hold that line back until the next chunk shows which.
    if (text.endsWith("\r")) this.buffer = `${lines.pop() ?? ""}\r`;
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
        if (value.length > this.maxBuffer || this.dataSize > this.maxBuffer)
          return this.overflow(out);
        this.data.push(value);
      } else if (field === "id" && !value.includes("\u0000")) this.lastEventId = value;
      else if (field === "retry" && /^\d{1,6}$/.test(value)) this.retryMs = Number(value);
    }
    if (this.buffer.length > this.maxBuffer) return this.overflow(out);
    return out;
  }

  private overflow(done: SseFrame[]): never {
    this.buffer = "";
    this.event = "";
    this.data = [];
    this.dataSize = 0;
    throw new SseOverflowError(done);
  }
}

export type SseCloseReason = "unauthorized" | "not_found" | "rejected" | "closed" | "failed";

export interface SseOptions {
  /** Read again before every attempt, so a resume cursor can live in the query. */
  url: string | (() => string);
  fetch?: typeof fetch;
  /** The id to send as `Last-Event-ID` on the first attempt; later attempts use the last id received. */
  lastEventId?: () => string | undefined;
  onOpen?(): void;
  onFrame(frame: SseFrame): void;
  /** Called once, with the reason the stream ended for good. "failed" means it kept opening but never made progress. */
  onClose?(reason: SseCloseReason): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** Random source in [0, 1) for jitter; injectable for tests. */
  random?(): number;
  /** Clock in ms; injectable for tests. */
  now?(): number;
  /** How long a connection that only got heartbeats must have lived to count as healthy (default max(2*base, 10 s)). */
  minLiveMs?: number;
  baseDelayMs?: number;
  /** Cap for every delay, the server's `retry:` and `Retry-After` included. */
  maxDelayMs?: number;
  /** Consecutive connections that opened and died with no frame before the stream gives up (default 8). */
  maxDeadOpens?: number;
  /** Consecutive connections that hit the frame-size bound before the stream gives up (default 3). */
  maxOverflows?: number;
}
export type OpenSse = typeof openSse;

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * A resumable event-stream reader over fetch. It reconnects with `Last-Event-ID`. Every delay is the larger of the
 * backoff (base, doubling per failure) and the server's last `retry:` / `Retry-After`, clamped to [base/4, max], then
 * jittered into [50%, 100%]. The failure count resets only after a connection delivered a frame. 401, 404 and 400/403
 * end it for good and say why; so do too many oversized-frame connections or connections that open and die without a
 * frame ("failed"). Frames are delivered in order; a handler that throws is reported by class and the stream goes on.
 */
export function openSse(o: SseOptions): { close(): void } {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = o.sleep ?? realSleep;
  const random = o.random ?? Math.random;
  const base = o.baseDelayMs ?? 1000;
  const max = o.maxDelayMs ?? 30_000;
  const now = o.now ?? Date.now;
  const minLive = o.minLiveMs ?? Math.max(base * 2, 10_000);
  const floor = Math.min(base / 4, max);
  const maxDead = o.maxDeadOpens ?? 8;
  const maxOverflows = o.maxOverflows ?? 3;
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
    let dead = 0;
    let overflows = 0;
    let serverRetry: number | undefined;
    let lastId = o.lastEventId?.();
    while (!closed) {
      const t0 = now();
      let frames = 0;
      let alive = false; // any bytes at all, heartbeat comments included
      let opened = false;
      let overflowed = false;
      let retryAfterMs: number | undefined;
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
        const release = () => void res.body?.cancel().catch(() => {});
        if (res.status === 401 || res.status === 404 || res.status === 400 || res.status === 403) {
          release();
          return stop(
            res.status === 401 ? "unauthorized" : res.status === 404 ? "not_found" : "rejected",
          );
        }
        const type = res.headers.get("content-type") ?? "";
        if (!res.ok || !res.body || !type.toLowerCase().startsWith("text/event-stream")) {
          if (!res.ok) {
            const seconds = apiErrorFrom(res.status, "", res.headers.get("retry-after")).retryAfter;
            if (seconds !== undefined) retryAfterMs = seconds * 1000;
          }
          release();
          throw new Error("not open");
        }
        opened = true;
        if (!closed) o.onOpen?.();
        const parser = new SseParser();
        const reader = res.body.getReader();
        reading = reader;
        const text = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done || closed) break;
          if (value.length > 0) alive = true;
          let batch: SseFrame[];
          try {
            batch = parser.push(text.decode(value, { stream: true }));
          } catch (err) {
            if (!(err instanceof SseOverflowError)) throw err;
            batch = err.frames;
            overflowed = true;
          }
          for (const frame of batch) {
            if (closed) break;
            frames++;
            try {
              o.onFrame(frame);
            } catch (err) {
              report("sse-frame", err);
            }
            if (frame.id !== undefined) lastId = frame.id;
          }
          // An id with no data still moves the resume point (the spec); an oversized event's id does not, so it is not skipped.
          if (!overflowed && parser.lastEventId !== undefined) lastId = parser.lastEventId;
          if (parser.retryMs !== undefined) serverRetry = parser.retryMs;
          if (overflowed) break; // drop the connection; resume from the last id
        }
      } catch {
        if (closed) return;
      } finally {
        void reading?.cancel().catch(() => {});
        reading = undefined;
      }
      if (closed) return;
      if (overflowed) {
        failures++;
        if (++overflows >= maxOverflows) return stop("failed");
      } else if (frames > 0 || (alive && now() - t0 >= minLive)) {
        failures = 0;
        dead = 0;
        overflows = 0;
      } else {
        failures++;
        if (opened && ++dead >= maxDead) return stop("failed");
      }
      let delay = failures === 0 ? base : base * 2 ** Math.min(failures - 1, 10);
      if (serverRetry !== undefined)
        delay = failures === 0 ? serverRetry : Math.max(delay, serverRetry);
      if (retryAfterMs !== undefined) delay = Math.max(delay, retryAfterMs);
      delay = Math.min(max, Math.max(floor, delay));
      await sleep(Math.round(delay * (0.5 + 0.5 * random())), ctl.signal);
    }
  })();

  return { close: () => stop("closed") };
}
