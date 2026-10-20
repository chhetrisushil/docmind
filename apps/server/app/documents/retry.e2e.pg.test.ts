import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import {
  type DocumentHarness,
  awaitTerminal,
  getDoc,
  startDocumentServer,
  uploadAndAwaitTerminal,
} from "./testHarness";

const WAIT = 60_000;
const MD = `# Notes\n\n${Array.from({ length: 9 }, (_, i) => `Paragraph ${i}. ${"Kestrel programme ledger ".repeat(22)}`).join("\n\n")}`;
const TLDR = "Reduce answer: the programme is on track";

describe.skipIf(!PG_URL)("retry and delete end to end (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer({ llm: true });
    h.fake.reply((body) => {
      const system = String((body as { system?: unknown }).system ?? "");
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
      return { text: JSON.stringify({ summary: "part", entities: [] }) };
    });
  }, WAIT);
  afterAll(async () => {
    await h?.close();
  });

  const send = (method: string, user: string, path: string) =>
    fetch(`${h.base}/api/documents/${path}`, { method, headers: { "x-test-user": user } });
  const chunkIds = async (id: string) =>
    (
      await h.owner.query<{ id: string }>(
        "SELECT id FROM chunks WHERE document_id = $1 ORDER BY ordinal",
        [id],
      )
    ).rows.map((r) => r.id);
  const chunkFingerprint = async (id: string) =>
    (
      await h.owner.query(
        "SELECT id, created_at, embedding_model FROM chunks WHERE document_id = $1 ORDER BY ordinal",
        [id],
      )
    ).rows;

  it(
    "a document that failed at summarize resumes there on retry: no re-parse, no re-chunk, no re-embed",
    async () => {
      h.fake.failNext(401, 1); // LlmRequestError: fatal, so the document fails at summarize (internal)
      const id = await uploadAndAwaitTerminal(h, "alice", "a.md", MD, "failed");
      expect((await getDoc(h, "alice", id)).summary).toBeNull();
      const before = await chunkFingerprint(id);
      expect(before.length).toBeGreaterThan(1);
      const embedCalls = h.embedCalls();
      const parseRuns = h.parseRuns();
      expect((await send("POST", "alice", `${id}/retry`)).status).toBe(202);
      await awaitTerminal(h, "alice", id, "ready");
      expect(await chunkFingerprint(id)).toEqual(before);
      expect(h.embedCalls()).toBe(embedCalls);
      expect(h.parseRuns()).toBe(parseRuns);
      expect((await getDoc(h, "alice", id)).summary?.tldr).toBe(TLDR);
    },
    WAIT,
  );

  it(
    "a delete while summarize waits on Claude ends the flow cancelled and leaves nothing behind",
    async () => {
      const gate = h.fake.holdNext(); // the next request hangs until released
      const res = await h.upload("alice", "b.md", MD.replace("Kestrel", "Osprey"));
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { document: { id: string } }).document.id;
      await gate.reached; // chunk and embed are done; summarize is waiting on Claude
      const chunks = await chunkIds(id);
      expect(chunks.length).toBeGreaterThan(1);
      try {
        expect((await send("DELETE", "alice", id)).status).toBe(204);
      } finally {
        gate.release();
      }
      await h.starts.idle();
      const handle = h.ingest.handles.get(id);
      await expect(handle?.waitForCompletion()).rejects.toThrow(/cancel/i);
      const left = async (sql: string, args: unknown[]) =>
        Number(((await h.owner.query(sql, args)).rows[0] as { n: string }).n);
      expect(await left("SELECT count(*) AS n FROM documents WHERE id = $1", [id])).toBe(0);
      for (const sql of [
        "SELECT count(*) AS n FROM chunks WHERE id = ANY($1)",
        "SELECT count(*) AS n FROM chunk_links WHERE src_chunk_id = ANY($1) OR dst_chunk_id = ANY($1)",
        "SELECT count(*) AS n FROM chunk_entities WHERE chunk_id = ANY($1)",
      ])
        expect(await left(sql, [chunks])).toBe(0);
      expect(
        await left("SELECT count(*) AS n FROM parsed_documents WHERE document_id = $1", [id]),
      ).toBe(0);
    },
    WAIT,
  );
});
