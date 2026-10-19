import type { LlmRequest } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmAbortedError, LlmRefusalError, LlmRequestError, LlmUnavailableError } from "./errors";
import { AnthropicMessagesProvider } from "./provider";
import { type FakeAnthropic, startFakeAnthropic } from "./testing/fakeAnthropic";

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
    fake.reply(() => ({ status: 302, rawBody: "" }));
    await expect(provider().complete(HI)).rejects.toBeInstanceOf(LlmRequestError);
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
    for (const baseUrl of ["http://u:p@127.0.0.1", "http://127.0.0.1/?x=1", "file:///etc"]) {
      expect(() => provider({ baseUrl })).toThrow(
        /^baseUrl must be an http\(s\) URL without credentials, query or fragment$/,
      );
    }
  });
});
