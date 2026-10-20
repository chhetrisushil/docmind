import type { LlmContentPart, LlmReasoningPart, LlmRequest } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { LlmRequestError } from "./errors";
import { toMessagesBody } from "./request";

describe("toMessagesBody", () => {
  it("joins system text, keeps roles and maps text, image and pdf parts", () => {
    const req: LlmRequest = {
      system: "be brief",
      messages: [
        { role: "system", content: "and exact" },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", mediaType: "image/png", source: { kind: "data", data: "AAA=" } },
            { type: "file", mediaType: "application/pdf", source: { kind: "data", data: "JVBE" } },
          ],
        },
        { role: "assistant", content: "fine" },
      ],
      temperature: 0,
    };
    expect(toMessagesBody(req, "claude-haiku-5-5", 512)).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 512,
      system: "be brief\n\nand exact",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "JVBE" },
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "fine" }] },
      ],
    });
  });

  it("refuses a content reference, audio and a non-pdf file with a fixed LlmRequestError", () => {
    const bad: LlmRequest[] = [
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                mediaType: "image/png",
                source: { kind: "ref", ref: { address: "sha256:x" } },
              },
            ],
          },
        ],
      },
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "audio", mediaType: "audio/wav", source: { kind: "data", data: "AA==" } },
            ],
          },
        ],
      },
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "file", mediaType: "text/plain", source: { kind: "data", data: "AA==" } },
            ],
          },
        ],
      },
    ];
    for (const r of bad) {
      expect(() => toMessagesBody(r, "m", 1)).toThrow(/^the language model rejected the request$/);
    }
  });

  it("fences untrusted media with text blocks and drops the mark and the file name", () => {
    const req: LlmRequest = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              source: { kind: "data", data: "AAA=" },
              untrusted: { origin: "upload" },
            },
            {
              type: "file",
              mediaType: "application/pdf",
              name: "secret-name.pdf",
              source: { kind: "data", data: "JVBE" },
              untrusted: { origin: "upload" },
            },
          ],
        },
      ],
    };
    const content = toMessagesBody(req, "m", 1).messages[0]?.content ?? [];
    expect(content.map((b) => b.type)).toEqual([
      "text",
      "image",
      "text",
      "text",
      "document",
      "text",
    ]);
    const texts = content.flatMap((b) => (b.type === "text" ? [b.text] : []));
    expect(texts[0]).toMatch(/^<[^>]+origin="upload">$/);
    expect(texts[1]).toMatch(/^<\/[^>]+>$/);
    expect(JSON.stringify(content)).not.toContain("secret-name");
    expect(content.filter((b) => b.type === "image" || b.type === "document")).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBE" } },
    ]);
  });

  const LOOP: LlmRequest = {
    messages: [
      { role: "user", content: "find it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "tool_use", id: "toolu_1", name: "search_docs", input: { query: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "toolu_1", content: "passage text" },
          { type: "tool_result", toolUseId: "toolu_2", content: "bad id", isError: true },
        ],
      },
    ],
    tools: [
      {
        name: "search_docs",
        description: "Search the documents",
        inputSchema: { properties: { query: { type: "string" } }, required: ["query"] },
      },
    ],
  };

  it("maps tools to input_schema objects, tool_use to tool_use and tool_result to tool_result", () => {
    const body = toMessagesBody(LOOP, "m", 10);
    expect(body.tools).toEqual([
      {
        name: "search_docs",
        description: "Search the documents",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "search_docs", input: { query: "x" } }],
    });
    expect(body.messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "passage text" },
      { type: "tool_result", tool_use_id: "toolu_2", content: "bad id", is_error: true },
    ]);
  });

  it("maps a tool_result with parts, fencing untrusted media, and omits an empty tools list", () => {
    const body = toMessagesBody(
      {
        tools: [],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "toolu_1",
                content: [
                  { type: "text", text: "see" },
                  {
                    type: "image",
                    mediaType: "image/png",
                    source: { kind: "data", data: "AAA=" },
                    untrusted: { origin: "upload" },
                  },
                ],
              },
            ],
          },
        ],
      },
      "m",
      10,
    );
    expect("tools" in body).toBe(false);
    const result = body.messages[0]?.content[0];
    expect(result?.type).toBe("tool_result");
    const inner =
      result?.type === "tool_result" && Array.isArray(result.content) ? result.content : [];
    expect(inner.map((b) => b.type)).toEqual(["text", "text", "image", "text"]);
  });

  it("refuses a tool_use outside an assistant message and a tool_result outside a user message", () => {
    const bad: LlmRequest[] = [
      {
        messages: [
          { role: "user", content: [{ type: "tool_use", id: "a", name: "n", input: {} }] },
        ],
      },
      {
        messages: [
          { role: "assistant", content: [{ type: "tool_result", toolUseId: "a", content: "x" }] },
        ],
      },
    ];
    for (const r of bad) {
      expect(() => toMessagesBody(r, "m", 1)).toThrow(/^the language model rejected the request$/);
    }
  });
});

