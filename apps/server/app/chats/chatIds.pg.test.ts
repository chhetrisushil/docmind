import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { T1, T2, U1, U1B, U2 } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { OpaqueIds } from "../opaqueIds";
import { AutoHandleStore, DeterministicKeyStore, deterministicUser } from "../opaqueIds/testing";
import { PgChatIds } from "./chatIds";
import { insertChat } from "./sessions";

describe.skipIf(!PG_URL)("PgChatIds (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });
  const make = () => {
    const keys = new DeterministicKeyStore();
    const ids = new OpaqueIds(keys, new AutoHandleStore());
    return { keys, ids, chatIds: new PgChatIds(fx.app, ids) };
  };
  const chat = (tenant: string, user: string, format: "legacy" | "opaque") =>
    withTenant(fx.app, tenant, (tx) => insertChat(tx, tenant, user, randomUUID(), "all", format));

  it("builds the old ids for a legacy row and needs no key for it", async () => {
    const { chatIds, ids } = make();
    const row = await chat(T1, U1, "legacy");
    const b = await chatIds.forRow({ tenantId: T1, userId: U1 }, row);
    expect(b?.format).toBe("legacy");
    expect(b?.conversationId()).toBe(`u_${U1}.c-${row.id}`);
    expect(ids.cached(U1)).toBeUndefined(); // nothing was minted or loaded
  });

  it("builds the new ids for an opaque row, from the cached user, and never mints", async () => {
    const { chatIds, ids } = make();
    const row = await chat(T1, U1, "opaque");
    expect(await chatIds.forRow({ tenantId: T1, userId: U1 }, row)).toBeNull(); // no handle yet: a reader never mints
    await ids.ensureUser({ tenantId: T1, userId: U1 });
    const b = await chatIds.forRow({ tenantId: T1, userId: U1 }, row);
    expect(b?.conversationId()).toBe(deterministicUser(U1).conversation(row.id));
  });

  it("forRef reads the format from the row once, and answers null for a chat that is not the owner's", async () => {
    const { chatIds, ids } = make();
    await ids.ensureUser({ tenantId: T1, userId: U1 });
    const legacy = await chat(T1, U1, "legacy");
    const opaque = await chat(T1, U1, "opaque");
    const ref = (c: { id: string }, tenantId = T1, userId = U1) => ({
      tenantId,
      userId,
      chatId: c.id,
    });
    expect((await chatIds.forRef(ref(legacy)))?.format).toBe("legacy");
    expect((await chatIds.forRef(ref(opaque)))?.format).toBe("opaque");
    expect(await chatIds.forRef({ tenantId: T1, userId: U1, chatId: randomUUID() })).toBeNull();
    // another user, another tenant: the same answer as an unknown chat
    expect(await chatIds.forRef(ref(legacy, T1, U2))).toBeNull();
    expect(await chatIds.forRef(ref(legacy, T2, U1))).toBeNull();
  });

  it("keys its format cache by tenant too: a hit for (T1, U1) does not answer for (T2, U1)", async () => {
    const { chatIds } = make();
    const row = await chat(T1, U1, "legacy");
    expect((await chatIds.forRef({ tenantId: T1, userId: U1, chatId: row.id }))?.format).toBe(
      "legacy",
    ); // fills the cache
    expect(await chatIds.forRef({ tenantId: T2, userId: U1, chatId: row.id })).toBeNull(); // not a cache hit
  });

  it("forgetUser drops a user's cached formats: a cached answer may outlive a deleted row for one process, and no longer after the eraser forgets the user", async () => {
    const { chatIds } = make();
    const mine = await chat(T1, U1, "legacy");
    const theirs = await chat(T1, U1B, "legacy");
    const ref = (c: { id: string }, userId: string) => ({ tenantId: T1, userId, chatId: c.id });
    expect((await chatIds.forRef(ref(mine, U1)))?.format).toBe("legacy");
    expect((await chatIds.forRef(ref(theirs, U1B)))?.format).toBe("legacy");
    await fx.db.owner.query("DELETE FROM chat_sessions WHERE id = ANY($1)", [[mine.id, theirs.id]]);
    expect((await chatIds.forRef(ref(mine, U1)))?.format).toBe("legacy"); // cached: the row is gone, the answer stays
    chatIds.forgetUser(U1);
    expect(await chatIds.forRef(ref(mine, U1))).toBeNull(); // forgotten: asks the database, finds nothing
    expect((await chatIds.forRef(ref(theirs, U1B)))?.format).toBe("legacy"); // another user's entry is untouched
  });

  it("a forRef read in flight when forgetUser runs does not cache what it read", async () => {
    const { chatIds } = make();
    const mine = await chat(T1, U1, "legacy");
    const ref = { tenantId: T1, userId: U1, chatId: mine.id };
    const inFlight = chatIds.forRef(ref); // its query is still out
    chatIds.forgetUser(U1);
    expect((await inFlight)?.format).toBe("legacy"); // the read itself still answers
    await fx.db.owner.query("DELETE FROM chat_sessions WHERE id = $1", [mine.id]);
    expect(await chatIds.forRef(ref)).toBeNull(); // nothing was cached: asks the database, finds nothing
  });

  it("answers null for an opaque chat whose owner's key is destroyed, and the legacy chat of that owner still builds", async () => {
    const { chatIds, ids, keys } = make();
    await ids.ensureUser({ tenantId: T1, userId: U1 });
    const opaque = await chat(T1, U1, "opaque");
    const legacy = await chat(T1, U1, "legacy");
    ids.forgetSubject(`h_${deterministicUser(U1).handle}`); // what the eraser does: evicts the handle's entry and its user's
    await keys.destroy(U1);
    const who = { tenantId: T1, userId: U1 };
    expect(await chatIds.forRow(who, opaque)).toBeNull();
    expect((await chatIds.forRow(who, legacy))?.conversationId()).toBe(`u_${U1}.c-${legacy.id}`);
  });

  it("forNew mints the handle and builds a new-format id", async () => {
    const { chatIds, ids } = make();
    const id = randomUUID();
    const b = await chatIds.forNew({ tenantId: T1, userId: U2 }, id);
    expect(b.format).toBe("opaque");
    expect(ids.cached(U2)?.handle).toBe(deterministicUser(U2).handle);
    expect(b.conversationId()).toBe(deterministicUser(U2).conversation(id));
  });
});
