/**
 * Buffers the first `n` bytes of a stream so they can be inspected (magic-byte sniffing), then
 * hands back a stream that replays everything from byte 0. Pulls no more chunks than it needs.
 *
 * Disposal: if `rest` is iterated, leaving it early (break, throw, return) closes the source. If
 * the caller decides not to iterate `rest` at all (e.g. the head is rejected), it MUST call
 * `close()` so the source is released. `close()` is idempotent and safe after `rest` finished.
 */
export async function peek(
  source: AsyncIterable<Uint8Array>,
  n: number,
): Promise<{ head: Buffer; rest: AsyncIterable<Uint8Array>; close: () => Promise<void> }> {
  const iterator = source[Symbol.asyncIterator]();
  const buffered: Buffer[] = [];
  let have = 0;
  let ended = false;
  let closed = false;
  async function close(): Promise<void> {
    if (ended || closed) return;
    closed = true;
    await iterator.return?.();
  }
  while (have < n) {
    const next = await iterator.next();
    if (next.done) {
      ended = true;
      break;
    }
    const chunk = Buffer.from(next.value);
    buffered.push(chunk);
    have += chunk.length;
  }
  const all = Buffer.concat(buffered);
  async function* rest(): AsyncGenerator<Uint8Array> {
    try {
      if (all.length > 0) yield all;
      if (ended) return;
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          ended = true;
          return;
        }
        yield next.value;
      }
    } finally {
      await close();
    }
  }
  return { head: all.subarray(0, n), rest: rest(), close };
}
