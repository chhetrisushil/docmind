import { randomUUID } from "node:crypto";
import type { HistoryEntry } from "@loom/conversation";
import { describe, expect, it, vi } from "vitest";
import { fixedChatIds } from "../../chats/testing";
import type { StoredPassage, TurnItem } from "../../chats/turnItems";
import { LOOKBACK_RECORDS, readTurn } from "./readTurn";

const user = randomUUID();
const chat = randomUUID();
const ref = { tenantId: randomUUID(), userId: user, chatId: chat, ord: 4 };
const DOC = randomUUID();
const P1 = randomUUID();
const P2 = randomUUID();
const passage = (passageId: string, documentId = DOC): StoredPassage => ({
  passageId,
  documentId,
  locator: { kind: "section", index: 1 },
  headingPath: [],
  snippet: "x",
});
const reply = (text: string): HistoryEntry =>
  ({ ord: 4, turn: 2, role: "assistant", status: "complete", text, cursor: "1.9" }) as HistoryEntry;
const user1 = {
  ord: 3,
  turn: 2,
  role: "user",
  status: "complete",
  text: "q",
  cursor: "1.8",
} as HistoryEntry;

/** A reader whose backward pages hold `all` (oldest first) newest first, `size` per page. */
const readerOf = (all: HistoryEntry[], size = 2) => {
  const newest = [...all].reverse();
  return {
    read: vi.fn(async (_id: string, o: { cursor?: string }) => {
      const from = o.cursor === undefined ? 0 : Number(o.cursor);
      const entries = newest.slice(from, from + size);
      const next = from + size;
      return { entries, nextCursor: String(next), done: next >= newest.length };
    }),
  };
};
const deps = (
  entries: HistoryEntry[],
  items: TurnItem[],
  titles: Record<string, string> = { [DOC]: "Q3 report" },
) => ({
  reader: readerOf(entries) as never,
  // the turn key of ord 4 / turn 2 is ord - turn = 2
  items: {
    forTurns: vi.fn(
      async (_r: unknown, keys: number[]) => new Map(keys.includes(2) ? [[2, items]] : []),
    ),
  } as never,
  pool: {} as never,
  fields: {} as never,
  chatIds: fixedChatIds(),
  titlesOf: async () => new Map(Object.entries(titles)),
});

describe("readTurn", () => {
  it("returns the retrieved chunks and the citations the reply keeps, for documents still owned", async () => {
    const out = await readTurn(
      deps(
        [user1, reply(`Revenue was 1,200 [[${P2}]] and rose [[${P1}]] [[${P2}]].`)],
        [
          { kind: "passages", body: { passages: [passage(P1), passage(P2)] } },
          { kind: "passages", body: { passages: [passage(P2)] } },
        ],
      ),
      ref,
    );
    expect(out).toEqual({
      status: "complete",
      retrieved: [P1, P2],
      citations: [
        { passageId: P2, documentId: DOC },
        { passageId: P1, documentId: DOC },
      ],
    });
  });

  it("drops a citation of a document that is gone, and a marker the turn never retrieved", async () => {
    const out = await readTurn(
      deps(
        [user1, reply(`a [[${P1}]] b [[${randomUUID()}]]`)],
        [{ kind: "passages", body: { passages: [passage(P1)] } }],
        {},
      ),
      ref,
    );
    expect(out?.citations).toEqual([]);
  });

  it("finds the record several pages back, and answers null for an ord that is not an assistant record", async () => {
    const filler = Array.from(
      { length: 5 },
      (_, i) => ({ ...user1, ord: 10 + i, turn: 3 + i }) as HistoryEntry,
    );
    expect((await readTurn(deps([user1, reply("x"), ...filler], []), ref))?.status).toBe(
      "complete",
    );
    expect(await readTurn(deps([user1, reply("x")], []), { ...ref, ord: 3 })).toBeNull();
    expect(await readTurn(deps([user1, reply("x")], []), { ...ref, ord: 99 })).toBeNull();
  });

  it("stops at the first page that reaches an older ord, though the log is not done", async () => {
    const older = { ...user1, ord: 2, turn: 1 } as HistoryEntry;
    const read = vi.fn(async () => ({ entries: [older], nextCursor: "1.1", done: false }));
    const out = await readTurn({ ...deps([], []), reader: { read } as never }, { ...ref, ord: 4 });
    expect(out).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("answers 'too_old' (not null) when the reply is past the lookback, after a bounded number of reads", async () => {
    const newer = { ...user1, ord: 900, turn: 9 } as HistoryEntry;
    const read = vi.fn(async () => ({ entries: [newer], nextCursor: "1.1", done: false }));
    const out = await readTurn({ ...deps([], []), reader: { read } as never }, ref);
    expect(out).toEqual({ status: "too_old", retrieved: [], citations: [] });
    expect(read).toHaveBeenCalledTimes(LOOKBACK_RECORDS / 100);
    expect(LOOKBACK_RECORDS).toBeGreaterThan(1200);
  });
});
