/**
 * A response body made of the given parts. `end`: "close" ends it cleanly, "error" fails it after
 * the last part (a connection reset), "stall" never ends. `state.released` turns true when the body
 * is closed or errored by the source, or cancelled by its reader, so a "stall" body proves a cancel.
 */
export function bodyOf(
  parts: readonly (string | Uint8Array)[],
  end: "close" | "error" | "stall" = "close",
  signal?: AbortSignal,
) {
  const state = { released: false };
  const enc = new TextEncoder();
  let i = 0;
  let wake: () => void = () => {};
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
    pull(c) {
      const p = parts[i++];
      if (p !== undefined) {
        c.enqueue(typeof p === "string" ? enc.encode(p) : p);
        return;
      }
      if (end === "close") {
        state.released = true;
        c.close();
        return;
      }
      if (end === "error") {
        state.released = true;
        c.error(new Error("socket reset"));
        return;
      }
      return new Promise<void>((resolve) => {
        wake = resolve;
      });
    },
    cancel() {
      state.released = true;
      wake();
    },
  });
  signal?.addEventListener(
    "abort",
    () => {
      state.released = true;
      ctrl?.error(new DOMException("aborted", "AbortError"));
      wake();
    },
    { once: true },
  );
  return { body, state };
}

/** A `fetch` that serves the given SSE parts (default: never ends) and records each request body. */
export function sseFetch(
  parts: readonly (string | Uint8Array)[],
  end: "close" | "error" | "stall" = "stall",
  status = 200,
) {
  const requests: Record<string, unknown>[] = [];
  const bodies: { released: boolean }[] = [];
  const f: typeof fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const { body, state } = bodyOf(parts, end, init?.signal ?? undefined);
    bodies.push(state);
    return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: f, requests, bodies };
}

export const allReleased = (t: { bodies: { released: boolean }[] }): boolean =>
  t.bodies.length > 0 && t.bodies.every((b) => b.released);
