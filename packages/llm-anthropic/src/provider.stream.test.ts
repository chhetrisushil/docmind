import type { LlmRequest, LlmStreamChunk } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { allReleased, sseFetch } from "./__helpers__/bodyOf";
import * as f from "./__helpers__/frames";
import { recordingObserver } from "./__helpers__/observer";
import {
  LlmAbortedError,
  LlmRefusalError,
  LlmRequestError,
  LlmStreamError,
  LlmUnavailableError,
} from "./errors";
import { AnthropicMessagesProvider } from "./provider";

const REQ: LlmRequest = { messages: [{ role: "user", content: "hi" }] };
const provider = (fetchImpl: typeof fetch, over: object = {}) =>
  new AnthropicMessagesProvider({
    apiKey: "test-key-not-real",
    model: "claude-haiku-5-5",
    maxTokens: 256,
    timeoutMs: 5_000,
    fetch: fetchImpl,
    ...over,
  });
async function collect(it: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("stream(): text, tool calls and usage", () => {
  it("yields text deltas, then one terminal chunk with the stop reason and usage; sends stream:true", async () => {
    const t = sseFetch([
      f.start(),
      f.ping(),
      ...f.text(0, "Hel", "lo"),
      f.end("end_turn", { output_tokens: 7 }),
      f.stop(),
    ]);
    const chunks = await collect(provider(t.fetch).stream(REQ));
    expect(chunks).toEqual([
      { delta: "Hel", done: false },
      { delta: "lo", done: false },
      { delta: "", done: true, stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 7 } },
    ]);
    expect(t.requests[0]?.stream).toBe(true);
    expect(allReleased(t)).toBe(true);
  });

  it("streams tool arguments as toolDelta chunks and assembles the call at content_block_stop", async () => {
    const t = sseFetch([
      f.start(),
      ...f.text(0, "Looking."),
      ...f.tool(1, "toolu_1", "search_docs", '{"que', 'ry":"x"}'),
      f.end("tool_use"),
      f.stop(),
    ]);
    const chunks = await collect(provider(t.fetch).stream(REQ));
    expect(chunks).toEqual([
      { delta: "Looking.", done: false },
      { delta: "", done: false, toolDelta: { id: "toolu_1", name: "search_docs", inputDelta: "" } },
      { delta: "", done: false, toolDelta: { id: "toolu_1", inputDelta: '{"que' } },
      { delta: "", done: false, toolDelta: { id: "toolu_1", inputDelta: 'ry":"x"}' } },
      {
        delta: "",
        done: true,
        stopReason: "tool_use",
        toolCalls: [{ id: "toolu_1", name: "search_docs", input: { query: "x" } }],
        usage: { inputTokens: 5, outputTokens: 7 },
      },
    ]);
    expect(allReleased(t)).toBe(true);
  });

  it("reads an empty argument object as {} and keeps malformed arguments instead of dropping the call", async () => {
    const t = sseFetch([
      f.start(),
      ...f.tool(0, "toolu_1", "list_documents"),
      ...f.tool(1, "toolu_2", "search_docs", '{"a"'),
      f.end("tool_use"),
      f.stop(),
    ]);
    const last = (await collect(provider(t.fetch).stream(REQ))).at(-1);
    expect(last?.toolCalls).toEqual([
      { id: "toolu_1", name: "list_documents", input: {} },
      { id: "toolu_2", name: "search_docs", input: { __unparsedArguments: '{"a"' } },
    ]);
  });

  it("maps stop reasons: max_tokens, and anything else that is not a tool call ends the turn", async () => {
    for (const [raw, mapped] of [
      ["max_tokens", "max_tokens"],
      ["stop_sequence", "end_turn"],
      ["pause_turn", "end_turn"],
    ] as const) {
      const t = sseFetch([f.start(), ...f.text(0, "x"), f.end(raw), f.stop()]);
      expect((await collect(provider(t.fetch).stream(REQ))).at(-1)?.stopReason).toBe(mapped);
    }
  });

  it("gives the same chunks however the bytes are split, including inside a UTF-8 character", async () => {
    const wire = [
      f.start(),
      ...f.text(0, "café ", "\u{1F600}"),
      ...f.tool(1, "toolu_1", "search_docs", '{"query":"é"}'),
      f.end("tool_use"),
      f.stop(),
    ].join("");
    const whole = await collect(provider(sseFetch([wire]).fetch).stream(REQ));
    const bytes = new TextEncoder().encode(wire);
    for (const n of [1, 3, 5]) {
      const parts: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += n) parts.push(bytes.slice(i, i + n));
      expect(await collect(provider(sseFetch(parts).fetch).stream(REQ))).toEqual(whole);
    }
  });

  it("ignores pings, unknown events and unknown block types", async () => {
    const t = sseFetch([
      f.start(),
      f.event("future_event", { x: 1 }),
      f.open(0, { type: "server_tool_use", id: "srv_1", name: "web" }),
      f.delta(0, { type: "input_json_delta", partial_json: "{}" }),
      f.close(0),
      ...f.text(1, "ok"),
      f.end("end_turn"),
      f.stop(),
    ]);
    const chunks = await collect(provider(t.fetch).stream(REQ));
    expect(chunks.map((c) => c.delta)).toEqual(["ok", ""]);
    expect(chunks.at(-1)?.toolCalls).toBeUndefined();
  });

  it("sends the mapped tools in the streaming body", async () => {
    const t = sseFetch([f.start(), ...f.text(0, "x"), f.end("end_turn"), f.stop()]);
    await collect(
      provider(t.fetch).stream({
        ...REQ,
        tools: [{ name: "search_docs", description: "d", inputSchema: { properties: {} } }],
      }),
    );
    expect(t.requests[0]?.tools).toEqual([
      { name: "search_docs", description: "d", input_schema: { type: "object", properties: {} } },
    ]);
  });
});

