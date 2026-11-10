import type { UploadDocumentResponse } from "@docmind/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { visualizeExecutionId } from "../flows/visualize-document/start";
import { ingestExecutionId } from "./ingest";
import { type IngestStack, startIngestStack } from "./ingestStack";

const NIL = "00000000-0000-0000-0000-000000000000";

describe.skipIf(!PG_URL)(
  "a real upload records its execution ids, so the sweeps find it (needs DOCMIND_TEST_PG_URL)",
  () => {
    const stacks: IngestStack[] = [];
    afterEach(async () => {
      for (const s of stacks.splice(0)) await s.close();
    });

    async function uploadReady(st: IngestStack, email: string) {
      const { cookie, userId } = await st.signUpAndLogIn(email);
      const events = await st.events(cookie);
      try {
        const res = await st.upload(cookie, "report.txt", Buffer.from("Revenue was 1200 dollars."));
        expect(res.status).toBe(201);
        const id = ((await res.json()) as UploadDocumentResponse).document.id;
        const seen = await st.until(events, id, (s) => s === "ready" || s === "failed");
        expect(seen.at(-1)?.status).toBe("ready");
        return { id, userId };
      } finally {
        events.close();
      }
    }
    const columns = async (st: IngestStack, id: string) =>
      (
        await st.db.owner.query(
          "SELECT ingest_generation AS g, ingest_execution_id AS i, visualize_execution_id AS v FROM documents WHERE id = $1",
          [id],
        )
      ).rows[0] as { g: number; i: string | null; v: string | null };

    it("the ingest id is on the document, the stale-upload sweep does not list it, and a document with no visualize run is listed as ready", async () => {
      const st = await startIngestStack(); // visuals off: nothing visualizes, so the ready sweep has this document to find
      stacks.push(st);
      const { id, userId } = await uploadReady(st, "records-ingest@example.com");
      const row = await columns(st, id);
      expect(row.i).toBe(ingestExecutionId(userId, id, Number(row.g)));
      expect(row.v).toBeNull();
      const stale = await st.app.query(
        "SELECT id FROM docmind_stale_uploads_v2(make_interval(secs => 0), make_interval(secs => 604800), 500)",
      );
      expect(stale.rows.map((r) => r.id)).not.toContain(id); // it has a status row under the recorded id
      const ready = await st.app.query("SELECT id FROM docmind_ready_documents($1::uuid, 500)", [
        NIL,
      ]);
      expect(ready.rows.map((r) => r.id)).toContain(id);
    });

    it("with the visuals role on, the visualize id is recorded too", async () => {
      const st = await startIngestStack({ visuals: true });
      stacks.push(st);
      const { id, userId } = await uploadReady(st, "records-visuals@example.com");
      const g = Number((await columns(st, id)).g);
      await vi.waitFor(
        async () => expect((await columns(st, id)).v).toBe(visualizeExecutionId(userId, id, g)),
        {
          timeout: 30_000,
          interval: 50,
        },
      );
    });
  },
);
