import { rmSync } from "node:fs";
import { ChatSessionDto, type UploadDocumentResponse } from "@docmind/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { DOC, collectUntil, isReply, scriptChat } from "../chats/e2eSupport";
import { chatConversationId } from "../chats/ids";
import { pgSessionLock } from "../db/sessionLock";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { eraseMe, waitErased } from "../erasure/e2eSupport";
import { SNAPSHOT_PRUNE_LOCK_KEY, snapshotPruneDeps } from "./pgPruner";
import { sweepChatSnapshots } from "./pruner";

describe.skipIf(!PG_URL)("snapshot pruning on real chats (needs DOCMIND_TEST_PG_URL)", () => {
  const stacks: IngestStack[] = [];
  const dbs = new Set<IngestStack["db"]>();
  const roots = new Set<string>();
  const track = (stack: IngestStack) => {
    stacks.push(stack);
    dbs.add(stack.db);
    roots.add(stack.root);
    return stack;
  };
  afterAll(async () => {
    for (const s of stacks.splice(0)) await s.close({ keepDb: true });
    for (const db of dbs) await db.drop();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const snapshots = async (st: IngestStack, executionId: string) =>
    (
      await st.db.owner.query(
        "SELECT sequence, md5(state::text) AS h FROM loom.snapshots WHERE execution_id = $1 ORDER BY sequence",
        [executionId],
      )
    ).rows as { sequence: string; h: string }[];

  /** The snapshot rows once the runtime has stopped writing them: the same list on three reads 150 ms apart. */
  async function settled(st: IngestStack, executionId: string) {
    let last = JSON.stringify(await snapshots(st, executionId));
    let same = 0;
    for (let i = 0; i < 100 && same < 3; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const now = JSON.stringify(await snapshots(st, executionId));
      same = now === last ? same + 1 : 0;
      last = now;
    }
    expect(same).toBe(3);
  }

  /** One user, one ready document, one chat answered `turns` times; returns the conversation id. */
  async function chatTurns(st: IngestStack, email: string, turns: number) {
    const claude = st.claude;
    if (!claude) throw new Error("no fake Claude");
    const user = await st.signUpAndLogIn(email);
    const events = await st.events(user.cookie);
    const up = await st.upload(user.cookie, "terms.txt", Buffer.from(DOC));
    const documentId = ((await up.json()) as UploadDocumentResponse).document.id;
    await st.until(events, documentId, (s) => s === "ready" || s === "failed");
    events.close();
    scriptChat(claude, () => ({
      stream: { steps: [{ text: "Due in 30 days." }, { stop: "end_turn" }] },
    }));
    const chat = ChatSessionDto.parse(
      await (await st.chatReq(user.cookie, "POST", "/api/chats", {})).json(),
    );
    const stream = await st.openChat(user.cookie, chat.id);
    const seen = new Set<string>();
    try {
      for (let i = 0; i < turns; i++) {
        const sent = await st.chatReq(user.cookie, "POST", `/api/chats/${chat.id}/messages`, {
          text: `Question ${i}: when is payment due?`,
        });
        expect(sent.status).toBe(202);
        // this turn's reply: a complete assistant message not seen on an earlier turn
        await collectUntil(stream, (f) => {
          const m = f.data as { cursor?: string; status?: string };
          if (
            !isReply(f) ||
            m.status !== "complete" ||
            m.cursor === undefined ||
            seen.has(m.cursor)
          )
            return false;
          seen.add(m.cursor);
          return true;
        });
      }
    } finally {
      stream.close();
    }
    const conversation = chatConversationId(user.userId, chat.id) as string;
    await settled(st, conversation); // the park after the last turn has committed its snapshot
    return { user, chat, conversation };
  }

  it("keeps the latest snapshot of a chat, deletes the rest, and the chat answers after a restart", async () => {
    const first = track(await startIngestStack({ chat: true }));
    const ada = await chatTurns(first, "ada@example.com", 3);
    const before = await snapshots(first, ada.conversation);
    expect(before.length).toBeGreaterThan(1);
    const ingestBefore = (
      await first.db.owner.query(
        "SELECT execution_id, count(*)::int AS n FROM loom.snapshots WHERE execution_id NOT LIKE '%.c-%' GROUP BY 1 ORDER BY 1",
      )
    ).rows;

    // Another replica holds the lock: the sweep looks at nothing.
    const held = await pgSessionLock(first.durable.pool, SNAPSHOT_PRUNE_LOCK_KEY, "test");
    expect(held).not.toBeNull();
    expect(await sweepChatSnapshots(snapshotPruneDeps(first.durable))).toMatchObject({
      skipped: true,
      deleted: 0,
    });
    await held?.();
    expect(await snapshots(first, ada.conversation)).toEqual(before);

    const report = await sweepChatSnapshots(snapshotPruneDeps(first.durable));
    expect(report).toMatchObject({ skipped: false, failed: 0, deleted: before.length - 1 });
    expect(await snapshots(first, ada.conversation)).toEqual([before.at(-1)]);
    // nothing else changed: ingest executions keep theirs
    expect(
      (
        await first.db.owner.query(
          "SELECT execution_id, count(*)::int AS n FROM loom.snapshots WHERE execution_id NOT LIKE '%.c-%' GROUP BY 1 ORDER BY 1",
        )
      ).rows,
    ).toEqual(ingestBefore);
    // a second sweep has nothing left to do
    expect(await sweepChatSnapshots(snapshotPruneDeps(first.durable))).toMatchObject({
      deleted: 0,
    });

    // The chat resumes from the one snapshot left: a restart, then another turn, with the history intact.
    await first.close({ keepDb: true });
    stacks.splice(stacks.indexOf(first), 1);
    const second = track(
      await startIngestStack({
        chat: true,
        resume: { db: first.db, kek: first.kek, root: first.root },
      }),
    );
    const claude2 = second.claude;
    if (!claude2) throw new Error("no fake Claude");
    scriptChat(claude2, () => ({
      stream: { steps: [{ text: "Two percent per month." }, { stop: "end_turn" }] },
    }));
    const stream = await second.openChat(ada.user.cookie, ada.chat.id);
    try {
      const sent = await second.chatReq(
        ada.user.cookie,
        "POST",
        `/api/chats/${ada.chat.id}/messages`,
        {
          text: "And late payment?",
        },
      );
      expect(sent.status).toBe(202);
      const frames = await collectUntil(
        stream,
        (f) => isReply(f) && JSON.stringify(f.data).includes("Two percent"),
      );
      expect(JSON.stringify(frames)).toContain("Two percent per month.");
    } finally {
      stream.close();
    }
    // the model saw the earlier turns: the restored state carried them
    const lastRequest = JSON.stringify(
      claude2.requests.filter((r) => r.body.model !== "title-model").at(0)?.body.messages,
    );
    expect(lastRequest).toContain("Question 2: when is payment due?");
  }, 40_000);

  it("prunes an erased user's chat without opening it", async () => {
    const st = track(await startIngestStack({ chat: true }));
    const bob = await chatTurns(st, "bob@example.com", 2);
    expect((await snapshots(st, bob.conversation)).length).toBeGreaterThan(1);
    expect((await eraseMe(st, bob.user.cookie)).status).toBe(202);
    await waitErased(st, bob.user.userId);
    const left = await snapshots(st, bob.conversation);
    expect(left.length).toBeGreaterThan(1); // erasure leaves the snapshots; the sweep has real work
    const report = await sweepChatSnapshots(snapshotPruneDeps(st.durable));
    expect(report.failed).toBe(0);
    expect(report.deleted).toBeGreaterThanOrEqual(left.length - 1);
    expect(await snapshots(st, bob.conversation)).toEqual([left.at(-1)]);
  }, 40_000);

  it("runs on its interval inside the server and stops with it", async () => {
    const st = track(await startIngestStack({ chat: true, snapshotPruneIntervalMs: 300 }));
    const cy = await chatTurns(st, "cy@example.com", 3);
    await expect
      .poll(async () => (await snapshots(st, cy.conversation)).length, {
        timeout: 15_000,
        interval: 100,
      })
      .toBe(1);
    await st.close({ keepDb: true }); // stop() drains the pruner with the upload sweeper; no unhandled rejection
    stacks.splice(stacks.indexOf(st), 1);
  }, 40_000);
});
