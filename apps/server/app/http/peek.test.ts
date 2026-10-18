import { describe, expect, it } from "vitest";
import { peek } from "./peek";

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield Buffer.from(p);
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const out: Buffer[] = [];
  for await (const c of source) out.push(Buffer.from(c));
  return Buffer.concat(out).toString();
}

describe("peek", () => {
  it("returns the first n bytes and replays the whole stream", async () => {
    const { head, rest } = await peek(chunks("abc", "defgh", "ij"), 4);
    expect(head.toString()).toBe("abcd");
    expect(await collect(rest)).toBe("abcdefghij");
  });

  it("handles a stream shorter than n, and an empty one", async () => {
    const short = await peek(chunks("ab"), 10);
    expect(short.head.toString()).toBe("ab");
    expect(await collect(short.rest)).toBe("ab");
    const empty = await peek(chunks(), 10);
    expect(empty.head.length).toBe(0);
    expect(await collect(empty.rest)).toBe("");
  });

  it("reads no more than it needs", async () => {
    let pulled = 0;
    async function* counting() {
      for (const p of ["aa", "bb", "cc", "dd"]) {
        pulled++;
        yield Buffer.from(p);
      }
    }
    await peek(counting(), 3);
    expect(pulled).toBe(2);
  });

  function tracked() {
    const state = { closed: false };
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        for (const p of ["aa", "bb", "cc", "dd"]) yield Buffer.from(p);
      } finally {
        state.closed = true;
      }
    }
    return { state, source: source() };
  }

  it("closes the source when rest is left early", async () => {
    const { state, source } = tracked();
    const { rest } = await peek(source, 1);
    for await (const _ of rest) break;
    expect(state.closed).toBe(true);
  });

  it("closes the source via close() when rest is never iterated", async () => {
    const { state, source } = tracked();
    const { close } = await peek(source, 1);
    expect(state.closed).toBe(false);
    await close();
    expect(state.closed).toBe(true);
    await close();
  });

  it("propagates a source error raised during rest", async () => {
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("aa");
      throw new Error("boom");
    }
    const { rest } = await peek(failing(), 1);
    await expect(collect(rest)).rejects.toThrow("boom");
  });
});
