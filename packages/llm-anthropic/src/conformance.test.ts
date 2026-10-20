import { runLlmProviderConformance } from "@loom/conformance";
import { type LlmRequest, type LlmStreamChunk, assembleStream } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordingObserver } from "./__helpers__/observer";
import { LlmRefusalError } from "./errors";
import { AnthropicMessagesProvider, type AnthropicOptions } from "./provider";
import type { AnthropicBody } from "./request";
import {
  type FakeAnthropic,
  type FakeReply,
  type StreamStep,
  startFakeAnthropic,
} from "./testing/fakeAnthropic";

const CALL = { id: "toolu_conf", name: "get_weather", input: { city: "Paris" } };
const TOOL_REQUEST: LlmRequest = {
  messages: [{ role: "user", content: "What is the weather in Paris?" }],
  tools: [
    {
      name: "get_weather",
      description: "Current weather for a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
};

/** A request with tools gets a tool call; a thinking request gets a thinking block in front. */
function replyFor(body: AnthropicBody): FakeReply {
  const lead: StreamStep[] = body.thinking ? [{ thinking: "Considering." }] : [];
  if (body.tools?.length) {
    return {
      stream: { steps: [...lead, { text: "Checking." }, { toolUse: CALL }, { stop: "tool_use" }] },
    };
  }
  return body.thinking
    ? { stream: { steps: [...lead, { text: "ok" }, { stop: "end_turn" }] } }
    : {};
}

let fake: FakeAnthropic;
beforeAll(async () => {
  fake = await startFakeAnthropic({ reply: replyFor });
});
afterAll(async () => {
  await fake?.close();
});

const make = (over: Partial<AnthropicOptions> = {}, baseUrl = fake.url) =>
  new AnthropicMessagesProvider({
    apiKey: "test-key-not-real",
    model: "claude-haiku-5-5",
    maxTokens: 256,
    timeoutMs: 5_000,
    baseUrl,
    ...over,
  });

runLlmProviderConformance(() => make(), "AnthropicMessagesProvider", {
  toolRequest: TOOL_REQUEST,
});

// The chat configuration: thinking never reaches `content`, so the streamed text equals the completed text.
runLlmProviderConformance(
  () => make({ thinking: true, effort: "low", cache: true }),
  "AnthropicMessagesProvider (thinking, effort, cache)",
  { toolRequest: TOOL_REQUEST },
);

// Loom's reasoning parity rule (ADR 0133 D2) runs inside the thinking configuration above only if that
// configuration really reports reasoning: prove the run is not vacuous.
describe("the thinking configuration reports reasoning, so the parity rule has something to check", () => {
  it("returns the summary with its signature and no layout", async () => {
    const done = await make({ thinking: true }).complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(done.reasoning).toEqual([
      { kind: "summary", text: "Considering.", signature: "fake-signature", provider: "anthropic" },
    ]);
    expect(done.layout).toBeUndefined();
  });
});

async function chunksOf(it: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("complete() and stream() agree on refusals, usage detail, reasoning and layout", () => {
  let own: FakeAnthropic;
  beforeAll(async () => {
    own = await startFakeAnthropic();
  });
  afterAll(async () => {
    await own?.close();
  });
  const HI: LlmRequest = { messages: [{ role: "user", content: "hi" }] };
  const REFUSAL: StreamStep[] = [
    { text: "no" },
    { stop: "refusal", details: { category: "cyber" } },
  ];

  it("throws the same LlmRefusalError from both when refusal is 'throw' (ingest)", async () => {
    own.reply(() => ({ stream: { steps: REFUSAL } }));
    const p = make({}, own.url);
    await expect(p.complete(HI)).rejects.toBeInstanceOf(LlmRefusalError);
    await expect(chunksOf(p.stream(HI))).rejects.toBeInstanceOf(LlmRefusalError);
  });

  it("ends the turn identically from both when refusal is 'report', with the same details", async () => {
    own.reply(() => ({ stream: { steps: REFUSAL } }));
    const a = recordingObserver();
    const b = recordingObserver();
    const completed = await make(
      { refusal: "report", observer: () => a.observer },
      own.url,
    ).complete(HI);
    const streamed = assembleStream(
      await chunksOf(make({ refusal: "report", observer: () => b.observer }, own.url).stream(HI)),
    );
    expect(completed).toEqual({
      content: "no",
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 1 },
    });
    expect(streamed).toEqual(completed);
    expect(a.refusals).toEqual([{ category: "cyber" }]);
    expect(b.refusals).toEqual(a.refusals);
  });

  it("reports the same usage detail, reasoning and layout from both", async () => {
    own.reply(() => ({
      stream: {
        steps: [
          { thinking: "hm" },
          { signature: "S1" },
          { text: "t" },
          { toolUse: CALL },
          { stop: "tool_use" },
        ],
        usage: { cacheReadTokens: 40, cacheWriteTokens: 8 },
      },
    }));
    const a = recordingObserver();
    const b = recordingObserver();
    const opts = { thinking: true } as const;
    const completed = await make({ ...opts, observer: () => a.observer }, own.url).complete(HI);
    const streamed = assembleStream(
      await chunksOf(make({ ...opts, observer: () => b.observer }, own.url).stream(HI)),
    );
    expect(streamed).toEqual(completed);
    expect(completed.toolCalls).toEqual([CALL]);
    expect(completed.reasoning).toEqual([
      { kind: "summary", text: "hm", signature: "S1", provider: "anthropic" },
    ]);
    expect(completed.layout).toBeUndefined(); // thinking, text, tool_use is the canonical order
    expect(a.usage).toEqual([
      { inputTokens: 3, outputTokens: 1, cacheReadTokens: 40, cacheWriteTokens: 8 },
    ]);
    expect(b.usage).toEqual(a.usage);
  });
});