describe("toMessagesBody options", () => {
  const LOOP: LlmRequest = {
    system: "sys",
    temperature: 0.2,
    messages: [
      { role: "user", content: "find it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", id: "toolu_1", name: "search_docs", input: { query: "x" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_1", content: "r" }] },
    ],
  };

  it("sends adaptive summarized thinking and effort whenever it is set, and never a temperature", () => {
    const on = toMessagesBody(LOOP, "m", 10, { thinking: true, effort: "medium" });
    expect(on.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(on.output_config).toEqual({ effort: "medium" });
    expect("temperature" in on).toBe(false);
    const off = toMessagesBody(LOOP, "m", 10);
    expect("temperature" in off).toBe(false);
    expect("thinking" in off).toBe(false);
    expect("output_config" in off).toBe(false);
    expect(toMessagesBody(LOOP, "m", 10, { effort: "low" }).output_config).toEqual({
      effort: "low",
    });
  });

  it("sets the stream flag only when asked", () => {
    expect(toMessagesBody(LOOP, "m", 10, { stream: true }).stream).toBe(true);
    expect("stream" in toMessagesBody(LOOP, "m", 10)).toBe(false);
  });

  it("puts one cache breakpoint on the system block and one on the last block of the last message", () => {
    const body = toMessagesBody(LOOP, "m", 10, { cache: true });
    expect(body.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    const last = body.messages.at(-1)?.content.at(-1);
    expect(last).toMatchObject({ type: "tool_result", cache_control: { type: "ephemeral" } });
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(2);
  });

  it("sends no cache_control without the option, and no system breakpoint without a system", () => {
    expect(JSON.stringify(toMessagesBody(LOOP, "m", 10))).not.toContain("cache_control");
    const body = toMessagesBody({ messages: [{ role: "user", content: "hi" }] }, "m", 10, {
      cache: true,
    });
    expect("system" in body).toBe(false);
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(1);
  });

  it("drops an assistant message that has only empty text, so no empty content is sent", () => {
    const body = toMessagesBody(
      {
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "" },
          { role: "user", content: "b" },
        ],
      },
      "m",
      10,
    );
    expect(body.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(body.messages.every((m) => m.content.length > 0)).toBe(true);
  });

  it("sends no system block, cached or not, when the system text is empty", () => {
    const req: LlmRequest = { system: "", messages: [{ role: "user", content: "hi" }] };
    for (const cache of [true, false]) {
      expect("system" in toMessagesBody(req, "m", 10, { cache })).toBe(false);
    }
  });
});

describe("toMessagesBody: reasoning parts (ADR 0133 D5)", () => {
  const part = (over: Partial<LlmReasoningPart> = {}): LlmReasoningPart => ({
    type: "reasoning",
    kind: "summary",
    provider: "anthropic",
    signature: "SIG",
    text: "hm",
    ...over,
  });
  const loop = (assistant: LlmContentPart[]): LlmRequest => ({
    messages: [
      { role: "user", content: "find it" },
      { role: "assistant", content: assistant },
      { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_1", content: "r" }] },
    ],
  });
  const call = (id: string) => ({ type: "tool_use" as const, id, name: "search_docs", input: {} });
  const on = { thinking: true } as const;

  it("maps parts back to thinking and redacted_thinking blocks, unchanged and in the recorded order", () => {
    const body = toMessagesBody(
      loop([
        part({ text: "a", signature: "S1" }),
        { type: "text", text: "looking" },
        call("toolu_1"),
        part({ text: "b", signature: "S2" }),
        part({ kind: "redacted", signature: "ENC", text: undefined }),
        call("toolu_2"),
      ]),
      "m",
      10,
      on,
    );
    expect(body.messages[1]?.content).toEqual([
      { type: "thinking", thinking: "a", signature: "S1" },
      { type: "text", text: "looking" },
      { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
      { type: "thinking", thinking: "b", signature: "S2" },
      { type: "redacted_thinking", data: "ENC" },
      { type: "tool_use", id: "toolu_2", name: "search_docs", input: {} },
    ]);
  });

  it("sends an omitted-display part as an empty thinking block that keeps its signature", () => {
    const body = toMessagesBody(
      loop([part({ kind: "text", text: "", signature: "S0" }), call("toolu_1")]),
      "m",
      10,
      on,
    );
    expect(body.messages[1]?.content[0]).toEqual({
      type: "thinking",
      thinking: "",
      signature: "S0",
    });
  });

  it("omits another provider's part, and every reasoning part when thinking is off", () => {
    const parts = [part({ provider: "gemini" }), part(), call("toolu_1")];
    expect(
      toMessagesBody(loop(parts), "m", 10, on).messages[1]?.content.map((b) => b.type),
    ).toEqual(["thinking", "tool_use"]);
    expect(toMessagesBody(loop(parts), "m", 10).messages[1]?.content.map((b) => b.type)).toEqual([
      "tool_use",
    ]);
  });

  it("drops a part with no signature and every later reasoning part of that message, keeping text and calls", () => {
    const body = toMessagesBody(
      loop([
        part({ text: "ok", signature: "S1" }),
        part({ text: "unsigned", signature: undefined }),
        part({ text: "after", signature: "S3" }),
        { type: "text", text: "t" },
        call("toolu_1"),
      ]),
      "m",
      10,
      on,
    );
    expect(body.messages[1]?.content).toEqual([
      { type: "thinking", thinking: "ok", signature: "S1" },
      { type: "text", text: "t" },
      { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
    ]);
  });

  it("refuses a reasoning part outside an assistant message with a fixed LlmRequestError", () => {
    const bad: LlmRequest = { messages: [{ role: "user", content: [part()] }] };
    expect(() => toMessagesBody(bad, "m", 10, on)).toThrow(LlmRequestError);
  });

  it("never marks a thinking block as a cache breakpoint", () => {
    const last: LlmRequest = {
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "text", text: "x" }, part()] },
      ],
    };
    const body = toMessagesBody(last, "m", 10, { thinking: true, cache: true });
    expect(JSON.stringify(body.messages)).not.toContain("cache_control");
  });
});
