import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { PgDocumentResults } from "../flows/ingest-document/pgResults";
import { eraseMe, seedUser, waitErased } from "./e2eSupport";

const WAIT = 300_000;
const SUMMARY = {
  tldr: "Quarterly summary",
  keyPoints: ["Revenue grew"],
  entities: [],
  topics: ["finance"],
  suggestedQuestions: [],
};

describe.skipIf(!PG_URL)(
  "erasure through the composed id wiring (needs DOCMIND_TEST_PG_URL)",
  () => {
    let first: IngestStack | undefined;
    let second: IngestStack | undefined;
    afterAll(async () => {
      await second?.close({ keepDb: true });
      await first?.db.drop();
      if (first) rmSync(first.root, { recursive: true, force: true });
    });

    it(
      "erasing a user with a running h_ run cancels it and destroys the handle's key, and the user's own",
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
        // Seeded on a stack with no summary model (the ingest's summary step would otherwise wait on the hanging one), then resumed with it.
        first = await startIngestStack({ chat: true });
        const login = await first.signUpAndLogIn("hana@example.com");
        const user = await seedUser(first, login, "hana@example.com");
        await first.close({ keepDb: true });
        const st = await startIngestStack({
          chat: true,
          suggestLlm: hanging,
          resume: { db: first.db, kek: first.kek, root: first.root },
        });
        second = st;
        const ref = { tenantId: user.tenantId, userId: user.userId, documentId: user.documentId };
        await new PgDocumentResults(st.app, st.fields).putSummary(ref, SUMMARY);

        expect(await st.composed.suggestTags.start(ref)).toEqual({ kind: "started", run: 1 });
        await entered;
        const runId = await st.runIds.suggestTags(ref, ref.documentId, 1);
        expect(runId).toMatch(/^h_[a-z2-7]{25}[aeimquy4]:suggest-tags-/);
        const principal = { tenant: ref.tenantId, actor: ref.userId };
        expect((await st.composed.app.runtime.loadState(runId, { principal }))?.status).toBe(
          "running",
        );
        const handle = runId.slice(0, runId.indexOf(":")); // the Loom subject of every new-format run: h_<H>
        expect(await st.keys.wasDestroyed(handle)).toBe(false);

        // The composed erasure deps carry `ids`: with them erasure names the user's h_ run, cancels it and destroys the handle's key.
        expect((await eraseMe(st, user.cookie)).status).toBe(202);
        await waitErased(st, user.userId, 60_000);
        expect(await st.keys.wasDestroyed(handle)).toBe(true);
        expect(await st.keys.wasDestroyed(user.userId)).toBe(true);
        const { rows } = await st.db.owner.query("SELECT 1 FROM users WHERE id = $1", [
          user.userId,
        ]);
        expect(rows).toEqual([]);
        expect(st.composed.ids.cached(user.userId)).toBeUndefined(); // the cached id key went with the subject key
      },
      WAIT,
    );
  },
);
