import {
  type LlmReasoningPart,
  type LlmRequest,
  type LlmStreamChunk,
  assistantMessageOf,
} from "@loom/llm";
import { describe, expect, it } from "vitest";
import { recordingObserver } from "./__helpers__/observer";
import { AnthropicMessagesProvider, type AnthropicOptions } from "./provider";

// Opt in with DOCMIND_TEST_ANTHROPIC_KEY (never set in CI; the key is never printed).
// DOCMIND_TEST_ANTHROPIC_MODEL overrides the model (default: the chat model).
const KEY = process.env.DOCMIND_TEST_ANTHROPIC_KEY;
const MODEL = process.env.DOCMIND_TEST_ANTHROPIC_MODEL ?? "claude-opus-5-5";

const make = (over: Partial<AnthropicOptions> = {}) =>
  new AnthropicMessagesProvider({
    apiKey: KEY as string,
    model: MODEL,
    maxTokens: 2_048,
    timeoutMs: 90_000,
    ...over,
  });
async function collect(it: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe.skipIf(!KEY)("real Anthropic API (opt-in)", () => {
  const ASK: LlmRequest = { messages: [{ role: "user", content: "Reply with the word ok" }] };

  it("complete() answers a one-word prompt", async () => {
    const res = await make({ maxTokens: 64 }).complete(ASK);
    expect(res.content.length).toBeGreaterThan(0);
  });

  it("stream() yields text, then one terminal chunk with usage", async () => {
    const chunks = await collect(make({ maxTokens: 64 }).stream(ASK));
    expect(chunks.at(-1)?.done).toBe(true);
    expect(chunks.filter((c) => c.done)).toHaveLength(1);
    expect(chunks.map((c) => c.delta).join("").length).toBeGreaterThan(0);
    expect(chunks.at(-1)?.usage?.outputTokens).toBeGreaterThan(0);
  });

  it("runs a tool loop with adaptive thinking, effort and caching: the API accepts the reasoning parts sent back", async () => {
    const rec = recordingObserver();
    const p = make({ thinking: true, effort: "low", cache: true, observer: () => rec.observer });
    const first: LlmRequest = {
      system: "Use the get_weather tool when asked about the weather.",
      messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
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
    const firstChunks = await collect(p.stream(first));
    const end = firstChunks.at(-1);
    const calls = end?.toolCalls ?? [];
    expect(end?.stopReason).toBe("tool_use");
    expect(calls.length).toBeGreaterThan(0);
    // What Loom's loop records and sends back: the reasoning as parts (text resolved from the store), in vendor order.
    const recorded: LlmReasoningPart[] = (end?.reasoning ?? []).map((r) => ({
      type: "reasoning",
      kind: r.kind,
      provider: r.provider,
      ...(r.signature !== undefined && { signature: r.signature }),
      ...(r.text !== undefined && r.text !== "" && { text: r.text }),
    }));
    const assistant = assistantMessageOf({
      content: firstChunks.map((c) => c.delta).join(""),
      toolCalls: calls,
      reasoning: recorded,
      ...(end?.layout && { layout: end.layout }),
    });
    const toolResults = {
      role: "user" as const,
      content: calls.map((c) => ({
        type: "tool_result" as const,
        toolUseId: c.id,
        content: "18 C and sunny",
      })),
    };
    const second: LlmRequest = { ...first, messages: [...first.messages, assistant, toolResults] };
    const secondChunks = await collect(p.stream(second));
    expect(secondChunks.at(-1)?.stopReason).toBe("end_turn");
    expect(secondChunks.map((c) => c.delta).join("").length).toBeGreaterThan(0);
    expect(rec.usage.length).toBe(2);
  });

  it("FALLBACK PROBE: a tool-loop continuation with the thinking blocks dropped (what Loom's drop rule sends) is accepted", async () => {
    const p = make({ thinking: true, effort: "low" });
    const first: LlmRequest = {
      messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
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
    const calls = (await collect(p.stream(first))).at(-1)?.toolCalls ?? [];
    expect(calls.length).toBeGreaterThan(0);
    const second: LlmRequest = {
      ...first,
      messages: [
        ...first.messages,
        {
          role: "assistant",
          content: calls.map((c) => ({
            type: "tool_use" as const,
            id: c.id,
            name: c.name,
            input: c.input,
          })),
        },
        {
          role: "user",
          content: calls.map((c) => ({
            type: "tool_result" as const,
            toolUseId: c.id,
            content: "18 C",
          })),
        },
      ],
    };
    expect((await collect(p.stream(second))).at(-1)?.done).toBe(true);
  });
});
