import { LlmAbortedError, LlmRequestError, LlmStreamError } from "./errors";

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Reads server-sent events from a response body without ever buffering more than the caps: one
 * event over `maxEventBytes` or a body over `maxTotalBytes` is an LlmRequestError. The reader is
 * taken eagerly and cancelled on every path (end, error, abort, early return of the consumer, even
 * before the first `next()`). An event that the stream ends in the middle of is dropped, as the SSE
 * standard says. Work is linear in the body size: each decoded piece is scanned once.
 */
export function readSse(
  body: ReadableStream<Uint8Array>,
  caps: { maxEventBytes: number; maxTotalBytes: number },
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const release = () => reader.cancel().catch(() => {});
  const gen = run(reader, release, caps, signal);
  return {
    next: () => gen.next(),
    return: async (value?: unknown) => {
      await release();
      return gen.return(value as undefined);
    },
    throw: async (err?: unknown) => {
      await release();
      return gen.throw(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<SseEvent, void, undefined>;
}

async function* run(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  release: () => Promise<void>,
  caps: { maxEventBytes: number; maxTotalBytes: number },
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, undefined> {
  const decoder = new TextDecoder();
  const cancel = () => {
    void release();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const bytes = (s: string) => Buffer.byteLength(s);
  let total = 0;
  let eventBytes = 0; // bytes of the lines of the event so far, terminators included
  let event = "";
  let data: string[] = [];
  let partial: string[] = []; // pieces of the current unterminated line
  let partialBytes = 0;
  let skipLf = false; // the last piece ended in CR: a following LF belongs to it

  const line = (text: string, terminatorBytes: number): SseEvent | undefined => {
    eventBytes += bytes(text) + terminatorBytes;
    if (eventBytes > caps.maxEventBytes) throw new LlmRequestError();
    if (text === "") {
      const out =
        data.length > 0
          ? { event: event === "" ? "message" : event, data: data.join("\n") }
          : undefined;
      event = "";
      data = [];
      eventBytes = 0;
      return out;
    }
    if (text.startsWith(":")) return undefined;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return undefined;
  };

  /** Dispatches the lines ended inside `t`, scanning only `t`; the open tail is kept as pieces. */
  const pump = (t: string, final: boolean): SseEvent[] => {
    const out: SseEvent[] = [];
    let pos = 0;
    if (skipLf && t.length > 0) {
      skipLf = false;
      if (t.startsWith("\n")) {
        pos = 1;
        eventBytes += 1;
        if (eventBytes > caps.maxEventBytes) throw new LlmRequestError();
      }
    }
    const re = /\r\n|\n|\r/g;
    for (;;) {
      re.lastIndex = pos;
      const m = re.exec(t);
      if (!m) break;
      const text =
        partial.length > 0 ? partial.join("") + t.slice(pos, m.index) : t.slice(pos, m.index);
      partial = [];
      partialBytes = 0;
      const ev = line(text, m[0].length);
      pos = m.index + m[0].length;
      if (m[0] === "\r" && pos === t.length && !final) skipLf = true;
      if (ev) out.push(ev);
    }
    if (pos < t.length) {
      const rest = t.slice(pos);
      partial.push(rest);
      partialBytes += bytes(rest);
      if (eventBytes + partialBytes > caps.maxEventBytes) throw new LlmRequestError();
    }
    return out;
  };

  try {
    for (;;) {
      if (signal?.aborted) throw new LlmAbortedError();
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        throw signal?.aborted ? new LlmAbortedError() : new LlmStreamError();
      }
      if (signal?.aborted) throw new LlmAbortedError();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > caps.maxTotalBytes) throw new LlmRequestError();
      for (const ev of pump(decoder.decode(chunk.value, { stream: true }), false)) {
        if (signal?.aborted) throw new LlmAbortedError();
        yield ev;
      }
    }
    for (const ev of pump(decoder.decode(), true)) {
      if (signal?.aborted) throw new LlmAbortedError();
      yield ev;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await release();
  }
}
