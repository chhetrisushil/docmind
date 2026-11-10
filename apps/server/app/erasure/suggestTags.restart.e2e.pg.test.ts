import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { PgDocumentResults } from "../flows/ingest-document/pgResults";
import { suggestTagsExecutionId } from "../flows/suggest-tags/start";
import { eraseMe, seedUser, waitErased } from "./e2eSupport";

const WAIT = 300_000;
const SUMMARY = {
  tldr: "Quarterly summary",
  keyPoints: ["Revenue grew"],
  entities: [],
  topics: ["finance"],
  suggestedQuestions: [],
};

/** A model call that never answers (until aborted), and a promise that says it was reached. */
function hanging() {
  let reached: () => void = () => {};
  const entered = new Promise<void>((r) => {
    reached = r;
  });
  return {
    entered,
    llm: {
      complete: (r: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          reached();
          r.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    } as never,
  };
}

describe.skipIf(!PG_URL)("suggest-tags across a restart (needs DOCMIND_TEST_PG_URL)", () => {
  const stacks: IngestStack[] = [];
  const dbs = new Set<IngestStack["db"]>();
  const roots = new Set<string>();
  const track = (s: IngestStack) => {
    stacks.push(s);
    dbs.add(s.db);
    roots.add(s.root);
    return s;
  };
  const kill = async (s: IngestStack) => {
    await s.close({ keepDb: true });
    stacks.splice(stacks.indexOf(s), 1);
  };
  afterAll(async () => {
    for (const s of stacks.splice(0)) await s.close({ keepDb: true });
    for (const db of dbs) await db.drop();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  /** A user with a summarised document and a suggest-tags run left running by a killed process. */
  async function leftRunning(email: string) {
    const first = track(await startIngestStack({ chat: true }));
    const login = await first.signUpAndLogIn(email);
    const user = await seedUser(first, login, email);
    await kill(first);
    const hang = hanging();
    const second = track(
      await startIngestStack({
        chat: true,
        suggestLlm: hang.llm,
        resume: { db: first.db, kek: first.kek, root: first.root },
      }),
    );
    const ref = { tenantId: user.tenantId, userId: user.userId, documentId: user.documentId };
    await new PgDocumentResults(second.app, second.fields).putSummary(ref, SUMMARY);
    expect(await second.composed.suggestTags.start(ref)).toEqual({ kind: "started", run: 1 });
    await hang.entered;
    await kill(second); // the process dies mid-step
    return {
      first,
      user,
      ref,
      executionId: suggestTagsExecutionId(user.userId, user.documentId, 1),
    };
  }

  it(
    "recovery resolves a run left running by a restart",
    async () => {
      const { first, ref, executionId } = await leftRunning("sam@example.com");
      const third = track(
        await startIngestStack({
          chat: true,
          suggestLlm: {
            complete: async () => ({
              content: '{"suggestedTags":["Finance"]}',
              stopReason: "end_turn",
            }),
          } as never,
          resume: { db: first.db, kek: first.kek, root: first.root },
        }),
      );
      const principal = { tenant: ref.tenantId, actor: ref.userId };
      await vi.waitFor(
        async () => {
          const state = await third.composed.app.runtime.loadState(executionId, { principal });
          expect(state?.status).toBe("completed");
        },
        { timeout: 60_000, interval: 200 },
      );
    },
    WAIT,
  );

  it(
    "an erasure after a restart cancels the leftover run and the shred completes instead of parking",
    async () => {
      const { first, user } = await leftRunning("tia@example.com");
      const third = track(
        await startIngestStack({
          chat: true,
          suggestLlm: hanging().llm,
          resume: { db: first.db, kek: first.kek, root: first.root },
        }),
      );
      expect((await eraseMe(third, user.cookie)).status).toBe(202);
      await waitErased(third, user.userId, 60_000);
    },
    WAIT,
  );
});
