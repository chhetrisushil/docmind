import { inspect } from "node:util";
import type { LlmRequest } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmAbortedError, LlmRefusalError, LlmRequestError, LlmUnavailableError } from "./errors";
import { AnthropicMessagesProvider } from "./provider";
import { type FakeAnthropic, type FakeReply, startFakeAnthropic } from "./testing/fakeAnthropic";

let fake: FakeAnthropic;
beforeAll(async () => {
  fake = await startFakeAnthropic();
});
afterAll(async () => {
  await fake?.close();
});

const HI: LlmRequest = { messages: [{ role: "user", content: "hi" }] };
const provider = (over: Partial<ConstructorParameters<typeof AnthropicMessagesProvider>[0]> = {}) =>
  new AnthropicMessagesProvider({
    apiKey: "test-key-not-real",
    model: "claude-haiku-5-5",
    maxTokens: 256,
    timeoutMs: 5_000,
    baseUrl: fake.url,
    ...over,
  });

describe("AnthropicMessagesProvider over the fake server", () => {
  it("sends the key, the version header and the mapped body, and returns text, stop reason and usage", async () => {
    fake.reply(() => ({ text: "hello" }));
    const res = await provider().complete(HI);
    expect(res).toEqual({
      content: "hello",
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 1 },
    });
    const req = fake.requests.at(-1);
    expect(req?.headers["x-api-key"]).toBe("test-key-not-real");
    expect(req?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req?.body.model).toBe("claude-haiku-5-5");
  });

  it.each([408, 409, 429, 500, 503, 529])(
    "maps HTTP %i to LlmUnavailableError with only the status",
    async (status) => {
      fake.failNext(status);
      const err = await provider()
        .complete(HI)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmUnavailableError);
      expect((err as Error).message).toBe(`the language model is unavailable (HTTP ${status})`);
    },
  );

  it.each([400, 401, 403, 404, 413])(
    "maps HTTP %i to LlmRequestError and never reads the body into the error",
    async (status) => {
      fake.reply(() => ({ status, rawBody: '{"error":{"message":"SECRET-BODY-TEXT-xyz"}}' }));
      const err = await provider()
        .complete(HI)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmRequestError);
      expect(JSON.stringify({ m: (err as Error).message, s: (err as Error).stack })).not.toContain(
        "SECRET-BODY-TEXT",
      );
    },
  );

  it("maps stop_reason refusal to LlmRefusalError and max_tokens to stopReason max_tokens", async () => {
    fake.reply(() => ({ text: "", stopReason: "refusal" }));
    await expect(provider().complete(HI)).rejects.toBeInstanceOf(LlmRefusalError);
    fake.reply(() => ({ text: "partial", stopReason: "max_tokens" }));
    expect((await provider().complete(HI)).stopReason).toBe("max_tokens");
  });

  it("is unavailable on a connection failure and on its own timeout; aborted on the caller's signal", async () => {
    await expect(provider({ baseUrl: "http://127.0.0.1:9" }).complete(HI)).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    fake.reply(() => ({ hang: true }));
    await expect(provider({ timeoutMs: 20 }).complete(HI)).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    const ac = new AbortController();
    const pending = provider().complete({ ...HI, signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(LlmAbortedError);
  });

  it("refuses a response over maxResponseBytes, a redirect and a malformed body as LlmRequestError", async () => {
    fake.reply(() => ({ text: "x".repeat(10_000) }));
    await expect(provider({ maxResponseBytes: 1_000 }).complete(HI)).rejects.toBeInstanceOf(
      LlmRequestError,
    );
    const target = await startFakeAnthropic();
    try {
      fake.reply(() => ({
        status: 302,
        rawBody: "",
        headers: { location: `${target.url}/v1/messages` },
      }));
      await expect(provider().complete(HI)).rejects.toBeInstanceOf(LlmRequestError);
      expect(target.requests).toHaveLength(0);
    } finally {
      await target.close();
    }
    fake.reply(() => ({ status: 200, rawBody: "not json" }));
    await expect(provider().complete(HI)).rejects.toBeInstanceOf(LlmRequestError);
    fake.reply(() => ({
      status: 200,
      rawBody:
        '{"content":[],"stop_reason":"end_turn","usage":{"input_tokens":-1,"output_tokens":1}}',
    }));
    await expect(provider().complete(HI)).rejects.toBeInstanceOf(LlmRequestError);
  });

  it("refuses a baseUrl with credentials, a query or a non-http scheme, naming the option only", () => {
    for (const baseUrl of [
      "http://u:p@127.0.0.1",
      "http://127.0.0.1/?x=1",
      "http://127.0.0.1/?",
      "http://127.0.0.1/#f",
      "http://127.0.0.1/#",
      "file:///etc",
    ]) {
      expect(() => provider({ baseUrl })).toThrow(
        /^baseUrl must be an http\(s\) URL without credentials, query or fragment$/,
      );
    }
  });

  it("keeps the key out of JSON, inspect and own properties, and refuses a key that is not header-safe", () => {
    const p = provider({ apiKey: "sk-test-SECRETKEY-123" });
    expect(JSON.stringify(p)).not.toContain("SECRETKEY");
    expect(inspect(p, { depth: 5, showHidden: true })).not.toContain("SECRETKEY");
    for (const apiKey of ["", "a\r\nb", "a\nb", "k\u00e9y", "has space"]) {
      expect(() => provider({ apiKey })).toThrow(/^apiKey must be a header-safe string$/);
    }
  });
});

