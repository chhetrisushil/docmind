import type { LlmRequest } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { LlmRequestError } from "./errors";
import { type ReasoningBlock, coversToolUses } from "./observer";
import { toMessagesBody, toolUseGroups } from "./request";

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
      temperature: 0,
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
  const THINKING = { type: "thinking", thinking: "hm", signature: "SIG" } as const;

  it("sends adaptive summarized thinking without temperature, and effort whenever it is set", () => {
    const on = toMessagesBody(LOOP, "m", 10, { thinking: true, effort: "medium" });
    expect(on.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(on.output_config).toEqual({ effort: "medium" });
    expect("temperature" in on).toBe(false);
    const off = toMessagesBody(LOOP, "m", 10);
    expect(off.temperature).toBe(0.2);
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

  it("replaces the assistant message's content with the stored blocks, verbatim and in stored order", () => {
    const redacted = { type: "redacted_thinking", data: "ENC" } as const;
    const stored = [
      THINKING,
      { type: "text", text: "looking" },
      { type: "tool_use", id: "toolu_1", name: "search_docs", input: { query: "x" } },
      redacted,
    ];
    const body = toMessagesBody(LOOP, "m", 10, {
      thinking: true,
      reasoning: new Map([[1, stored]]),
    });
    expect(body.messages[1]?.content.map((b) => b.type)).toEqual([
      "thinking",
      "text",
      "tool_use",
      "redacted_thinking",
    ]);
    expect(body.messages[1]?.content).toEqual(stored);
  });

  it("round-trips an interleaved thinking, tool_use, thinking, tool_use response in order", () => {
    const second = { type: "thinking", thinking: "again", signature: "SIG2" } as const;
    const stored = [
      THINKING,
      { type: "tool_use", id: "toolu_1", name: "search_docs", input: { query: "x" } },
      second,
      { type: "tool_use", id: "toolu_2", name: "related", input: { passageId: "p" } },
    ];
    const two: LlmRequest = {
      messages: [
        { role: "user", content: "find it" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "search_docs", input: { query: "x" } },
            { type: "tool_use", id: "toolu_2", name: "related", input: { passageId: "p" } },
          ],
        },
      ],
    };
    const body = toMessagesBody(two, "m", 10, {
      thinking: true,
      reasoning: new Map([[1, stored]]),
    });
    expect(body.messages[1]?.content).toEqual(stored);
    expect(coversToolUses(["toolu_1", "toolu_2"], stored)).toBe(true);
    expect(coversToolUses(["toolu_1", "toolu_3"], stored)).toBe(false);
    expect(coversToolUses(["toolu_1"], [])).toBe(false);
  });

  it("never marks a thinking block as a cache breakpoint, and refuses an entry that is not a content block", () => {
    const body = toMessagesBody(
      {
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "" },
        ],
      },
      "m",
      10,
      { cache: true, reasoning: new Map([[1, [THINKING]]]) },
    );
    expect(body.messages[1]?.content).toEqual([THINKING]);
    const bogus = [{ thinking: "no type" }] as unknown as readonly ReasoningBlock[];
    expect(() => toMessagesBody(LOOP, "m", 10, { reasoning: new Map([[1, bogus]]) })).toThrow(
      LlmRequestError,
    );
  });

  it("lists the tool_use ids of each assistant message by its index in request.messages", () => {
    expect(toolUseGroups(LOOP)).toEqual([{ index: 1, ids: ["toolu_1"] }]);
    expect(toolUseGroups({ messages: [{ role: "assistant", content: "plain" }] })).toEqual([]);
  });
});
