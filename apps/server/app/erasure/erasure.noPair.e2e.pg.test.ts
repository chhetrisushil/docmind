import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { scriptChat } from "../chats/e2eSupport";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { PgDocumentResults } from "../flows/ingest-document/pgResults";
import {
  assertErased,
  controlRows,
  eraseMe,
  eventColumnProblems,
  seedUser,
  waitErased,
} from "./e2eSupport";
import type { ErasureDeps } from "./eraser";

const WAIT = 300_000;
const SUMMARY = {
  tldr: "Quarterly summary",
  keyPoints: ["Revenue grew"],
  entities: [],
  topics: ["finance"],
  suggestedQuestions: [],
};

describe.skipIf(!PG_URL)(
  "erasure records no subject id on Loom's control stream (needs DOCMIND_TEST_PG_URL)",
  () => {
    let first: IngestStack | undefined;
    let second: IngestStack | undefined;
    afterAll(async () => {
      await second?.close({ keepDb: true });
      await first?.db.drop();
      if (first) rmSync(first.root, { recursive: true, force: true });
    });

    it(
      "a user whose h_ document run and chat turn both park leaves no row that names the handle or the user",
      async () => {
        let reached: () => void = () => {};
        const entered = new Promise<void>((r) => {
          reached = r;
        });
        const hanging = {
          complete: (r: { signal?: AbortSignal }) =>
            new Promise<never>((_, reject) => {
              reached();
              r.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            }),
        } as never;
        first = await startIngestStack({ chat: true });
        const login = await first.signUpAndLogIn("ida@example.com");
        // the user's UUID subject must own a running turn: an old chat
        const user = await seedUser(first, login, "ida@example.com", { chat: "legacy" });
        await first.close({ keepDb: true });

        // Both stop signals are swallowed until the park they should have prevented: the h_ run (the document's cancel) stays
        // running for the first shred, and the chat turn for the first TWO (the h_ park's repeat stop, then the user's own park).
        let chatStops = 0;
        let cancels = 0;
        const outcomes: Array<[string, string]> = [];
        const wrap = (deps: ErasureDeps): ErasureDeps => ({
          ...deps,
          cancelVisualize: async (identity, documentId, generation) => {
            if (cancels++ === 0) return;
            await deps.cancelVisualize(identity, documentId, generation);
          },
          stopChat: async (identity, chatId) => {
            if (chatStops++ < 2) return;
            await deps.stopChat(identity, chatId);
          },
          eraseSubject: async (subject) => {
            const r = await deps.eraseSubject(subject);
            outcomes.push([subject, r.outcome]);
            return r;
          },
        });
        const st = await startIngestStack({
          chat: true,
          suggestLlm: hanging,
          wrapErasure: wrap,
          resume: { db: first.db, kek: first.kek, root: first.root },
        });
        second = st;
        const claude = st.claude;
        if (!claude) throw new Error("no fake Claude");
        const ref = { tenantId: user.tenantId, userId: user.userId, documentId: user.documentId };
        await new PgDocumentResults(st.app, st.fields).putSummary(ref, SUMMARY);
        expect(await st.composed.suggestTags.start(ref)).toEqual({ kind: "started", run: 1 });
        await entered;
        const runId = await st.runIds.suggestTags(ref, ref.documentId, 1);
        const handle = runId.slice(2, runId.indexOf(":"));
        expect(handle).toMatch(/^[a-z2-7]{25}[aeimquy4]$/);

        scriptChat(claude, () => ({
          stream: {
            steps: [
              { text: "Due " },
              { hold: true },
              { text: "in 30 days." },
              { stop: "end_turn" },
            ],
          },
        }));
        const sent = await st.chatReq(user.cookie, "POST", `/api/chats/${user.chatId}/messages`, {
          text: "And the interest?",
        });
        expect(sent.status).toBe(202);
        const gate = await claude.streamHold();
        try {
          expect((await eraseMe(st, user.cookie)).status).toBe(202);
          await waitErased(st, user.userId, 120_000);
        } finally {
          gate.release();
        }
        // Both subjects parked, so the old Loom would have written an ERASURE_PENDING for each.
        expect(outcomes).toContainEqual([`h_${handle}`, "parked"]);
        expect(outcomes).toContainEqual([user.userId, "parked"]);
        await vi.waitFor(async () => expect(await st.keys.wasDestroyed(user.userId)).toBe(true));
        await assertErased(st, user, { tenantGone: true });

        // Nothing on the control stream names the handle, `h_<H>` or the user, and no row of it carries a plain subject id.
        const rows = await controlRows(st);
        for (const row of rows) {
          const text = JSON.stringify(row);
          expect(text).not.toContain(handle);
          expect(text).not.toContain(user.userId);
          expect(text).not.toContain(user.tenantId);
          expect(eventColumnProblems(row)).toEqual([]);
          const payload = row.payload as Record<string, unknown> | null;
          expect(payload && "subjectId" in payload).toBeFalsy();
          if (payload && ("subjectRef" in payload || "keyId" in payload)) {
            expect(payload.subjectRef).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
            expect(typeof payload.keyId).toBe("string");
          }
        }
      },
      WAIT,
    );
  },
);
