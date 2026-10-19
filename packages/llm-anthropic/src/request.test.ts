import type { LlmRequest } from "@loom/llm";
import { describe, expect, it } from "vitest";
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

  it("refuses a content reference, audio, tools and a non-pdf file with a fixed LlmRequestError", () => {
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
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "t", description: "d", inputSchema: {} }],
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
});
