import { randomUUID } from "node:crypto";
import { VisualizeTurnResponse } from "@docmind/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ALICE, BOB } from "../documents/testHarness";
import { UserRateLimit } from "../flows/visualize-turn/limiter";
import type { TurnRead } from "../flows/visualize-turn/readTurn";
import type { VisualizeStart } from "../flows/visualize-turn/start";
import { type ChatHarness, seedChat, startChatServer } from "./testHarness";

const CITED: TurnRead = {
  status: "complete",
  retrieved: ["k"],
  citations: [{ passageId: "k", documentId: randomUUID() }],
};

describe.skipIf(!PG_URL)(
  "POST /api/chats/:id/turns/:ord/visualize (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: ChatHarness;
    const state = {
      turn: CITED as TurnRead | null,
      start: { kind: "started", rerun: 1 } as VisualizeStart,
      limit: new UserRateLimit(10),
    };
    const visualize = vi.fn(async () => state.start);
    beforeAll(async () => {
      h = await startChatServer({
        visualize: {
          starter: { visualize },
          turn: { read: async () => state.turn },
          limiter: { tryAcquire: (u) => state.limit.tryAcquire(u) },
        },
      });
    });
    afterAll(async () => void (await h.close()));
    beforeEach(() => {
      state.limit = new UserRateLimit(10); // each test starts with a fresh limiter, whatever ran before it
      state.turn = CITED;
      state.start = { kind: "started", rerun: 1 };
    });
    const post = (user: string, chat: string, ord: string | number) =>
      h.req(user, "POST", `/api/chats/${chat}/turns/${ord}/visualize`);
    const code = async (res: Response) =>
      ((await res.json()) as { error?: { code?: string } }).error?.code;

    it("answers 202 for a complete, cited answer of the caller's chat, and starts one run", async () => {
      state.limit = new UserRateLimit(10);
      visualize.mockClear();
      const id = await seedChat(h, ALICE);
      const res = await post("alice", id, 4);
      expect([res.status, VisualizeTurnResponse.parse(await res.json())]).toEqual([
        202,
        { started: true },
      ]);
      expect(visualize).toHaveBeenCalledWith({
        tenantId: ALICE.tenantId,
        userId: ALICE.userId,
        chatId: id,
        ord: 4,
      });
    });

    it("answers 404 for another user's chat, an unknown or deleted chat and a malformed ord, and starts nothing", async () => {
      visualize.mockClear();
      const id = await seedChat(h, ALICE);
      expect((await post("bob", id, 4)).status).toBe(404);
      expect((await post("alice", randomUUID(), 4)).status).toBe(404);
      for (const bad of ["0", "-1", "01", "x", "1.5", "1000000000000000"])
        expect((await post("alice", id, bad)).status, bad).toBe(404);
      await h.req("alice", "DELETE", `/api/chats/${id}`);
      expect((await post("alice", id, 4)).status).toBe(404);
      expect(visualize).not.toHaveBeenCalled();
    });

    it("answers 409 not_visualizable for a turn that is not a complete, cited answer, or while the role is off", async () => {
      visualize.mockClear();
      const id = await seedChat(h, ALICE);
      for (const turn of [
        null,
        { ...CITED, citations: [] },
        { ...CITED, status: "interrupted" as const },
        { ...CITED, status: "failed" as const },
      ]) {
        state.turn = turn;
        const res = await post("alice", id, 4);
        expect([res.status, await code(res)]).toEqual([409, "not_visualizable"]);
      }
      expect(visualize).not.toHaveBeenCalled();
      state.turn = CITED;
      state.start = { kind: "disabled" };
      const off = await post("alice", id, 4);
      expect([off.status, await code(off)]).toEqual([409, "not_visualizable"]);
      state.start = { kind: "started", rerun: 1 };
    });

    it("answers 409 visualize_running while a run of the turn is in flight", async () => {
      state.start = { kind: "running" };
      const id = await seedChat(h, ALICE);
      const res = await post("alice", id, 4);
      expect([res.status, await code(res)]).toEqual([409, "visualize_running"]);
      state.start = { kind: "started", rerun: 1 };
    });

    it("answers 429 with retry-after on the 11th request in a minute, per user", async () => {
      state.limit = new UserRateLimit(10);
      const id = await seedChat(h, ALICE);
      for (let i = 0; i < 10; i++) expect((await post("alice", id, 4)).status).toBe(202);
      const limited = await post("alice", id, 4);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      const mine = await seedChat(h, BOB);
      expect((await post("bob", mine, 4)).status).toBe(202); // another user is not limited by alice
    });
  },
);
