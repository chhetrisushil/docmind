import { LlmRequestError } from "@docmind/llm-anthropic";
import type { LlmProvider, LlmRequest, LlmStreamChunk } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { DOC_ASSISTANT_PROMPT } from "../chats/agent";
import { VisionReader } from "../flows/ingest-document/vision";
import { createRoleProvider } from "./factory";
import { type LlmRole, loadLlmRoles } from "./roles";
import { PROBE_TOKEN, probePdf, probePng } from "./testing/realFixtures";

// Opt-in: DOCMIND_REAL_OLLAMA=1 runs these against a real Ollama (DOCMIND_OLLAMA_URL, default
// http://127.0.0.1:11434; DOCMIND_REAL_OLLAMA_MODEL, default gemma4:31b-cloud). Never part of the gate.
// Prompts and answers are never printed: assertion messages carry counts and booleans only.
const MODEL = process.env.DOCMIND_REAL_OLLAMA_MODEL?.trim() || "gemma4:31b-cloud";
const env: NodeJS.ProcessEnv = {
  DOCMIND_LLM_PROVIDER: "ollama",
  ...(process.env.DOCMIND_OLLAMA_URL && { DOCMIND_OLLAMA_URL: process.env.DOCMIND_OLLAMA_URL }),
  DOCMIND_CHAT_MODEL: MODEL,
  DOCMIND_TITLE_MODEL: MODEL,
  DOCMIND_SUMMARY_MODEL: MODEL,
  DOCMIND_VISION_MODEL: MODEL,
};
const SECOND = 1000;

function provider(role: LlmRole, withChat = false): LlmProvider {
  // Loaded here, not at module scope: collection must not depend on the opt-in environment.
  const p = createRoleProvider(role, loadLlmRoles(env), env, {
    maxTokens: 4000,
    timeoutMs: 150 * SECOND,
    ...(withChat && { chat: { effort: "medium" as const, observer: () => undefined } }),
  });
  if (!p) throw new Error("role is off");
  return p;
}

const user = (content: LlmRequest["messages"][number]["content"]) =>
  ({ role: "user", content }) as const;

describe.skipIf(process.env.DOCMIND_REAL_OLLAMA !== "1")("real Ollama", () => {
  it("title role answers a short plain text", { timeout: 180 * SECOND }, async () => {
    const res = await provider("title").complete({
      system: "Reply with a title of at most six words. Plain text only.",
      messages: [user("A note about planning a small garden for the spring.")],
      temperature: 0,
    });
    expect({ end: res.stopReason, nonEmpty: res.content.trim().length > 0 }).toEqual({
      end: "end_turn",
      nonEmpty: true,
    });
    expect(res.content.trim().length).toBeLessThan(200);
  });

  it(
    "chat role streams, ends end_turn and reasons at effort medium",
    { timeout: 180 * SECOND },
    async () => {
      const chat = provider("chat", true);
      if (!chat.stream) throw new Error("no stream");
      let text = 0;
      let reasoning = 0;
      let last: LlmStreamChunk | undefined;
      for await (const c of chat.stream({
        messages: [user("What is 17 times 23? Think it through, then answer with the number.")],
      })) {
        text += c.delta.length;
        reasoning += c.reasoningDelta?.length ?? 0;
        if (c.done) last = c;
      }
      expect({ stop: last?.stopReason, text: text > 0, reasoning: reasoning > 0 }).toEqual({
        stop: "end_turn",
        text: true,
        reasoning: true,
      });
    },
  );

  it("a two-tool request ends tool_use with two calls", { timeout: 180 * SECOND }, async () => {
    const schema = (key: string) => ({
      type: "object",
      properties: { [key]: { type: "string" } },
      required: [key],
    });
    const res = await provider("chat", true).complete({
      system: "You must call both tools, in the same turn, before answering.",
      messages: [user("Look up the weather in Oslo and the time in Lima. Use both tools now.")],
      tools: [
        { name: "get_weather", description: "Weather for a city.", inputSchema: schema("city") },
        { name: "get_time", description: "Local time for a city.", inputSchema: schema("city") },
      ],
    });
    expect({ stop: res.stopReason, calls: res.toolCalls?.length ?? 0 }).toEqual({
      stop: "tool_use",
      calls: 2,
    });
  });

  it(
    "the doc assistant prompt cites both passages in at least 5 of 6 runs",
    { timeout: 1000 * SECOND },
    async () => {
      const A = "11111111-1111-4111-8111-111111111111";
      const B = "22222222-2222-4222-8222-222222222222";
      const passages = [
        {
          passageId: A,
          document: "Doc one",
          locator: "p1",
          headingPath: [],
          text: "The lighthouse was built in 1887 on the north cape.",
        },
        {
          passageId: B,
          document: "Doc two",
          locator: "p1",
          headingPath: [],
          text: "The ferry to the cape runs every morning at nine.",
        },
      ];
      let cited = 0;
      const runs = 6;
      for (let i = 0; i < runs; i++) {
        const res = await provider("chat", true).complete({
          system: DOC_ASSISTANT_PROMPT,
          messages: [
            user("When was the lighthouse built, and when does the ferry to the cape run?"),
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "call_1",
                  name: "search_docs",
                  input: { query: "lighthouse ferry cape" },
                },
              ],
            },
            user([
              { type: "tool_result", toolUseId: "call_1", content: JSON.stringify({ passages }) },
            ]),
          ],
        });
        if (res.content.includes(`[[${A}]]`) && res.content.includes(`[[${B}]]`)) cited++;
      }
      expect({ cited, runs, enough: cited >= 5 }).toEqual({ cited, runs, enough: true });
    },
  );

  it(
    "the image role reads the probe text through VisionReader",
    { timeout: 180 * SECOND },
    async () => {
      const reader = new VisionReader({ image: provider("vision") });
      const out = await reader.readImage(probePng(), "image/png");
      expect(out.text.includes(PROBE_TOKEN)).toBe(true);
    },
  );

  it(
    "a PDF file part is refused with LlmRequestError before any request",
    { timeout: 60 * SECOND },
    async () => {
      const reader = new VisionReader({ pdf: provider("vision"), pdfMaxBytes: 1024 * 1024 });
      const err = await reader.readPdfPages(probePdf(), [1]).then(
        () => undefined,
        (e: unknown) => e,
      );
      // The Ollama provider declares no `file` capability, so the request is refused before the network
      // (UnsupportedModalityError, mapped to LlmRequestError with no HTTP status): that is the boundary.
      expect({
        typed: err instanceof LlmRequestError,
        status: (err as LlmRequestError)?.status,
      }).toEqual({
        typed: true,
        status: undefined,
      });
    },
  );
});
