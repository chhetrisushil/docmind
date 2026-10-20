import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { docxBytes } from "../flows/ingest-document/docxFixture";
import { jpegBytes, pngBytes } from "../flows/ingest-document/imageFixtures";
import { STATUS_MESSAGES } from "../status/model";
import {
  type DocumentHarness,
  getDoc,
  makePdf,
  startDocumentServer,
  twoPagePdf,
  uploadAndAwaitTerminal,
} from "./testHarness";

const WAIT = 60_000;
const TLDR = "Reduce answer: the Wombat reorganisation is complete";
const SCAN_TEXT = "Bittern inspection certificate, second page";
const ENTITY = "Acme Widgets Ltd";
/** Several paragraphs of `word`-flavoured text, long enough for more than one chunk. */
const longText = (word: string, extra = "") =>
  Array.from(
    { length: 9 },
    (_, i) => `${word} paragraph ${i}. ${extra} ${`${word} ledger entry `.repeat(22)}`,
  ).join("\n\n");
const PAGE_TEXT = "Tamarind chutney invoice. ".repeat(160);
const fixture = (name: string) =>
  readFileSync(join(__dirname, "../../../../packages/parsers/test-fixtures", name));

const count = async (h: DocumentHarness, sql: string, id: string) =>
  Number(((await h.owner.query(sql, [id])).rows[0] as { n: string }).n);
const chunksOf = (h: DocumentHarness, id: string) =>
  count(h, "SELECT count(*) AS n FROM chunks WHERE document_id = $1", id);
const linksOf = (h: DocumentHarness, id: string) =>
  count(
    h,
    "SELECT count(*) AS n FROM chunk_links l JOIN chunks c ON c.id = l.src_chunk_id WHERE c.document_id = $1",
    id,
  );

describe.skipIf(!PG_URL)("every accepted format reaches ready (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer({ llm: true });
    h.fake.reply((body) => {
      const system = String((body as { system?: unknown }).system ?? "");
      const user = JSON.stringify(body.messages);
      if (system.includes("one JSON array"))
        return { text: JSON.stringify([{ page: 2, text: SCAN_TEXT }]) };
      if (system.startsWith("You combine"))
        return {
          text: JSON.stringify({
            tldr: TLDR,
            keyPoints: ["k"],
            entities: [],
            topics: ["t"],
            suggestedQuestions: ["q?"],
          }),
        };
      if (system.startsWith("You summarize one part"))
        return {
          text: JSON.stringify({
            summary: "part",
            entities: user.includes(ENTITY) ? [{ name: ENTITY, kind: "organization" }] : [],
          }),
        };
      return { text: JSON.stringify({ text: longText("Cormorant"), description: "A manifest." }) };
    });
  }, WAIT);
  afterAll(async () => {
    await h?.close();
  });

  // One chunk per section has nothing structural to link to (and no neighbour is near enough).
  const NO_LINKS = new Set(["doc", "pdf with a textless page"]);
  const cases: [string, string, () => Uint8Array][] = [
    ["txt", "a.txt", () => Buffer.from(longText("Plain"))],
    ["md", "a.md", () => Buffer.from(`# Heading\n\n${longText("Marmalade")}`)],
    ["org", "a.org", () => Buffer.from(`* Heading\n\n${longText("Orgmode")}`)],
    ["docx", "a.docx", () => docxBytes(longText("Heliotrope").split("\n\n"))],
    ["doc", "a.doc", () => fixture("word-extractor-test11.doc")],
    [
      "pdf with text",
      "a.pdf",
      () =>
        makePdf(
          Array.from({ length: 100 }, (_, i) => `Tamarind line ${i} of the chutney invoice ledger`),
        ),
    ],
    ["pdf with a textless page", "b.pdf", () => twoPagePdf(PAGE_TEXT)],
    ["png", "a.png", () => pngBytes(640, 480)],
    ["jpeg", "a.jpg", () => jpegBytes(640, 480)],
  ];
  it.each(cases)(
    "%s: ready with stats, a summary, chunks and links",
    async (name, file, bytes) => {
      const id = await uploadAndAwaitTerminal(h, "alice", file, bytes(), "ready");
      const doc = await getDoc(h, "alice", id);
      expect(doc.stats?.wordCount).toBeGreaterThan(0);
      expect(doc.summary?.tldr).toBe(TLDR);
      const chunks = await chunksOf(h, id);
      expect(chunks).toBeGreaterThanOrEqual(1);
      // the text page is one chunk and the page vision read is one more
      if (name === "pdf with a textless page") expect(chunks).toBe(2);
      if (!NO_LINKS.has(name)) expect(await linksOf(h, id)).toBeGreaterThanOrEqual(1);
    },
    WAIT,
  );

  it(
    "two documents that name the same entity are linked by an entity link between their chunks",
    async () => {
      const a = await uploadAndAwaitTerminal(
        h,
        "alice",
        "e1.md",
        Buffer.from(longText("Quokka", ENTITY)),
        "ready",
      );
      const b = await uploadAndAwaitTerminal(
        h,
        "alice",
        "e2.md",
        Buffer.from(longText("Numbat", ENTITY)),
        "ready",
      );
      const { rows } = await h.owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM chunk_links l
           JOIN chunks s ON s.id = l.src_chunk_id JOIN chunks d ON d.id = l.dst_chunk_id
          WHERE l.kind = 'entity' AND s.document_id = $1 AND d.document_id = $2`,
        [a, b],
      );
      expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(1);
    },
    WAIT,
  );
});

describe.skipIf(!PG_URL)("without an Anthropic key (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  }, WAIT);
  afterAll(async () => {
    await h?.close();
  });

  it(
    "a png fails with the vision_unavailable message, and a txt is ready without a summary",
    async () => {
      const png = await uploadAndAwaitTerminal(h, "alice", "a.png", pngBytes(640, 480), "failed");
      expect((await getDoc(h, "alice", png)).error).toBe(STATUS_MESSAGES.vision_unavailable);
      const txt = await uploadAndAwaitTerminal(h, "alice", "a.txt", longText("Plain"), "ready");
      expect((await getDoc(h, "alice", txt)).summary).toBeNull();
      expect(h.fake.requests).toHaveLength(0);
    },
    WAIT,
  );
});
