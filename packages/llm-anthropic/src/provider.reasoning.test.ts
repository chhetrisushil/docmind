import {
  type LlmReasoningPart,
  type LlmRequest,
  type LlmStreamChunk,
  assembleStream,
  assistantMessageOf,
} from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allReleased, sseFetch } from "./__helpers__/bodyOf";
import * as f from "./__helpers__/frames";
import { recordingObserver } from "./__helpers__/observer";
import { AnthropicMessagesProvider, type AnthropicOptions } from "./provider";
import { type FakeAnthropic, startFakeAnthropic } from "./testing/fakeAnthropic";

const HI: LlmRequest = { messages: [{ role: "user", content: "hi" }] };
const A = "anthropic";
const make = (over: Partial<AnthropicOptions> = {}) =>
  new AnthropicMessagesProvider({
    apiKey: "test-key-not-real",
    model: "claude-haiku-5-5",
    maxTokens: 256,
    timeoutMs: 5_000,
    thinking: true,
    ...over,
  });
async function collect(it: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("complete(): reasoning and layout (ADR 0133 D2, D5)", () => {
  let fake: FakeAnthropic;
  beforeAll(async () => {
    fake = await startFakeAnthropic();
  });
  afterAll(async () => {
    await fake?.close();
  });
  const message = (content: unknown[], over: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: "msg_t",
      type: "message",
      role: "assistant",
      content,
      stop_reason: "end_turn",
      stop_details: null,
      usage: { input_tokens: 5, output_tokens: 7 },
      ...over,
    });
  const run = (
    content: unknown[],
    over: Record<string, unknown> = {},
    opts: Partial<AnthropicOptions> = {},
  ) => {
    fake.reply(() => ({ status: 200, rawBody: message(content, over) }));
    return make({ baseUrl: fake.url, ...opts }).complete(HI);
  };

  it("maps thinking to a summary, redacted_thinking to a redacted part, in order, and records no layout for the canonical order", async () => {
    const res = await run(
      [
        { type: "thinking", thinking: "Let me think", signature: "SIG==" },
        { type: "redacted_thinking", data: "ENC" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
      ],
      { stop_reason: "tool_use" },
    );
    expect(res.content).toBe("answer");
    expect(res.reasoning).toEqual([
      { kind: "summary", text: "Let me think", signature: "SIG==", provider: A },
      { kind: "redacted", signature: "ENC", provider: A },
    ]);
    expect(res.layout).toBeUndefined();
    expect(res.toolCalls).toEqual([{ id: "toolu_1", name: "search_docs", input: {} }]);
  });

  it("maps an omitted-display thinking block (empty text) to kind text with an empty string and its signature", async () => {
    const res = await run([
      { type: "thinking", thinking: "", signature: "S0" },
      { type: "text", text: "a" },
    ]);
    expect(res.reasoning).toEqual([{ kind: "text", text: "", signature: "S0", provider: A }]);
  });

  it("records the vendor's order when it is not canonical: thinking, tool_use, thinking, tool_use", async () => {
    const res = await run(
      [
        { type: "thinking", thinking: "a", signature: "S1" },
        { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
        { type: "thinking", thinking: "b", signature: "S2" },
        { type: "tool_use", id: "toolu_2", name: "related", input: {} },
      ],
      { stop_reason: "tool_use" },
    );
    expect(res.reasoning?.map((r) => r.text)).toEqual(["a", "b"]);
    expect(res.layout).toEqual([
      "reasoning",
      { call: "toolu_1" },
      "reasoning",
      { call: "toolu_2" },
    ]);
  });

  it("records text lengths in the layout when a text block follows a tool call, and drops an empty text block", async () => {
    const res = await run(
      [
        { type: "thinking", thinking: "a", signature: "S1" },
        { type: "text", text: "ab" },
        { type: "text", text: "" },
        { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
        { type: "text", text: "c" },
      ],
      { stop_reason: "tool_use" },
    );
    expect(res.content).toBe("abc");
    expect(res.layout).toEqual(["reasoning", { text: 2 }, { call: "toolu_1" }, { text: 1 }]);
  });

  it("adds no reasoning or layout key to a response without thinking, whatever the option", async () => {
    const res = await run([{ type: "text", text: "plain" }]);
    expect(Object.keys(res).sort()).toEqual(["content", "stopReason", "usage"]);
  });

  it("returns no reasoning, layout or tool calls for a refused response in report mode, and keeps the text", async () => {
    const rec = recordingObserver();
    const res = await run(
      [
        { type: "thinking", thinking: "t", signature: "S" },
        { type: "text", text: "I can't help" },
        { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
      ],
      { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } },
      { refusal: "report", observer: () => rec.observer },
    );
    expect(res).toEqual({
      content: "I can't help",
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    expect(rec.refusals).toEqual([{ category: "cyber" }]);
  });

  it("gives the observer usage detail, with null cache fields as 0", async () => {
    const rec = recordingObserver();
    await run(
      [{ type: "text", text: "a" }],
      {
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: null,
        },
      },
      { observer: () => rec.observer },
    );
    expect(rec.usage).toEqual([
      { inputTokens: 5, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 0 },
    ]);
    expect(rec.log).toEqual(["usage"]);
  });
});

describe("stream(): reasoningDelta and the terminal reasoning", () => {
  it("streams thinking text as reasoningDelta, never into delta, and reports reasoning on the terminal chunk", async () => {
    const t = sseFetch([
      f.start(),
      ...f.thinking(0, ["Let me ", "think"], "SIG=="),
      ...f.text(1, "answer"),
      f.end("end_turn"),
      f.stop(),
    ]);
    const chunks = await collect(make({ fetch: t.fetch }).stream(HI));
    expect(chunks.filter((c) => c.reasoningDelta === undefined).map((c) => c.delta)).toEqual([
      "answer",
      "",
    ]);
    expect(chunks.every((c) => c.reasoningDelta === undefined || c.delta === "")).toBe(true);
    expect(
      chunks.flatMap((c) => (c.reasoningDelta === undefined ? [] : [c.reasoningDelta])),
    ).toEqual(["Let me ", "think"]);
    const last = chunks.at(-1);
    expect(last?.reasoning).toEqual([
      { kind: "summary", text: "Let me think", signature: "SIG==", provider: A },
    ]);
    expect(last?.layout).toBeUndefined();
    expect(allReleased(t)).toBe(true);
  });

  it("streams text that arrives with the block start, and sends nothing for an empty thinking block", async () => {
    const t = sseFetch([
      f.start(),
      f.open(0, { type: "thinking", thinking: "first " }),
      f.delta(0, { type: "thinking_delta", thinking: "second" }),
      f.delta(0, { type: "signature_delta", signature: "S1" }),
      f.close(0),
      f.open(1, { type: "thinking", thinking: "" }),
      f.delta(1, { type: "signature_delta", signature: "S2" }),
      f.close(1),
      ...f.text(2, "a"),
      f.end("end_turn"),
      f.stop(),
    ]);
    const chunks = await collect(make({ fetch: t.fetch }).stream(HI));
    expect(
      chunks.flatMap((c) => (c.reasoningDelta === undefined ? [] : [c.reasoningDelta])),
    ).toEqual(["first ", "second"]);
    expect(chunks.at(-1)?.reasoning).toEqual([
      { kind: "summary", text: "first second", signature: "S1", provider: A },
      { kind: "text", text: "", signature: "S2", provider: A },
    ]);
  });

  it("reports a redacted block with no delta and its data as the signature", async () => {
    const t = sseFetch([
      f.start(),
      f.open(0, { type: "redacted_thinking", data: "ENC" }),
      f.close(0),
      ...f.text(1, "a"),
      f.end("end_turn"),
      f.stop(),
    ]);
    const chunks = await collect(make({ fetch: t.fetch }).stream(HI));
    expect(chunks.some((c) => c.reasoningDelta !== undefined)).toBe(false);
    expect(chunks.at(-1)?.reasoning).toEqual([{ kind: "redacted", signature: "ENC", provider: A }]);
  });

  it("gives the observer usage detail before the terminal chunk", async () => {
    const rec = recordingObserver();
    const t = sseFetch([
      f.start({
        input_tokens: 5,
        output_tokens: 1,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      }),
      ...f.text(0, "a"),
      f.end("end_turn"),
      f.stop(),
    ]);
    let seen = -1;
    for await (const c of make({ fetch: t.fetch, observer: () => rec.observer }).stream(HI)) {
      if (c.done) seen = rec.log.length;
    }
    expect(rec.usage).toEqual([
      { inputTokens: 5, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 20 },
    ]);
    expect(seen).toBe(1);
  });
});

describe("complete() and stream() report the same reasoning and layout (parity, ADR 0133 D2)", () => {
  let fake: FakeAnthropic;
  beforeAll(async () => {
    fake = await startFakeAnthropic();
  });
  afterAll(async () => {
    await fake?.close();
  });
  const LAYOUTS: Record<string, unknown> = {
    canonical: undefined,
    interleaved: ["reasoning", { call: "toolu_1" }, "reasoning", { call: "toolu_2" }],
    textAfterCall: ["reasoning", { text: 2 }, { call: "toolu_1" }, { text: 1 }],
  };
  const SCRIPTS = {
    canonical: [
      { thinking: "Considering." },
      { signature: "S1" },
      { text: "ok" },
      { stop: "end_turn" as const },
    ],
    interleaved: [
      { thinking: "a" },
      { signature: "S1" },
      { toolUse: { id: "toolu_1", name: "search_docs", input: { query: "x" } } },
      { thinking: "b" },
      { signature: "S2" },
      { toolUse: { id: "toolu_2", name: "related", input: {} } },
      { stop: "tool_use" as const },
    ],
    textAfterCall: [
      { thinking: "a" },
      { signature: "S1" },
      { text: "ab" },
      { toolUse: { id: "toolu_1", name: "search_docs", input: {} } },
      { text: "c" },
      { stop: "tool_use" as const },
    ],
  };
  for (const [name, steps] of Object.entries(SCRIPTS)) {
    it(`${name}: the streamed result equals the completed one, and the deltas equal the readable text`, async () => {
      fake.reply(() => ({ stream: { steps } }));
      const p = make({ baseUrl: fake.url });
      const completed = await p.complete(HI);
      const chunks = await collect(p.stream(HI));
      expect(assembleStream(chunks)).toEqual(completed);
      expect(completed.layout).toEqual(LAYOUTS[name]);
      expect(assembleStream(chunks).layout).toEqual(LAYOUTS[name]);
      expect(completed.reasoning?.length).toBeGreaterThan(0);
      const readable = (completed.reasoning ?? []).map((r) => r.text ?? "").join("");
      expect(chunks.map((c) => c.reasoningDelta ?? "").join("")).toBe(readable);
    });
  }
});

describe("capabilities", () => {
  it("declares reasoning only when thinking is on, and keeps the media types", () => {
    expect(make().capabilities.reasoning).toBe(true);
    expect(make({ thinking: false }).capabilities.reasoning).toBeUndefined();
    expect(make().capabilities.file).toEqual(["application/pdf"]);
    expect(make().capabilities.image).toContain("image/png");
  });
});

describe("offline round trip: the recorded order goes back to the API unchanged (ADR 0133 D5)", () => {
  let fake: FakeAnthropic;
  beforeAll(async () => {
    fake = await startFakeAnthropic();
  });
  afterAll(async () => {
    await fake?.close();
  });
  const CASES = {
    interleaved: {
      steps: [
        { thinking: "a" },
        { signature: "S1" },
        { toolUse: { id: "toolu_1", name: "search_docs", input: { query: "x" } } },
        { thinking: "b" },
        { signature: "S2" },
        { toolUse: { id: "toolu_2", name: "related", input: {} } },
        { stop: "tool_use" as const },
      ],
      blocks: [
        { type: "thinking", thinking: "a", signature: "S1" },
        { type: "tool_use", id: "toolu_1", name: "search_docs", input: { query: "x" } },
        { type: "thinking", thinking: "b", signature: "S2" },
        { type: "tool_use", id: "toolu_2", name: "related", input: {} },
      ],
    },
    textAfterCall: {
      steps: [
        { thinking: "a" },
        { signature: "S1" },
        { text: "ab" },
        { toolUse: { id: "toolu_1", name: "search_docs", input: {} } },
        { text: "c" },
        { stop: "tool_use" as const },
      ],
      blocks: [
        { type: "thinking", thinking: "a", signature: "S1" },
        { type: "text", text: "ab" },
        { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
        { type: "text", text: "c" },
      ],
    },
  };
  for (const [name, c] of Object.entries(CASES)) {
    it(`${name}: stream, record with assistantMessageOf, send back: the blocks are identical, signatures included`, async () => {
      let n = 0;
      fake.reply(() =>
        n++ === 0
          ? { stream: { steps: c.steps } }
          : { stream: { steps: [{ text: "ok" }, { stop: "end_turn" as const }] } },
      );
      const p = make({ baseUrl: fake.url });
      const end = assembleStream(await collect(p.stream(HI)));
      // What Loom records: reasoning as parts (readable text resolved back from the store).
      const parts: LlmReasoningPart[] = (end.reasoning ?? []).map((r) => ({
        type: "reasoning",
        kind: r.kind,
        provider: r.provider,
        ...(r.signature !== undefined && { signature: r.signature }),
        ...(r.text !== undefined && r.text !== "" && { text: r.text }),
      }));
      const assistant = assistantMessageOf({
        content: end.content,
        ...(end.toolCalls && { toolCalls: end.toolCalls }),
        reasoning: parts,
        ...(end.layout && { layout: end.layout }),
      });
      const results = {
        role: "user" as const,
        content: (end.toolCalls ?? []).map((t) => ({
          type: "tool_result" as const,
          toolUseId: t.id,
          content: "r",
        })),
      };
      await collect(p.stream({ messages: [...HI.messages, assistant, results] }));
      expect(fake.requests.at(-1)?.body.messages[1]?.content).toEqual(c.blocks);
    });
  }
});
