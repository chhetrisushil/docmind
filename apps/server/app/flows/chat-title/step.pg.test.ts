import { LlmAbortedError, LlmRefusalError, LlmUnavailableError } from "@docmind/llm-anthropic";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatConversationId } from "../../chats/ids";
import { chatTitleBind, setTitle } from "../../chats/sessions";
import { type ChatHarness, seedChat, startChatServer } from "../../chats/testHarness";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { ALICE, BOB, T1, U1 } from "../../documents/testHarness";
import { chatTitleEffect } from "./step";

/** A scripted provider: each call takes the next entry (a reply text, or an error to throw). */
function provider(script: (string | Error)[]) {
  const requests: LlmRequest[] = [];
  let gate: Promise<void> | undefined;
  let reach: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const llm = {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      requests.push(req);
      reach();
      await gate;
      const next = script.shift() ?? "Fallback title";
      if (next instanceof Error) throw next;
      return { content: next, stopReason: "end_turn" };
    },
  } as unknown as LlmProvider;
  return {
    llm,
    requests,
    reached,
    hold: () => {
      let open = () => {};
      gate = new Promise<void>((r) => {
        open = r;
      });
      return () => {
        open();
        gate = undefined;
      };
    },
  };
}

describe.skipIf(!PG_URL)("the chat-title step (needs DOCMIND_TEST_PG_URL)", () => {
  let h: ChatHarness;
  beforeAll(async () => {
    h = await startChatServer();
  });
  afterAll(async () => {
    await h.close();
  });
  const ref = (chatId: string) => ({ tenantId: T1, userId: U1, chatId });
  const run = (p: ReturnType<typeof provider> | null, chatId: string, who = ref(chatId)) =>
    chatTitleEffect({
      pool: h.app,
      fields: h.fields,
      reader: h.fake.api.reader,
      ...(p && { llm: p.llm }),
      sleep: async () => {},
    }).execute(who, {} as never);
  const titleRow = async (chatId: string) =>
    (
      await h.owner.query("SELECT title_enc, title_source FROM chat_sessions WHERE id = $1", [
        chatId,
      ])
    ).rows[0];
  const exchange = (chatId: string) =>
    h.fake.addTurn(chatConversationId(U1, chatId), {
      question: "When is payment due?",
      answer: "In 30 days [[0b0e7c9a-1111-4222-8333-444455556666]].",
    });
  /** A reader that has recorded nothing for its first `empty` reads, then reads the harness's conversation. */
  const lateReader = (empty: number) => {
    let reads = 0;
    return {
      get reads() {
        return reads;
      },
      read: async (...args: Parameters<typeof h.fake.api.reader.read>) =>
        reads++ < empty ? ({ entries: [], done: true } as never) : h.fake.api.reader.read(...args),
    };
  };

  it("titles a chat from its first question, sealed, as the automatic title", async () => {
    const chatId = await seedChat(h, ALICE);
    exchange(chatId);
    h.fake.addTurn(chatConversationId(U1, chatId), {
      question: "A later question",
      answer: "A later answer",
    });
    const p = provider(['"Payment due dates."']);
    expect(await run(p, chatId)).toEqual({ outcome: "titled" });
    const row = await titleRow(chatId);
    expect(row.title_source).toBe("auto");
    expect(await h.fields.forUser(U1).openText(chatTitleBind(chatId), row.title_enc)).toBe(
      "Payment due dates",
    );
    expect(row.title_enc.__loomEnc).toBeDefined();
    expect(JSON.stringify(row.title_enc)).not.toContain("Payment due dates");
    const sent = JSON.stringify(p.requests[0]?.messages);
    expect(sent).toContain("When is payment due?");
    expect(sent).not.toContain("A later question"); // only the first question
    expect(sent).not.toContain("In 30 days"); // and never the reply
  });

  it("skips, without asking the model, a chat that is already titled", async () => {
    const titled = await seedChat(h, ALICE, { title: "Mine" });
    exchange(titled);
    const p = provider([]);
    expect(await run(p, titled)).toEqual({ outcome: "skipped" });
    expect(p.requests).toHaveLength(0);
  });

  it("waits for a question that is not recorded yet, then titles; gives up as skipped when none ever appears", async () => {
    const late = await seedChat(h, ALICE);
    exchange(late);
    const reader = lateReader(2);
    const p = provider(["Late title"]);
    const effect = chatTitleEffect({
      pool: h.app,
      fields: h.fields,
      reader: reader as never,
      llm: p.llm,
      sleep: async () => {},
    });
    expect(await effect.execute(ref(late), {} as never)).toEqual({ outcome: "titled" });
    expect(reader.reads).toBe(3); // two empty reads, then the question

    const never = await seedChat(h, ALICE); // no message at all
    const none = provider([]);
    const waiting = lateReader(0);
    const giveUp = chatTitleEffect({
      pool: h.app,
      fields: h.fields,
      reader: waiting as never,
      llm: none.llm,
      sleep: async () => {},
    });
    expect(await giveUp.execute(ref(never), {} as never)).toEqual({ outcome: "skipped" });
    expect(waiting.reads).toBe(3); // the whole retry budget (CHAT_TITLE_RETRY.maxAttempts)
    expect(none.requests).toHaveLength(0);
    expect((await titleRow(never)).title_source).toBe("none");
  });

  it("skips a deleted chat and a chat named under another tenant, and writes nothing", async () => {
    const gone = await seedChat(h, ALICE);
    exchange(gone);
    await h.owner.query("UPDATE chat_sessions SET deleted_at = now() WHERE id = $1", [gone]);
    const mine = await seedChat(h, ALICE);
    exchange(mine);
    const p = provider(["A title"]);
    expect(await run(p, gone)).toEqual({ outcome: "skipped" });
    expect(await run(p, mine, { tenantId: BOB.tenantId, userId: U1, chatId: mine })).toEqual({
      outcome: "skipped",
    });
    expect((await titleRow(mine)).title_source).toBe("none");
    expect(p.requests).toHaveLength(0);
  });

  it("skips without a Claude key", async () => {
    const chatId = await seedChat(h, ALICE);
    exchange(chatId);
    expect(await run(null, chatId)).toEqual({ outcome: "skipped" });
  });

  it("lets a rename that lands while the model is thinking win", async () => {
    const chatId = await seedChat(h, ALICE);
    exchange(chatId);
    const p = provider(["Automatic title"]);
    const release = p.hold();
    const pending = run(p, chatId);
    await p.reached; // the model has the question: the rename now lands while it is thinking
    const mine = await h.fields.forUser(U1).seal(chatTitleBind(chatId), "My own title");
    await withTenant(h.app, T1, (tx) => setTitle(tx, U1, chatId, mine, "user"));
    release();
    expect(await pending).toEqual({ outcome: "skipped" });
    expect(
      await h.fields
        .forUser(U1)
        .openText(chatTitleBind(chatId), (await titleRow(chatId)).title_enc),
    ).toBe("My own title");
  });

  it("retries an outage, then skips; skips at once on a refusal or an unusable answer; rethrows an abort", async () => {
    const outage = await seedChat(h, ALICE);
    exchange(outage);
    const down = provider([
      new LlmUnavailableError(529),
      new LlmUnavailableError(529),
      new LlmUnavailableError(529),
    ]);
    expect(await run(down, outage)).toEqual({ outcome: "skipped" });
    expect(down.requests).toHaveLength(3);

    const recovers = await seedChat(h, ALICE);
    exchange(recovers);
    const flaky = provider([new LlmUnavailableError(529), "Recovered title"]);
    expect(await run(flaky, recovers)).toEqual({ outcome: "titled" });
    expect(flaky.requests).toHaveLength(2);

    const refused = await seedChat(h, ALICE);
    exchange(refused);
    const refuses = provider([new LlmRefusalError()]);
    expect(await run(refuses, refused)).toEqual({ outcome: "skipped" });
    expect(refuses.requests).toHaveLength(1);

    const blank = await seedChat(h, ALICE);
    exchange(blank);
    expect(await run(provider(['""']), blank)).toEqual({ outcome: "skipped" });

    const aborted = await seedChat(h, ALICE);
    exchange(aborted);
    await expect(run(provider([new LlmAbortedError()]), aborted)).rejects.toBeInstanceOf(
      LlmAbortedError,
    );
    for (const id of [outage, refused, blank, aborted])
      expect((await titleRow(id)).title_source).toBe("none");
  });

  it("rejects, never skips, when the shutdown signal aborts during a backoff wait or before an attempt", async () => {
    const waiting = await seedChat(h, ALICE);
    exchange(waiting);
    const controller = new AbortController();
    const reader = lateReader(5);
    const effect = chatTitleEffect({
      pool: h.app,
      fields: h.fields,
      reader: reader as never,
      llm: provider([]).llm,
      sleep: async (_ms, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort();
      },
    });
    await expect(
      effect.execute(ref(waiting), { signal: controller.signal } as never),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(reader.reads).toBe(1);

    const before = new AbortController();
    before.abort();
    await expect(
      chatTitleEffect({
        pool: h.app,
        fields: h.fields,
        reader: h.fake.api.reader,
        llm: provider(["x"]).llm,
      }).execute(ref(waiting), { signal: before.signal } as never),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
