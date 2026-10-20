import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSse } from "../sse";
import { type FakeAnthropic, startFakeAnthropic } from "./fakeAnthropic";
import type { StreamScript } from "./streamScript";

describe("FakeAnthropic.holdNext", () => {
  let fake: FakeAnthropic;
  beforeAll(async () => {
    fake = await startFakeAnthropic();
  });
  afterAll(async () => {
    await fake?.close();
  });
  const post = () =>
    fetch(`${fake.url}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: [] }] }),
    });

  it("parks the next request until released, and only that one", async () => {
    const gate = fake.holdNext();
    let answered = false;
    const parked = post().then((r) => {
      answered = true;
      return r.status;
    });
    await gate.reached;
    expect(answered).toBe(false);
    gate.release();
    await expect(parked).resolves.toBe(200);
    expect((await post()).status).toBe(200); // the next one is not held
  });
});

describe("FakeAnthropic streaming scripts", () => {
  let fake: FakeAnthropic;
  beforeAll(async () => {
    fake = await startFakeAnthropic();
  });
  afterAll(async () => {
    await fake?.close();
  });
  const post = (extra: object = {}) =>
    fetch(`${fake.url}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        ...extra,
      }),
    });
  const CAPS = { maxEventBytes: 1 << 20, maxTotalBytes: 1 << 22 };
  async function events(res: Response) {
    // biome-ignore lint/suspicious/noExplicitAny: the tests read loosely shaped event JSON
    const out: { event: string; data: Record<string, any> }[] = [];
    for await (const e of readSse(res.body as ReadableStream<Uint8Array>, CAPS)) {
      out.push({ event: e.event, data: JSON.parse(e.data) });
    }
    return out;
  }
  const SCRIPT: StreamScript = {
    steps: [
      { thinking: "hm" },
      { signature: "S1" },
      { text: "hello" },
      { toolUse: { id: "toolu_1", name: "t", input: { a: 1 } } },
      { stop: "tool_use" },
    ],
    usage: { cacheReadTokens: 9 },
  };

  it("renders a script as streaming events: blocks in order, split deltas, signature, usage and stop", async () => {
    fake.reply(() => ({ stream: SCRIPT }));
    const evs = await events(await post({ stream: true }));
    expect(evs.map((e) => e.event)).toEqual([
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(evs[0]?.data.message.usage).toEqual({
      input_tokens: 3,
      output_tokens: 1,
      cache_read_input_tokens: 9,
      cache_creation_input_tokens: 0,
    });
    const deltas = evs.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta);
    expect(deltas.filter((d) => d.type === "signature_delta")).toEqual([
      { type: "signature_delta", signature: "S1" },
    ]);
    expect(
      deltas
        .filter((d) => d.type === "input_json_delta")
        .map((d) => d.partial_json)
        .join(""),
    ).toBe('{"a":1}');
    expect(evs.at(-2)?.data.delta).toEqual({ stop_reason: "tool_use", stop_details: null });
    expect(evs.at(-2)?.data.usage).toEqual({ output_tokens: 1 });
  });

  it("renders the same script as a JSON message for a non-streaming request", async () => {
    fake.reply(() => ({ stream: SCRIPT }));
    const json = (await (await post()).json()) as Record<string, unknown>;
    expect(json.content).toEqual([
      { type: "thinking", thinking: "hm", signature: "S1" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "toolu_1", name: "t", input: { a: 1 } },
    ]);
    expect(json.stop_reason).toBe("tool_use");
    expect(json.usage).toEqual({
      input_tokens: 3,
      output_tokens: 1,
      cache_read_input_tokens: 9,
      cache_creation_input_tokens: 0,
    });
  });

  it("serves a plain text reply as a stream, and carries a refusal's details and an error step", async () => {
    fake.reply(() => ({ text: "cut", stopReason: "max_tokens" }));
    const plain = await events(await post({ stream: true }));
    expect(plain.at(-2)?.data.delta.stop_reason).toBe("max_tokens");
    fake.reply(() => ({
      stream: {
        steps: [
          { text: "no" },
          { stop: "refusal", details: { category: "cyber", explanation: "x" } },
        ],
      },
    }));
    const refused = await events(await post({ stream: true }));
    expect(refused.at(-2)?.data.delta.stop_details).toEqual({
      type: "refusal",
      category: "cyber",
      explanation: "x",
    });
    fake.reply(() => ({ stream: { steps: [{ text: "x" }, { error: "overloaded_error" }] } }));
    const failed = await events(await post({ stream: true }));
    expect(failed.at(-1)?.event).toBe("error");
    expect(failed.at(-1)?.data.error.type).toBe("overloaded_error");
    expect(failed.map((e) => e.event)).not.toContain("message_stop");
    expect((await post()).status).toBe(529);
  });

  it("pauses at a hold step until released, and delivers the rest afterwards", async () => {
    fake.reply(() => ({
      stream: { steps: [{ text: "a" }, { hold: true }, { text: "b" }, { stop: "end_turn" }] },
    }));
    const res = await post({ stream: true });
    const seen: string[] = [];
    const texts: string[] = [];
    let sawA: () => void = () => {};
    const aArrived = new Promise<void>((r) => {
      sawA = r;
    });
    const reading = (async () => {
      for await (const e of readSse(res.body as ReadableStream<Uint8Array>, CAPS)) {
        seen.push(e.event);
        const d = JSON.parse(e.data).delta;
        if (d?.type === "text_delta") texts.push(d.text);
        if (texts.includes("a")) sawA();
      }
    })();
    await aArrived; // "a" was delivered before the hold
    const gate = await fake.streamHold();
    expect(seen).not.toContain("message_stop"); // the server has not sent it yet, whatever the client has read
    expect(texts).not.toContain("b");
    gate.release();
    await reading;
    expect(texts).toEqual(["a", "b"]);
    expect(seen.at(-1)).toBe("message_stop");
  });

  it("close() frees a response that is held", async () => {
    const own = await startFakeAnthropic({
      reply: () => ({ stream: { steps: [{ hold: true }] } }),
    });
    const res = await fetch(`${own.url}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: [] }] }),
    });
    await own.streamHold();
    await expect(own.close()).resolves.toBeUndefined();
    await res.body?.cancel().catch(() => {});
  });

  it("refuses a signature step that does not follow a thinking step", async () => {
    fake.reply(() => ({ stream: { steps: [{ signature: "S" }] } }));
    expect((await post({ stream: true })).status).toBe(500);
  });

  it("refuses an empty signature step", async () => {
    fake.reply(() => ({ stream: { steps: [{ thinking: "x" }, { signature: "" }] } }));
    expect((await post({ stream: true })).status).toBe(500);
  });

  it("a client that disconnects during a hold releases its own gate, and streamHold() skips dead gates", async () => {
    const own = await startFakeAnthropic({
      reply: () => ({ stream: { steps: [{ hold: true }, { text: "z" }, { stop: "end_turn" }] } }),
    });
    try {
      const ac = new AbortController();
      const first = fetch(`${own.url}/v1/messages`, {
        method: "POST",
        signal: ac.signal,
        body: JSON.stringify({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: [] }],
        }),
      });
      const resFirst = await first;
      const firstRead = resFirst.body
        ?.getReader()
        .read()
        .catch(() => {});
      const dead = await own.streamHold(); // reached, claimed
      ac.abort();
      await firstRead;
      // A second held stream: its gate, not the dead one, must be handed out.
      const res = await fetch(`${own.url}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: [] }],
        }),
      });
      const gate = await own.streamHold();
      expect(gate).not.toBe(dead);
      gate.release();
      expect((await events(res)).at(-1)?.event).toBe("message_stop");
    } finally {
      await own.close();
    }
  });

  it("drops an unclaimed gate whose client left, so the next streamHold() gets the new one", async () => {
    const own = await startFakeAnthropic({
      reply: () => ({ stream: { steps: [{ hold: true }, { text: "z" }, { stop: "end_turn" }] } }),
    });
    try {
      const ac = new AbortController();
      const first = await fetch(`${own.url}/v1/messages`, {
        method: "POST",
        signal: ac.signal,
        body: JSON.stringify({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: [] }],
        }),
      });
      const firstRead = first.body
        ?.getReader()
        .read()
        .catch(() => {});
      // Wait for the server to see the abort: the first request's response closes.
      ac.abort();
      await firstRead;
      const res = await fetch(`${own.url}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: [] }],
        }),
      });
      const gate = await own.streamHold();
      gate.release();
      expect((await events(res)).at(-1)?.event).toBe("message_stop");
    } finally {
      await own.close();
    }
  });

  it("close() rejects a streamHold() that is still waiting", async () => {
    const own = await startFakeAnthropic();
    const pending = own.streamHold();
    await own.close();
    await expect(pending).rejects.toThrow(/closed/);
  });
});