describe("stream(): HTTP status, abort and early stop", () => {
  it.each([429, 500, 529])(
    "maps HTTP %i before the first chunk and releases the body",
    async (status) => {
      const t = sseFetch(['{"error":1}'], "stall", status);
      const err = await collect(provider(t.fetch).stream(REQ)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmUnavailableError);
      expect((err as Error).message).toBe(`the language model is unavailable (HTTP ${status})`);
      expect(allReleased(t)).toBe(true);
    },
  );

  it("is LlmAbortedError when the caller's signal fires mid-stream, and releases the body", async () => {
    const t = sseFetch([f.start(), ...f.text(0, "partial")]);
    const ac = new AbortController();
    const run = async () => {
      for await (const _ of provider(t.fetch).stream({ ...REQ, signal: ac.signal })) ac.abort();
    };
    await expect(run()).rejects.toBeInstanceOf(LlmAbortedError);
    expect(allReleased(t)).toBe(true);
  });

  it("releases the body when the consumer stops early", async () => {
    const t = sseFetch([f.start(), ...f.text(0, "a", "b"), f.end("end_turn"), f.stop()]);
    for await (const c of provider(t.fetch).stream(REQ)) {
      expect(c.delta).toBe("a");
      break;
    }
    expect(allReleased(t)).toBe(true);
  });
});

