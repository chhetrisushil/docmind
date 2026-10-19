import { AnthropicMessagesProvider, LlmOutputError } from "@docmind/llm-anthropic";
import { type FakeAnthropic, startFakeAnthropic } from "@docmind/llm-anthropic/testing";
import { UNTRUSTED_CONTENT_SYSTEM_NOTE } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pngBytes } from "./imageFixtures";
import { VisionReader } from "./vision";

let fake: FakeAnthropic;
let reader: VisionReader;
beforeAll(async () => {
  fake = await startFakeAnthropic();
  reader = new VisionReader(
    new AnthropicMessagesProvider({
      apiKey: "test-key-not-real",
      model: "claude-sonnet-5-5",
      maxTokens: 1024,
      timeoutMs: 5_000,
      baseUrl: fake.url,
    }),
  );
});
afterAll(async () => {
  await fake?.close();
});
const PNG_BYTES = pngBytes(640, 480);

describe("VisionReader.readImage", () => {
  it("sends the image as an untrusted, fenced part with the note in the system prompt, and parses the JSON answer", async () => {
    fake.reply(() => ({ text: '{"text":"INVOICE 42","description":"A scanned invoice."}' }));
    const out = await reader.readImage(PNG_BYTES, "image/png");
    expect(out).toEqual({ text: "INVOICE 42", description: "A scanned invoice." });
    const body = fake.requests.at(-1)?.body as never as {
      system: string;
      messages: { content: { type: string }[] }[];
    };
    expect(body.system).toContain(UNTRUSTED_CONTENT_SYSTEM_NOTE);
    const kinds = body.messages[0]?.content.map((b) => b.type);
    expect(kinds).toContain("image");
    expect(JSON.stringify(body.messages[0]?.content)).toContain("untrusted-input");
  });

  it("accepts a fenced ```json answer and refuses a wrong shape with LlmOutputError", async () => {
    fake.reply(() => ({ text: '```json\n{"text":"a","description":"b"}\n```' }));
    expect(await reader.readImage(PNG_BYTES, "image/png")).toEqual({ text: "a", description: "b" });
    fake.reply(() => ({ text: '{"words":"a"}' }));
    await expect(reader.readImage(PNG_BYTES, "image/png")).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("caps what it keeps: text at 200,000 and description at 20,000 characters", async () => {
    fake.reply(() => ({
      text: JSON.stringify({ text: "t".repeat(250_000), description: "d".repeat(30_000) }),
    }));
    const out = await reader.readImage(PNG_BYTES, "image/png");
    expect([out.text.length, out.description.length]).toEqual([200_000, 20_000]);
  });
});
