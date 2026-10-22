import { AnthropicMessagesProvider, LlmOutputError } from "@docmind/llm-anthropic";
import { type FakeAnthropic, startFakeAnthropic } from "@docmind/llm-anthropic/testing";
import { type LlmProvider, UNTRUSTED_CONTENT_SYSTEM_NOTE } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermanentIngestError } from "./errors";
import { pngBytes } from "./imageFixtures";
import { VISION_PDF_MAX_BYTES, VisionReader } from "./vision";

let fake: FakeAnthropic;
let reader: VisionReader;
beforeAll(async () => {
  fake = await startFakeAnthropic();
  const provider = new AnthropicMessagesProvider({
    apiKey: "test-key-not-real",
    model: "claude-sonnet-5-5",
    maxTokens: 1024,
    timeoutMs: 5_000,
    baseUrl: fake.url,
  });
  reader = new VisionReader({ image: provider, pdf: provider });
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

describe("VisionReader: an answer truncated by max_tokens", () => {
  it("is a permanent too_large for an image, even when the cut-off text is valid JSON", async () => {
    fake.reply(() => ({ text: '{"text":"a","description":"b"}', stopReason: "max_tokens" }));
    await expect(reader.readImage(PNG_BYTES, "image/png")).rejects.toMatchObject({
      name: "PermanentIngestError",
      code: "too_large",
    });
    await expect(reader.readImage(PNG_BYTES, "image/png")).rejects.toBeInstanceOf(
      PermanentIngestError,
    );
  });

  it("is a permanent too_large for pdf pages, before the JSON is parsed", async () => {
    fake.reply(() => ({ text: '[{"page":1,"text":"cut o', stopReason: "max_tokens" }));
    const pdf = new TextEncoder().encode("%PDF-1.4 fake");
    await expect(reader.readPdfPages(pdf, [1])).rejects.toBeInstanceOf(PermanentIngestError);
  });
});

describe("VisionReader: an empty answer that ended the turn", () => {
  it("is a permanent unsupported_content for pdf pages (a blocked transcription is blocked again)", async () => {
    fake.reply(() => ({ text: "" }));
    const pdf = new TextEncoder().encode("%PDF-1.4 fake");
    await expect(reader.readPdfPages(pdf, [1])).rejects.toMatchObject({
      name: "PermanentIngestError",
      code: "unsupported_content",
    });
  });
});

describe("VisionReader capabilities", () => {
  const fakeProvider = () => {
    const seen: unknown[] = [];
    const provider = {
      name: "fake",
      capabilities: {},
      complete: async (req: unknown) => {
        seen.push(req);
        return { content: '{"text":"t","description":"d"}', stopReason: "end_turn", usage: {} };
      },
    } as unknown as LlmProvider;
    return { provider, seen };
  };

  it("reports what its providers can read", () => {
    const { provider } = fakeProvider();
    const r = new VisionReader({ image: provider });
    expect(r.canReadImages).toBe(true);
    expect(r.canReadPdf).toBe(false);
    expect(r.pdfMaxBytes).toBe(VISION_PDF_MAX_BYTES);
    const p = new VisionReader({ pdf: provider, pdfMaxBytes: 14 * 1024 * 1024 });
    expect(p.canReadImages).toBe(false);
    expect(p.canReadPdf).toBe(true);
    expect(p.pdfMaxBytes).toBe(14 * 1024 * 1024);
  });

  it("fails as vision_unavailable without the matching provider", async () => {
    const { provider } = fakeProvider();
    await expect(
      new VisionReader({ image: provider }).readPdfPages(new Uint8Array([1]), [1]),
    ).rejects.toMatchObject({ code: "vision_unavailable" });
    await expect(
      new VisionReader({ pdf: provider }).readImage(PNG_BYTES, "image/png"),
    ).rejects.toMatchObject({ code: "vision_unavailable" });
  });

  it("sends pdf pages to the pdf provider and images to the image provider", async () => {
    const img = fakeProvider();
    const pdf = { ...fakeProvider() };
    pdf.provider.complete = async (req: unknown) => {
      pdf.seen.push(req);
      return { content: '[{"page":1,"text":"x"}]', stopReason: "end_turn", usage: {} } as never;
    };
    const r = new VisionReader({ image: img.provider, pdf: pdf.provider });
    await r.readPdfPages(new Uint8Array([37, 80, 68, 70]), [1]);
    expect(pdf.seen).toHaveLength(1);
    expect(img.seen).toHaveLength(0);
    await r.readImage(PNG_BYTES, "image/png");
    expect(img.seen).toHaveLength(1);
    expect(pdf.seen).toHaveLength(1);
  });

  it("refuses a pdf provider with no positive cap", () => {
    const { provider } = fakeProvider();
    for (const cap of [0, -1, Number.NaN])
      expect(() => new VisionReader({ pdf: provider, pdfMaxBytes: cap })).toThrow(/pdfMaxBytes/);
  });

  it("applies its own pdf cap", async () => {
    const { provider, seen } = fakeProvider();
    const r = new VisionReader({ pdf: provider, pdfMaxBytes: 4 });
    await expect(r.readPdfPages(new Uint8Array(5), [1])).rejects.toThrow(
      /^pdf exceeds the size limit$/,
    );
    expect(seen).toHaveLength(0);
  });
});