describe("stream(): refusal", () => {
  const REFUSED = (extra: string[] = []) => [
    f.start(),
    ...f.text(0, "I can't help"),
    ...extra,
    f.end(
      "refusal",
      { output_tokens: 3 },
      { type: "refusal", category: "cyber", explanation: "why" },
    ),
    f.stop(),
  ];

  it("throws LlmRefusalError by default (ingest), with a fixed message, and releases the body", async () => {
    const t = sseFetch(REFUSED());
    const err = await collect(provider(t.fetch).stream(REQ)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRefusalError);
    expect(JSON.stringify([(err as Error).message, (err as Error).stack])).not.toContain("why");
    expect(allReleased(t)).toBe(true);
  });

  it("in report mode gives the observer the details, ends the turn, keeps the partial text and drops tool calls and blocks", async () => {
    const rec = recordingObserver();
    const t = sseFetch(
      REFUSED([...f.thinking(1, ["t"], "S"), ...f.tool(2, "toolu_1", "search_docs", "{}")]),
    );
    const chunks = await collect(
      provider(t.fetch, { thinking: true, refusal: "report", observer: () => rec.observer }).stream(
        REQ,
      ),
    );
    expect(rec.refusals).toEqual([{ category: "cyber", explanation: "why" }]);
    // thinking streamed before the refusal was known stays streamed; the terminal chunk carries none of it
    expect(chunks.some((c) => c.reasoningDelta === "t")).toBe(true);
    expect(chunks.filter((c) => c.delta !== "").map((c) => c.delta)).toEqual(["I can't help"]);
    expect(chunks.at(-1)).toEqual({
      delta: "",
      done: true,
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    expect(allReleased(t)).toBe(true);
  });
});

describe("stream(): errors, each releasing the body", () => {
  const failure = (t: ReturnType<typeof sseFetch>, over: object = {}, req: LlmRequest = REQ) =>
    collect(provider(t.fetch, over).stream(req)).catch((e: unknown) => e);

  it("maps an overloaded or api_error event to a retryable LlmStreamError with no event text", async () => {
    for (const kind of ["overloaded_error", "api_error", "rate_limit_error", "something_new"]) {
      const t = sseFetch([f.start(), ...f.text(0, "partial"), f.error(kind)]);
      const err = await failure(t);
      expect(err).toBeInstanceOf(LlmStreamError);
      expect(err).toBeInstanceOf(LlmUnavailableError);
      expect(JSON.stringify([(err as Error).message, (err as Error).stack])).not.toContain(
        "SECRET",
      );
      expect(allReleased(t)).toBe(true);
    }
  });

  it("maps an error event that blames the request to a permanent LlmRequestError", async () => {
    for (const kind of [
      "invalid_request_error",
      "authentication_error",
      "permission_error",
      "not_found_error",
      "request_too_large",
    ]) {
      const t = sseFetch([f.start(), f.error(kind)]);
      const err = await failure(t);
      expect(err).toBeInstanceOf(LlmRequestError);
      expect((err as Error).message).toBe("the language model rejected the request");
      expect(allReleased(t)).toBe(true);
    }
  });

  it("treats a stream that ends without message_stop as truncated (LlmStreamError)", async () => {
    const t = sseFetch([f.start(), ...f.text(0, "cut"), f.end("end_turn")], "close");
    expect(await failure(t)).toBeInstanceOf(LlmStreamError);
    expect(allReleased(t)).toBe(true);
  });

  it("maps a connection reset mid-stream to LlmStreamError", async () => {
    const t = sseFetch([f.start(), ...f.text(0, "cut")], "error");
    expect(await failure(t)).toBeInstanceOf(LlmStreamError);
    expect(allReleased(t)).toBe(true);
  });

  it("maps its own timeout mid-stream to LlmStreamError", async () => {
    const t = sseFetch([f.start(), ...f.text(0, "slow")], "stall");
    expect(await failure(t, { timeoutMs: 50 })).toBeInstanceOf(LlmStreamError);
    expect(allReleased(t)).toBe(true);
  });

  it("refuses a stream over maxStreamBytes, and an event that is not JSON, as LlmRequestError", async () => {
    const big = sseFetch([f.start(), ...f.text(0, "x".repeat(2_000)), f.end("end_turn"), f.stop()]);
    expect(await failure(big, { maxStreamBytes: 500 })).toBeInstanceOf(LlmRequestError);
    expect(allReleased(big)).toBe(true);
    const bad = sseFetch([f.start(), "event: content_block_delta\ndata: {not json\n\n"]);
    expect(await failure(bad)).toBeInstanceOf(LlmRequestError);
    expect(allReleased(bad)).toBe(true);
  });

  it("refuses a tool_use start without an id or name, as LlmRequestError", async () => {
    const t = sseFetch([f.start(), f.open(0, { type: "tool_use", name: "x" })]);
    expect(await failure(t)).toBeInstanceOf(LlmRequestError);
    expect(allReleased(t)).toBe(true);
  });

  it("keeps LlmStreamError's message fixed", () => {
    expect(new LlmStreamError().message).toBe("the language model is unavailable");
    expect(new LlmStreamError().name).toBe("LlmStreamError");
  });
});

describe("stream(): malformed block structure", () => {
  const failure = (parts: string[]) => {
    const t = sseFetch(parts);
    return collect(provider(t.fetch, { thinking: true }).stream(REQ)).then(
      () => ({ e: undefined as unknown, t }),
      (e: unknown) => ({ e, t }),
    );
  };

  it("refuses a block that was opened but never stopped, instead of dropping it", async () => {
    const r = await failure([
      f.start(),
      f.open(0, { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} }),
      f.end("tool_use"),
      f.stop(),
    ]);
    expect(r.e).toBeInstanceOf(LlmRequestError);
    expect(allReleased(r.t)).toBe(true);
  });

  it("refuses a second content_block_start for an open or already closed index", async () => {
    for (const again of [
      [f.open(0, { type: "text", text: "" }), f.open(0, { type: "text", text: "" })],
      [...f.text(0, "a"), f.open(0, { type: "text", text: "" })],
    ]) {
      const r = await failure([f.start(), ...again, f.end("end_turn"), f.stop()]);
      expect(r.e).toBeInstanceOf(LlmRequestError);
      expect(allReleased(r.t)).toBe(true);
    }
  });

  it("refuses a thinking block that ends without a signature", async () => {
    const r = await failure([
      f.start(),
      f.open(0, { type: "thinking", thinking: "" }),
      f.delta(0, { type: "thinking_delta", thinking: "x" }),
      f.close(0),
      f.end("end_turn"),
      f.stop(),
    ]);
    expect(r.e).toBeInstanceOf(LlmRequestError);
    expect(allReleased(r.t)).toBe(true);
  });

  it("emits blocks and tool calls in index order even when blocks stop out of order", async () => {
    const t = sseFetch([
      f.start(),
      f.open(0, { type: "thinking", thinking: "" }),
      f.delta(0, { type: "signature_delta", signature: "S" }),
      f.open(1, { type: "redacted_thinking", data: "ENC" }),
      f.open(2, { type: "tool_use", id: "toolu_1", name: "a", input: {} }),
      f.close(2),
      f.close(1),
      f.close(0),
      f.end("tool_use"),
      f.stop(),
    ]);
    const chunks = await collect(provider(t.fetch, { thinking: true }).stream(REQ));
    expect(chunks.at(-1)?.reasoning).toEqual([
      { kind: "text", text: "", signature: "S", provider: "anthropic" },
      { kind: "redacted", signature: "ENC", provider: "anthropic" },
    ]);
    expect(chunks.at(-1)?.layout).toBeUndefined();
    expect(chunks.at(-1)?.toolCalls).toEqual([{ id: "toolu_1", name: "a", input: {} }]);
  });
});
