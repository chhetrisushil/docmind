import { AnthropicMessagesProvider, LlmOutputError } from "@docmind/llm-anthropic";
import { type FakeAnthropic, startFakeAnthropic } from "@docmind/llm-anthropic/testing";
import { UNTRUSTED_CONTENT_SYSTEM_NOTE } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pngBytes } from "./imageFixtures";
import { VISION_PDF_MAX_BYTES, VisionReader } from "./vision";

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

  it("refuses an image whose base64 exceeds the API limit, without sending a request", async () => {
    const before = fake.requests.length;
    await expect(reader.readImage(new Uint8Array(3_932_161), "image/png")).rejects.toThrow(
      /^image exceeds the size limit$/,
    );
    expect(fake.requests.length).toBe(before);
  });
});

describe("VisionReader.readPdfPages", () => {
  const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 fake");

  it("sends the pdf once as an untrusted document part and keeps only the pages it asked for", async () => {
    fake.reply(() => ({
      text: '[{"page":2,"text":"scanned two"},{"page":9,"text":"not asked"},{"page":4,"text":""}]',
    }));
    const out = await reader.readPdfPages(PDF_BYTES, [2, 4]);
    expect([...out]).toEqual([
      [2, "scanned two"],
      [4, ""],
    ]);
    const body = fake.requests.at(-1)?.body as never as {
      messages: { content: { type: string }[] }[];
    };
    const content = body.messages[0]?.content ?? [];
    expect(content.filter((b) => b.type === "document")).toHaveLength(1);
    expect(JSON.stringify(content)).toContain("[2,4]");
    expect(JSON.stringify(content)).toContain("untrusted-input");
  });

  it("uses its own system prompt: a JSON array, no image description; readImage still asks for an object", async () => {
    const systemOf = () => (fake.requests.at(-1)?.body as never as { system: string }).system;
    fake.reply(() => ({ text: "[]" }));
    await reader.readPdfPages(PDF_BYTES, [1]);
    expect(systemOf()).toContain("one JSON array");
    expect(systemOf()).not.toMatch(/image|JSON object/);
    expect(systemOf()).toContain(UNTRUSTED_CONTENT_SYSTEM_NOTE);
    fake.reply(() => ({ text: '{"text":"a","description":"b"}' }));
    await reader.readImage(PNG_BYTES, "image/png");
    expect(systemOf()).toContain("one JSON object");
  });

  it("caps each page at 100,000 characters", async () => {
    fake.reply(() => ({ text: JSON.stringify([{ page: 1, text: "t".repeat(150_000) }]) }));
    expect((await reader.readPdfPages(PDF_BYTES, [1])).get(1)?.length).toBe(100_000);
  });

  it("refuses a pdf over the raw size limit, without sending a request", async () => {
    const before = fake.requests.length;
    await expect(
      reader.readPdfPages(new Uint8Array(VISION_PDF_MAX_BYTES + 1), [1]),
    ).rejects.toThrow(/^pdf exceeds the size limit$/);
    expect(fake.requests.length).toBe(before);
  });
});
