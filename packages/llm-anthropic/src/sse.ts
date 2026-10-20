import { LlmAbortedError, LlmRequestError, LlmStreamError } from "./errors";

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Reads server-sent events from a response body without ever buffering more than the caps: one
 * event over `maxEventBytes` or a body over `maxTotalBytes` is an LlmRequestError. The reader is
 * cancelled on every path (end, error, abort, early return of the consumer). An event that the
 * stream ends in the middle of is dropped, as the SSE standard says.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  caps: { maxEventBytes: number; maxTotalBytes: number },
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let total = 0;
  let buf = "";
  let eventBytes = 0;
  let event = "";
  let data: string[] = [];

  const line = (text: string): SseEvent | undefined => {
    eventBytes += Buffer.byteLength(text) + 1;
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

  /** Dispatches every complete line in `buf`. A trailing CR may be half of a CRLF, so it waits. */
  const pump = (final: boolean): SseEvent[] => {
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(buf);
      if (!m || (m[0] === "\r" && m.index + 1 === buf.length && !final)) break;
      const ev = line(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
      if (ev) out.push(ev);
    }
    if (eventBytes + Buffer.byteLength(buf) > caps.maxEventBytes) throw new LlmRequestError();
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
      buf += decoder.decode(chunk.value, { stream: true });
      for (const ev of pump(false)) yield ev;
    }
    buf += decoder.decode();
    for (const ev of pump(true)) yield ev;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
  }
}
