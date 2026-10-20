import { randomUUID } from "node:crypto";
import type { ChatScope } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { T1, T2, U1, U1B, U2 } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import {
  CHAT_ACTIVITY_MODEL,
  chatTitleBind,
  getChat,
  insertChat,
  listChats,
  setScope,
  setTitle,
  softDeleteChat,
} from "./sessions";

describe.skipIf(!PG_URL)("chat_sessions titles, scope and list (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });

  const as = <T>(tenant: string, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(fx.app, tenant, fn);
  const make = (user = U1, scope: ChatScope = "all", tenant = T1) =>
    as(tenant, (tx) => insertChat(tx, tenant, user, randomUUID(), scope));
  /** A folded `chat-activity` row, written as the owner role (Task 148 writes it in production). */
  const activity = (chatId: string, user: string, messages: number, lastAt: string, gen = 0) =>
    fx.db.owner.query(
      `INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state)
       VALUES ($1, $2, $3, $4, 1, $5::jsonb)`,
      [
        CHAT_ACTIVITY_MODEL,
        `u_${user}.c-${chatId}${gen ? `~${gen}` : ""}`,
        chatId,
        user,
        JSON.stringify({ messages, lastOrd: messages - 1, lastAt: Date.parse(lastAt) }),
      ],
    );

  it("seals the title: auto only while none, user always, a loser reports false", async () => {
    const row = await make();
    const cipher = fx.fields.forUser(U1);
    const sealed = (text: string) => cipher.seal(chatTitleBind(row.id), text);
    const title = "Quarterly planning notes";
    expect(await as(T1, async (tx) => setTitle(tx, U1, row.id, await sealed(title), "auto"))).toBe(
      true,
    );
    const raw = await fx.db.owner.query(
      "SELECT title_enc, title_source FROM chat_sessions WHERE id = $1",
      [row.id],
    );
    expect(raw.rows[0].title_source).toBe("auto");
    expect(raw.rows[0].title_enc.__loomEnc).toBe("loom/aes-256-gcm");
    expect(JSON.stringify(raw.rows[0].title_enc)).not.toContain(title);
    expect(await cipher.openText(chatTitleBind(row.id), raw.rows[0].title_enc)).toBe(title);
    // a second auto title loses; a user rename wins and is not overwritten by a later auto title
    expect(
      await as(T1, async (tx) => setTitle(tx, U1, row.id, await sealed("Other"), "auto")),
    ).toBe(false);
    expect(
      await as(T1, async (tx) => setTitle(tx, U1, row.id, await sealed("Renamed by me"), "user")),
    ).toBe(true);
    expect(
      await as(T1, async (tx) => setTitle(tx, U1, row.id, await sealed("Late auto"), "auto")),
    ).toBe(false);
    const after = await as(T1, (tx) => getChat(tx, U1, row.id));
    expect(after?.title_source).toBe("user");
    expect(await cipher.openText(chatTitleBind(row.id), after?.title_enc)).toBe("Renamed by me");
    // not the owner's: no write
    expect(await as(T1, (tx) => setTitle(tx, U1B, row.id, { x: 1 }, "user"))).toBe(false);
  });

  it("changes the scope for the owner only, and not on a deleted chat", async () => {
    const row = await make();
    const scope = { documentIds: [randomUUID()] };
    expect(await as(T1, (tx) => setScope(tx, U1B, row.id, scope))).toBe(false);
    expect(await as(T1, (tx) => setScope(tx, U1, row.id, scope))).toBe(true);
    expect((await as(T1, (tx) => getChat(tx, U1, row.id)))?.scope).toEqual(scope);
    expect(await as(T1, (tx) => setScope(tx, U1, row.id, "all"))).toBe(true);
    await as(T1, (tx) => softDeleteChat(tx, U1, row.id));
    expect(await as(T1, (tx) => setScope(tx, U1, row.id, scope))).toBe(false);
  });

  describe("listChats", () => {
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

    it("orders by last activity then creation, counts messages, and works with no activity row", async () => {
      const user = U1B; // a user of its own: other tests' chats do not appear
      const quiet = await make(user); // no activity row: sorts by created_at
      const busy = await make(user);
      const older = await make(user);
      await activity(busy.id, user, 4, "2031-01-02T10:00:00.123Z");
      await activity(older.id, user, 2, "2031-01-01T10:00:00.000Z");
      const rows = await as(T1, (tx) => listChats(tx, user, { limit: 10 }));
      expect(ids(rows)).toEqual([busy.id, older.id, quiet.id]);
      expect(rows.map((r) => r.messages)).toEqual([4, 2, 0]);
      expect(rows[2]?.last_at).toBeNull();
      expect(rows[0]?.last_at?.toISOString()).toBe("2031-01-02T10:00:00.123Z");
      expect(rows[0]?.sort_cursor).toBe("2031-01-02T10:00:00.123000Z"); // cursor text keeps microsecond digits
      expect(rows[2]?.sort_at).toEqual(quiet.created_at);
    });

    it("pages by keyset without a gap or a repeat, to the microsecond", async () => {
      const user = U1B;
      const before = ids(await as(T1, (tx) => listChats(tx, user, { limit: 50 })));
      const fresh = await Promise.all([make(user), make(user), make(user)]);
      // three newer rows: two tie at .123, one is .122; a page boundary falls between the tied pair and the
      // rest, so a cursor that dropped the id tiebreak would skip a row
      const [m0, m1, m2] = await Promise.all([make(user), make(user), make(user)]);
      const micro = [m0, m1, m2];
      await activity(m0.id, user, 1, "2032-06-01T00:00:00.123Z");
      await activity(m1.id, user, 1, "2032-06-01T00:00:00.123Z");
      await activity(m2.id, user, 1, "2032-06-01T00:00:00.122Z");
      // all three created in one millisecond window and given the SAME last activity: only the id splits them
      for (const c of fresh) await activity(c.id, user, 1, "2032-01-01T00:00:00.000Z");
      const want = ids(await as(T1, (tx) => listChats(tx, user, { limit: 50 })));
      expect(want.slice(3, 6)).toEqual(
        fresh
          .map((c) => c.id)
          .sort()
          .reverse(),
      );
      expect(want.slice(0, 3)).toEqual([
        ...micro
          .slice(0, 2)
          .map((c) => c.id)
          .sort()
          .reverse(),
        m2.id,
      ]);
      expect(want).toHaveLength(before.length + 6);
      const seen: string[] = [];
      let cursor: { t: string; i: string } | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const rows = await as(T1, (tx) =>
          listChats(tx, user, { limit: 2, ...(cursor && { cursor }) }),
        );
        seen.push(...ids(rows));
        const last = rows[rows.length - 1];
        if (rows.length < 2 || !last) break;
        cursor = { t: last.sort_cursor, i: last.id };
      }
      expect(seen).toEqual(want);
    });

    it("adds up the generations of a rotated chat and ignores another user's or an erased activity row", async () => {
      const user = U1;
      const chat = await make(user);
      await activity(chat.id, user, 3, "2033-01-01T00:00:00.000Z", 0);
      await activity(chat.id, user, 2, "2033-02-01T00:00:00.000Z", 1);
      await activity(chat.id, U1B, 50, "2034-01-01T00:00:00.000Z", 2); // scope is not the chat's owner
      await fx.db.owner.query(
        `INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state, erased)
         VALUES ($1, $2, $3, $4, 1, $5::jsonb, true)`,
        [
          CHAT_ACTIVITY_MODEL,
          `u_${user}.c-${chat.id}~3`,
          chat.id,
          user,
          JSON.stringify({
            messages: 99,
            lastOrd: 98,
            lastAt: Date.parse("2035-01-01T00:00:00.000Z"),
          }),
        ],
      );
      const row = (await as(T1, (tx) => listChats(tx, user, { limit: 100 }))).find(
        (r) => r.id === chat.id,
      );
      expect(row?.messages).toBe(5);
      expect(row?.last_at?.toISOString()).toBe("2033-02-01T00:00:00.000Z");
    });

    it("refuses a title that is not a sealed object, with a fixed message", async () => {
      const row = await make();
      for (const bad of [null, "plain", 3, ["x"]]) {
        await expect(as(T1, (tx) => setTitle(tx, U1, row.id, bad, "user"))).rejects.toThrow(
          /^chat_sessions\.title_enc must be a sealed object$/,
        );
      }
    });

    it("lists only the owner's live chats, and never another tenant's", async () => {
      const user = U2;
      const mine = await make(user, "all", T2);
      const gone = await make(user, "all", T2);
      await as(T2, (tx) => softDeleteChat(tx, user, gone.id));
      expect(ids(await as(T2, (tx) => listChats(tx, user, { limit: 10 })))).toEqual([mine.id]);
      expect(await as(T1, (tx) => listChats(tx, user, { limit: 10 }))).toEqual([]);
    });
  });
});