/** Wraps fetch so each response body records whether it was drained or cancelled. */
function trackedFetch() {
  const bodies: { released: boolean }[] = [];
  let firstChunk: () => void = () => {};
  const arrived = new Promise<void>((r) => {
    firstChunk = r;
  });
  const tracked: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (!res.body) return res;
    const state = { released: false };
    bodies.push(state);
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const { done, value } = await reader.read().catch((err: unknown) => {
          state.released = true; // the transport errored (abort or timeout): it is torn down
          throw err;
        });
        if (done) {
          state.released = true;
          c.close();
        } else {
          c.enqueue(value);
          firstChunk();
        }
      },
      async cancel(reason) {
        state.released = true;
        await reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(body, { status: res.status, headers: res.headers });
  };
  return { fetch: tracked, bodies, arrived };
}

describe("response body release", () => {
  const expectReleased = (t: ReturnType<typeof trackedFetch>) => {
    expect(t.bodies.length).toBeGreaterThan(0);
    expect(t.bodies.every((b) => b.released)).toBe(true);
  };

  it("releases the body on success, an error status, cap overflow and malformed JSON", async () => {
    const cases: [() => FakeReply, (p: AnthropicMessagesProvider) => Promise<unknown>][] = [
      [() => ({ text: "fine" }), (p) => p.complete(HI)],
      [
        () => ({ status: 400, rawBody: "{}" }),
        (p) => expect(p.complete(HI)).rejects.toBeInstanceOf(LlmRequestError),
      ],
      [
        () => ({ text: "x".repeat(10_000) }),
        (p) => expect(p.complete(HI)).rejects.toBeInstanceOf(LlmRequestError),
      ],
      [
        () => ({ status: 200, rawBody: "not json" }),
        (p) => expect(p.complete(HI)).rejects.toBeInstanceOf(LlmRequestError),
      ],
    ];
    for (const [reply, run] of cases) {
      fake.reply(reply);
      const t = trackedFetch();
      await run(provider({ fetch: t.fetch, maxResponseBytes: 1_000 }));
      expectReleased(t);
    }
  });

  it("times out mid-body as LlmUnavailableError and releases the body", async () => {
    fake.reply(() => ({ stallAfterHeaders: true }));
    const t = trackedFetch();
    await expect(provider({ fetch: t.fetch, timeoutMs: 100 }).complete(HI)).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    expectReleased(t);
  });

  it("aborts mid-body as LlmAbortedError and releases the body", async () => {
    fake.reply(() => ({ stallAfterHeaders: true }));
    const t = trackedFetch();
    const ac = new AbortController();
    const pending = provider({ fetch: t.fetch }).complete({ ...HI, signal: ac.signal });
    await t.arrived; // the first part of the body has been read
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(LlmAbortedError);
    expectReleased(t);
  });
});
