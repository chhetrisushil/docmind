import { UNTRUSTED_CONTENT_SYSTEM_NOTE } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../../db/testSupport";
import {
  type DocumentHarness,
  GEMINI_TEST_KEY,
  getDoc,
  makePdf,
  scannedPdf,
  startDocumentServer,
  twoPagePdf,
  uploadAndAwaitTerminal,
} from "../../documents/testHarness";
import { STATUS_MESSAGES } from "../../status/model";
import { pngBytes } from "./imageFixtures";
import { MAP_SYSTEM, REDUCE_SYSTEM } from "./summarize/prompts";

const WAIT = 60_000;
const TLDR = "Reduce answer: sentinel summary";
const SCAN = "Bittern inspection certificate, second page";
const IMAGE_TEXT = "Text in the image sentinel";
const IMAGE_DESC = "A picture sentinel.";
const PROVIDER_MESSAGE = "sentinel-provider-message";
const TEXT = Array.from(
  { length: 9 },
  (_, i) => `Heron paragraph ${i}. ${"heron ledger entry ".repeat(22)}`,
).join("\n\n");
const PAGE_TEXT = "Tamarind chutney invoice. ".repeat(160);
// gemma fences its JSON (probe O4)
const fenced = (v: unknown) => `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
type Msg = { role: string; content: unknown };
/** The first message of a request, which must be DocMind's system prompt. */
const systemOf = (body: Record<string, unknown>): string => {
  const first = (body.messages as Msg[])[0];
  return first?.role === "system" ? String(first.content) : "";
};
// Routed on the system prompt, as the brief intended.
const answerFor = (body: Record<string, unknown>) => {
  const system = systemOf(body);
  if (system.startsWith(REDUCE_SYSTEM))
    return fenced({
      tldr: TLDR,
      keyPoints: ["k"],
      entities: [],
      topics: ["t"],
      suggestedQuestions: ["q?"],
    });
  if (system.startsWith(MAP_SYSTEM)) return fenced({ summary: "part", entities: [] });
  return fenced({ text: IMAGE_TEXT, description: IMAGE_DESC });
};
const scanReply = () => ({ text: JSON.stringify([{ page: 2, text: SCAN }]) });

/** Every event of every ingest execution, unsealed as the flow wrote it. */
const logOf = async (h: DocumentHarness) =>
  JSON.stringify(
    await Promise.all((await h.eventStore.listExecutions()).map((e) => h.eventStore.read(e))),
  );
/** The stored passages' text of a document, through the owner-scoped content route. */
const textsOf = async (h: DocumentHarness, user: string, id: string): Promise<string[]> => {
  const res = await fetch(`${h.base}/api/documents/${id}/content`, {
    headers: { "x-test-user": user },
  });
  return ((await res.json()) as { items: { text: string }[] }).items.map((i) => i.text);
};
const chatRequests = (h: DocumentHarness) =>
  (h.compat?.requests ?? []).filter((r) => r.path === "/v1/chat/completions");

describe.skipIf(!PG_URL)(
  "ingest on fake Ollama and fake Gemini (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: DocumentHarness;
    let compat: NonNullable<DocumentHarness["compat"]>;
    let gemini: NonNullable<DocumentHarness["gemini"]>;
    beforeAll(async () => {
      h = await startDocumentServer({ llm: "ollama" });
      compat = h.compat as NonNullable<DocumentHarness["compat"]>;
      gemini = h.gemini as NonNullable<DocumentHarness["gemini"]>;
      compat.reply((_n, body) => ({ kind: "text", text: answerFor(body) }));
      gemini.reply(scanReply);
    }, WAIT);
    afterAll(async () => {
      await h?.close();
    });

    it(
      "the summary runs on gemma: temperature 0, max_tokens 2048, fenced document text, no response_format, Gemini sees nothing",
      async () => {
        const id = await uploadAndAwaitTerminal(h, "alice", "a.txt", Buffer.from(TEXT), "ready");
        expect((await getDoc(h, "alice", id)).summary?.tldr).toBe(TLDR);
        const chats = chatRequests(h);
        expect(chats.length).toBeGreaterThanOrEqual(2); // a map and the reduce
        expect(chats.some((r) => systemOf(r.body).startsWith(MAP_SYSTEM))).toBe(true);
        expect(chats.some((r) => systemOf(r.body).startsWith(REDUCE_SYSTEM))).toBe(true);
        for (const r of chats) {
          expect(systemOf(r.body)).toContain(UNTRUSTED_CONTENT_SYSTEM_NOTE);
          expect(r.body).toMatchObject({ temperature: 0, max_tokens: 2048 });
          expect(r.body).not.toHaveProperty("response_format");
          const user = (r.body.messages as { role: string; content: unknown }[]).find(
            (m) => m.role === "user",
          );
          expect(JSON.stringify(user?.content)).toContain("<untrusted-input");
        }
        expect(gemini.requests).toHaveLength(0);
        // the keyless Ollama carries no Gemini key
        for (const r of compat.requests)
          expect(JSON.stringify([r.authorization, r.body])).not.toContain(GEMINI_TEST_KEY);
      },
      WAIT,
    );

    it(
      "an image is read on gemma as an image_url data URL into the two sections, and Gemini sees nothing",
      async () => {
        const before = compat.requests.length;
        const id = await uploadAndAwaitTerminal(h, "alice", "a.png", pngBytes(640, 480), "ready");
        const sent = compat.requests.slice(before);
        const vision = sent.filter((r) => JSON.stringify(r.body.messages).includes("image_url"));
        expect(vision.length).toBeGreaterThan(0);
        for (const r of vision) {
          expect(systemOf(r.body)).toMatch(/^You read documents/);
          expect(systemOf(r.body)).toContain(UNTRUSTED_CONTENT_SYSTEM_NOTE);
        }
        const parts = sent.flatMap((r) =>
          (r.body.messages as { content: unknown }[]).flatMap((m) =>
            Array.isArray(m.content)
              ? (m.content as { type: string; image_url?: { url: string } }[])
              : [],
          ),
        );
        expect(
          parts.some(
            (p) => p.type === "image_url" && p.image_url?.url.startsWith("data:image/png;base64,"),
          ),
        ).toBe(true);
        const { rows } = await h.owner.query<{ n: string }>(
          "SELECT count(*) AS n FROM chunks WHERE document_id = $1",
          [id],
        );
        expect(Number(rows[0]?.n)).toBe(2); // "Text in the image" and "Description"
        expect((await getDoc(h, "alice", id)).stats?.wordCount).toBeGreaterThan(0);
        expect(gemini.requests).toHaveLength(0);
      },
      WAIT,
    );

    it(
      "a scanned PDF page goes to Gemini with the key header and thinking off, and gemma sees no PDF",
      async () => {
        const before = compat.requests.length;
        const geminiBefore = gemini.requests.length;
        const id = await uploadAndAwaitTerminal(
          h,
          "alice",
          "b.pdf",
          twoPagePdf(PAGE_TEXT),
          "ready",
        );
        const g = gemini.requests[geminiBefore];
        expect(gemini.requests.length - geminiBefore).toBe(1);
        expect(g?.keyHeader).toBe(GEMINI_TEST_KEY);
        expect(JSON.stringify(g?.body)).toContain('"mimeType":"application/pdf"');
        expect(g?.body.generationConfig).toMatchObject({ thinkingConfig: { thinkingBudget: 0 } });
        // the untrusted-content instruction travels with the page (a pin bump must not drop it)
        const instruction = JSON.stringify(g?.body.systemInstruction);
        expect(instruction).toContain(UNTRUSTED_CONTENT_SYSTEM_NOTE);
        expect(instruction).toContain("You read documents for a private document library");
        expect(JSON.stringify(compat.requests.slice(before))).not.toContain("application/pdf");
        // the page read by Gemini is stored: the text page and the scanned page are two chunks
        const { rows } = await h.owner.query<{ n: string }>(
          "SELECT count(*) AS n FROM chunks WHERE document_id = $1",
          [id],
        );
        expect(Number(rows[0]?.n)).toBe(2);
        const texts = await textsOf(h, "alice", id);
        expect(texts.some((t) => t.includes("Tamarind chutney invoice"))).toBe(true);
        expect(texts.some((t) => t.includes(SCAN))).toBe(true); // page 2, as Gemini read it
      },
      WAIT,
    );

    it(
      "a 429 from Gemini is retried to success, and no log row, error text or console line carries the provider message or any content",
      async () => {
        const spies = (["error", "warn", "log"] as const).map((k) =>
          vi.spyOn(console, k).mockImplementation(() => {}),
        );
        try {
          const before = gemini.requests.length;
          let n = 0;
          gemini.reply(() => (n++ === 0 ? { status: 429 } : scanReply()));
          const id = await uploadAndAwaitTerminal(
            h,
            "alice",
            "c.pdf",
            twoPagePdf("Quince jelly invoice. ".repeat(160)),
            "ready",
          );
          expect(gemini.requests.length - before).toBe(2); // attempt 1 refused, attempt 2 served
          const doc = await getDoc(h, "alice", id);
          expect(doc.error).toBeNull();
          expect((await textsOf(h, "alice", id)).some((t) => t.includes(SCAN))).toBe(true);
          const log = await logOf(h); // this harness's log is unsealed: the sealing is proved by eventLog.pg.test
          const consoleLines = JSON.stringify(spies.flatMap((s) => s.mock.calls));
          for (const text of [PROVIDER_MESSAGE, GEMINI_TEST_KEY])
            for (const view of [log, JSON.stringify(doc), consoleLines])
              expect(view).not.toContain(text);
          for (const text of [SCAN, TLDR, IMAGE_TEXT, IMAGE_DESC])
            expect(consoleLines).not.toContain(text);
        } finally {
          for (const s of spies) s.mockRestore();
          gemini.reply(scanReply);
        }
      },
      WAIT,
    );

    it(
      "a persistent 429 from Gemini exhausts the retries and fails the document with a fixed reason; no provider message anywhere",
      async () => {
        const spies = (["error", "warn", "log"] as const).map((k) =>
          vi.spyOn(console, k).mockImplementation(() => {}),
        );
        try {
          gemini.reply(() => ({ status: 429 }));
          const id = await uploadAndAwaitTerminal(
            h,
            "alice",
            "d.pdf",
            twoPagePdf("Medlar paste invoice. ".repeat(160)),
            "failed",
          );
          const doc = await getDoc(h, "alice", id);
          expect(Object.values(STATUS_MESSAGES)).toContain(doc.error);
          const log = await logOf(h);
          const consoleLines = JSON.stringify(spies.flatMap((s) => s.mock.calls));
          for (const text of [PROVIDER_MESSAGE, GEMINI_TEST_KEY, "Medlar"])
            for (const view of [log, JSON.stringify(doc), consoleLines])
              expect(view).not.toContain(text);
        } finally {
          for (const s of spies) s.mockRestore();
          gemini.reply(scanReply);
        }
      },
      WAIT,
    );

    it(
      "an invalid Gemini key (HTTP 400 API_KEY_INVALID) fails a scanned-only PDF as a configuration error, not corrupt_content",
      async () => {
        try {
          gemini.reply(() => ({ status: 400, apiKeyInvalid: true }));
          const id = await uploadAndAwaitTerminal(h, "alice", "e.pdf", scannedPdf(), "failed");
          const doc = await getDoc(h, "alice", id);
          expect(doc.error).toBe(STATUS_MESSAGES.internal);
          expect(doc.error).not.toBe(STATUS_MESSAGES.corrupt_content);
        } finally {
          gemini.reply(scanReply);
        }
      },
      WAIT,
    );

    it(
      "an invalid Gemini key fails a mixed PDF too, rather than dropping its scanned pages; a plain 400 still drops them",
      async () => {
        try {
          gemini.reply(() => ({ status: 400, apiKeyInvalid: true }));
          const id = await uploadAndAwaitTerminal(
            h,
            "alice",
            "f.pdf",
            twoPagePdf("Loquat syrup invoice. ".repeat(160)),
            "failed",
          );
          expect((await getDoc(h, "alice", id)).error).toBe(STATUS_MESSAGES.internal);
          gemini.reply(() => ({ status: 400 }));
          const plain = await uploadAndAwaitTerminal(
            h,
            "alice",
            "g.pdf",
            twoPagePdf("Persimmon jam invoice. ".repeat(160)),
            "ready",
          );
          expect((await textsOf(h, "alice", plain)).some((t) => t.includes(SCAN))).toBe(false);
        } finally {
          gemini.reply(scanReply);
        }
      },
      WAIT,
    );
  },
);

describe.skipIf(!PG_URL)("PDF reading without a Gemini key (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer({ llm: "ollama", withoutGeminiKey: true });
    (h.compat as NonNullable<DocumentHarness["compat"]>).reply((_n, body) => ({
      kind: "text",
      text: answerFor(body),
    }));
  }, WAIT);
  afterAll(async () => {
    await h?.close();
  });

  it(
    "a textless-only PDF fails vision_unavailable; a PDF with text pages is ready with its text; nothing reached Gemini",
    async () => {
      const scan = await uploadAndAwaitTerminal(h, "alice", "scan.pdf", scannedPdf(), "failed");
      expect((await getDoc(h, "alice", scan)).error).toBe(STATUS_MESSAGES.vision_unavailable);
      const mixed = await uploadAndAwaitTerminal(
        h,
        "alice",
        "mixed.pdf",
        twoPagePdf(PAGE_TEXT),
        "ready",
      );
      const { rows } = await h.owner.query<{ n: string }>(
        "SELECT count(*) AS n FROM chunks WHERE document_id = $1",
        [mixed],
      );
      expect(Number(rows[0]?.n)).toBe(1); // the text page only
      const text = await uploadAndAwaitTerminal(
        h,
        "alice",
        "text.pdf",
        makePdf(Array.from({ length: 100 }, (_, i) => `Tamarind line ${i} of the ledger`)),
        "ready",
      );
      expect((await getDoc(h, "alice", text)).status).toBe("ready");
      expect(h.gemini?.requests).toHaveLength(0);
    },
    WAIT,
  );
});
