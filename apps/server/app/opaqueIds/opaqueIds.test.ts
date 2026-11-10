import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { MAX_EXECUTION_ID_BYTES } from "@loom/plugin-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldKeyStoreError, FieldKeyUnavailableError } from "../crypto/fields";
import {
  HandleMismatchError,
  HandleStoreError,
  OpaqueIds,
  WARM_CONCURRENCY,
  legacyIds,
  opaqueIds,
} from "./index";
import { deterministicUser, testIdSource, testOpaqueIds } from "./testing";

const T = "00000000-0000-0000-0000-0000000000aa";
const U = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const D = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "3a4b5c6d-7e8f-4a9b-8c1d-2e3f4a5b6c7d";

afterEach(() => opaqueIds.install(undefined));

async function userIds(user = U) {
  const t = testOpaqueIds();
  t.store.add(user, T);
  const ids = await t.ids.ensureUser({ tenantId: T, userId: user });
  return { ...t, userIds: ids };
}

describe("every family builds and parses, in both formats", () => {
  it("new format round trip (all eight families)", async () => {
    const { ids, userIds: u } = await userIds();
    opaqueIds.install(ids);
    const cases: [string, ReturnType<typeof opaqueIds.parse>][] = [
      [
        u.ingest(D, 2),
        { format: "opaque", family: "ingest", userId: U, documentId: D, generation: 2 },
      ],
      [
        u.ingest(D, 1),
        { format: "opaque", family: "ingest", userId: U, documentId: D, generation: 1 },
      ],
      [
        u.visualize(D, 3, 4),
        {
          format: "opaque",
          family: "visualize",
          userId: U,
          documentId: D,
          generation: 3,
          rerun: 4,
        },
      ],
      [
        u.visualize(D, 1),
        {
          format: "opaque",
          family: "visualize",
          userId: U,
          documentId: D,
          generation: 1,
          rerun: 0,
        },
      ],
      [
        u.suggestTags(D, 7),
        { format: "opaque", family: "suggestTags", userId: U, documentId: D, rerun: 7 },
      ],
      [
        u.turnVisualize(C, 12, 2),
        { format: "opaque", family: "turnVisualize", userId: U, chatId: C, ord: 12, rerun: 2 },
      ],
      [
        u.turnVisualize(C, 12),
        { format: "opaque", family: "turnVisualize", userId: U, chatId: C, ord: 12 },
      ],
      [u.chatTitle(C), { format: "opaque", family: "chatTitle", userId: U, chatId: C }],
      [u.conversation(C), { format: "opaque", family: "conversation", userId: U, chatId: C }],
      [
        `${u.conversation(C)}~3`,
        { format: "opaque", family: "conversation", userId: U, chatId: C },
      ],
    ];
    for (const [id, want] of cases) expect(opaqueIds.parse(id)).toEqual(want);
    expect(opaqueIds.parseLineage(u.documentLineage(D))).toEqual({
      format: "opaque",
      family: "documentLineage",
      userId: U,
      documentId: D,
    });
    expect(opaqueIds.parseLineage(u.turnLineage(C, 5))).toEqual({
      format: "opaque",
      family: "turnLineage",
      userId: U,
      chatId: C,
      ord: 5,
    });
  });

  it("old format parses with no instance installed", () => {
    expect(opaqueIds.current()).toBeUndefined();
    expect(opaqueIds.parse(legacyIds.ingest(U, D, 2))).toEqual({
      format: "legacy",
      family: "ingest",
      userId: U,
      documentId: D,
      generation: 2,
    });
    expect(opaqueIds.parse(legacyIds.visualize(U, D, 1, 3))).toEqual({
      format: "legacy",
      family: "visualize",
      userId: U,
      documentId: D,
      generation: 1,
      rerun: 3,
    });
    expect(opaqueIds.parse(legacyIds.suggestTags(U, D, 2))).toMatchObject({
      family: "suggestTags",
      rerun: 2,
    });
    expect(opaqueIds.parse(legacyIds.turnVisualize(U, C, 9))).toEqual({
      format: "legacy",
      family: "turnVisualize",
      userId: U,
      chatId: C,
      ord: 9,
    });
    expect(opaqueIds.parse(legacyIds.chatTitle(U, C))).toMatchObject({
      family: "chatTitle",
      chatId: C,
    });
    expect(opaqueIds.parse(`${legacyIds.conversation(U, C)}~2`)).toMatchObject({
      family: "conversation",
      userId: U,
    });
    expect(opaqueIds.parseLineage(legacyIds.documentLineage(U, D))).toMatchObject({
      documentId: D,
    });
    expect(opaqueIds.parseLineage(legacyIds.turnLineage(U, C, 4))).toMatchObject({ ord: 4 });
  });

  it("the old forms keep their exact text (the pre-deploy runs must stay readable)", () => {
    expect(legacyIds.ingest(U, D, 2)).toBe(`u_${U}:ingest-${D}.2`);
    expect(legacyIds.ingest(U, D, 1)).toBe(`u_${U}:ingest-${D}`);
    expect(legacyIds.visualize(U, D, 3, 2)).toBe(`u_${U}:visualize-${D}.3-r2`);
    expect(legacyIds.conversation(U, C)).toBe(`u_${U}.c-${C}`);
    expect(legacyIds.documentLineage(U, D)).toBe(`visuals-${U}-${D}`);
  });

  it("a new-format id is short and carries no uuid, user or document text", async () => {
    const { userIds: u } = await userIds();
    for (const id of [
      u.ingest(D, 2),
      u.visualize(D, 2, 999),
      u.turnVisualize(C, 999999999999999, 999),
      u.conversation(C),
      u.documentLineage(D),
    ]) {
      expect(Buffer.byteLength(id)).toBeLessThan(140);
      expect(Buffer.byteLength(id)).toBeLessThanOrEqual(MAX_EXECUTION_ID_BYTES);
      expect(id).not.toContain(U);
      expect(id).not.toContain(D);
      expect(id).not.toContain(C);
      expect(id).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    }
  });

  it("refuses bad inputs", async () => {
    const { userIds: u } = await userIds();
    expect(() => u.ingest("not-a-uuid", 2)).toThrow(RangeError);
    expect(() => u.ingest(D, 0)).toThrow(RangeError);
    expect(() => u.visualize(D, 1_000_000_000)).toThrow(RangeError);
    expect(() => u.visualize(D, 1, 1000)).toThrow(RangeError);
    expect(() => u.turnVisualize(C, 0)).toThrow(RangeError);
    expect(() => legacyIds.ingest("nope", D, 1)).toThrow(RangeError);
  });
});

describe("parse answers null, never a wrong id", () => {
  it("an unknown handle, a cold cache and a tampered token", async () => {
    const { ids, userIds: u } = await userIds();
    const id = u.ingest(D, 2);
    expect(opaqueIds.parse(id)).toBeNull(); // not installed: a cold cache
    opaqueIds.install(ids);
    expect(opaqueIds.parse(id)).toMatchObject({ documentId: D });
    ids.forget(U);
    expect(opaqueIds.parse(id)).toBeNull(); // the user is forgotten (erased)
    const other = testOpaqueIds();
    other.store.add(U2, T);
    await other.ids.ensureUser({ tenantId: T, userId: U2 });
    opaqueIds.install(other.ids);
    expect(opaqueIds.parse(id)).toBeNull();
  });

  it("a token of the wrong family or from another user fails authentication", async () => {
    const { ids, userIds: u } = await userIds();
    opaqueIds.install(ids);
    const doc = u.ingest(D, 2);
    const asChat = doc.replace(":ingest-", ":chat-title-").replace(/\.2$/, "");
    expect(opaqueIds.parse(asChat)).toBeNull();
    const swapped = doc.replace(/ingest-[a-z2-7]{52}/, `ingest-${"a".repeat(52)}`);
    expect(opaqueIds.parse(swapped)).toBeNull();
  });

  it("a value has one spelling: a handle or token whose padding bits are not zero is not an id", async () => {
    const { userIds: u } = await userIds();
    const good = u.ingest(D, 2);
    expect(opaqueIds.clear(good)).not.toBeNull();
    const [head, token] = good.split(":ingest-") as [string, string];
    // The last character of a handle must be one of a e i m q u y 4, of a token a or q: "b" is a second spelling of "a".
    expect(opaqueIds.clear(`${head.slice(0, -1)}b:ingest-${token}`)).toBeNull();
    expect(opaqueIds.clear(`${head}:ingest-${token.replace(/.(\.2)$/, "b$1")}`)).toBeNull();
    expect(opaqueIds.clear(`h_${"a".repeat(25)}a:ingest-${"a".repeat(51)}a.2`)).not.toBeNull();
    expect(opaqueIds.clear(`h_${"a".repeat(25)}b:ingest-${"a".repeat(51)}a.2`)).toBeNull();
    expect(opaqueIds.clear(`h_${"a".repeat(26)}:ingest-${"a".repeat(51)}b.2`)).toBeNull();
  });

  it("an id that is neither format", () => {
    for (const id of [
      "",
      "u_x",
      `u_${U}:ingest-nope`,
      `h_short:ingest-${"a".repeat(52)}`,
      "x:1",
      `u_${D.toUpperCase()}:ingest-${D}`,
    ])
      expect(opaqueIds.parse(id)).toBeNull();
  });
});

describe("classification and the subject never need the key", () => {
  it("family and subjectOf work on a cold cache", async () => {
    const { userIds: u } = await userIds();
    expect(opaqueIds.current()).toBeUndefined();
    expect(opaqueIds.family(u.ingest(D, 2))).toBe("ingest");
    expect(opaqueIds.family(u.turnVisualize(C, 3))).toBe("turnVisualize");
    expect(opaqueIds.family(legacyIds.suggestTags(U, D, 1))).toBe("suggestTags");
    expect(opaqueIds.subjectOf(u.ingest(D, 2))).toBe(`h_${u.handle}`);
    expect(opaqueIds.subjectOf(u.conversation(C))).toBe(`h_${u.handle}`);
    expect(opaqueIds.subjectOf(legacyIds.ingest(U, D, 2))).toBe(U);
    expect(opaqueIds.subjectOf(`__loom_ui_lineage__:${u.documentLineage(D)}`)).toBe(
      `h_${u.handle}`,
    );
    expect(opaqueIds.subjectOf(`__loom_ui_lineage__:${legacyIds.turnLineage(U, C, 2)}`)).toBe(U);
    expect(opaqueIds.subjectOf("__loom_ui_lineage__:visuals-garbage")).toBe("");
    expect(opaqueIds.subjectOf("stray")).toBe("x:stray");
    expect(opaqueIds.handleOf(u.ingest(D, 2))).toBe(u.handle);
    expect(opaqueIds.handleOf(legacyIds.ingest(U, D, 2))).toBeNull();
  });
});

describe("the cache: ensureUser, ensureHandle, warm, forget", () => {
  it("ensureUser mints the handle once, stores it, and a second process re-reads the same one", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    const first = await t.ids.ensureUser({ tenantId: T, userId: U });
    expect(t.store.rows.get(U)?.handle).toBe(first.handle);
    const again = new OpaqueIds(t.keys, t.store);
    expect((await again.ensureUser({ tenantId: T, userId: U })).handle).toBe(first.handle);
    expect(first.ingest(D, 2)).toBe(
      (await again.ensureUser({ tenantId: T, userId: U })).ingest(D, 2),
    );
  });

  it("concurrent ensureUser calls share one derivation", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    let claims = 0;
    const claim = t.store.claim.bind(t.store);
    t.store.claim = async (...a) => {
      claims += 1;
      return claim(...a);
    };
    const [a, b] = await Promise.all([
      t.ids.ensureUser({ tenantId: T, userId: U }),
      t.ids.ensureUser({ tenantId: T, userId: U }),
    ]);
    expect(a.handle).toBe(b.handle);
    expect(claims).toBe(1);
  });

  it("refuses a stored handle that is not the derived one", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T, "a".repeat(26));
    await expect(t.ids.ensureUser({ tenantId: T, userId: U })).rejects.toMatchObject({
      name: "HandleMismatchError",
    });
  });

  it("a destroyed key is FieldKeyUnavailableError, and nothing falls back to an old-format id", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    await t.keys.getOrCreate(U);
    await t.keys.destroy(U);
    await expect(t.ids.ensureUser({ tenantId: T, userId: U })).rejects.toBeInstanceOf(
      FieldKeyUnavailableError,
    );
  });

  it("key errors from the handle store pass through guarded unchanged (not a retryable store outage)", async () => {
    for (const make of [() => new FieldKeyUnavailableError(), () => new FieldKeyStoreError()]) {
      const t = testOpaqueIds();
      t.store.add(U, T);
      t.store.claim = async () => {
        throw make();
      };
      await expect(t.ids.ensureUser({ tenantId: T, userId: U })).rejects.toBeInstanceOf(
        make().constructor as new () => Error,
      );
    }
  });

  it("ensureHandle fills a cold cache from the store and never mints a key", async () => {
    const warm = await userIds();
    const cold = new OpaqueIds(warm.keys, warm.store);
    opaqueIds.install(cold);
    const id = warm.userIds.ingest(D, 2);
    expect(opaqueIds.parse(id)).toBeNull();
    expect(await opaqueIds.ensure(warm.userIds.handle)).toBe(true);
    expect(opaqueIds.parse(id)).toMatchObject({ userId: U, documentId: D, generation: 2 });
    expect(await opaqueIds.ensure("e".repeat(26))).toBe(false); // nobody holds it
    warm.store.add(U2, T, "i".repeat(26));
    expect(await opaqueIds.ensure("i".repeat(26))).toBe(false); // a user with no key: not minted
    expect(await warm.keys.get(U2)).toBeNull();
  });

  it("warm loads every user with a handle and skips a destroyed key", async () => {
    const t = testOpaqueIds();
    const users = Array.from(
      { length: WARM_CONCURRENCY + 3 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    for (const u of users) {
      t.store.add(u, T);
      await t.ids.ensureUser({ tenantId: T, userId: u });
    }
    const gone = users[1] as string;
    await t.keys.destroy(gone);
    const cold = new OpaqueIds(t.keys, t.store);
    expect(await cold.warm()).toBe(users.length - 1);
    expect(cold.cached(users[0] as string)).toBeDefined();
    expect(cold.cached(gone)).toBeUndefined();
  });

  it("warm crosses page boundaries, and one user with a mismatched handle is skipped and counted, not fatal", async () => {
    const t = testOpaqueIds();
    const users = Array.from(
      { length: 5 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    for (const u of users) {
      t.store.add(u, T);
      await t.ids.ensureUser({ tenantId: T, userId: u });
    }
    const bad = "00000000-0000-4000-8000-000000000099";
    t.store.add(bad, T, "a".repeat(26)); // a handle its key does not derive
    await t.keys.getOrCreate(bad);
    let pages = 0;
    const page = t.store.page.bind(t.store);
    t.store.page = async (...a) => {
      pages += 1;
      return page(...a);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cold = new OpaqueIds(t.keys, t.store, { warmPage: 2 });
    expect(await cold.warm()).toBe(5);
    expect(pages).toBe(4); // 6 users with a handle at 2 per page: three full pages, then the empty page that ends the walk
    expect(warn).toHaveBeenCalledWith("id keys: users skipped at warm-up", {
      reason: "HandleMismatchError",
      count: 1,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(bad);
    for (const u of users) expect(cold.cached(u)).toBeDefined();
    expect(cold.cached(bad)).toBeUndefined();
    warn.mockRestore();
  });

  it("forget drops both directions", async () => {
    const { ids, userIds: u } = await userIds();
    opaqueIds.install(ids);
    const id = u.ingest(D, 2);
    ids.forget(U);
    expect(ids.cached(U)).toBeUndefined();
    expect(opaqueIds.parse(id)).toBeNull();
  });
});

describe("clear fields, load and forgetSubject", () => {
  it("clear reads family, generation, run and ordinal in both formats with no cache", async () => {
    const { userIds: u } = await userIds();
    expect(opaqueIds.current()).toBeUndefined();
    expect(opaqueIds.clear(u.visualize(D, 3, 2))).toEqual({
      family: "visualize",
      generation: 3,
      rerun: 2,
    });
    expect(opaqueIds.clear(legacyIds.visualize(U, D, 3, 2))).toEqual({
      family: "visualize",
      generation: 3,
      rerun: 2,
    });
    expect(opaqueIds.clear(u.turnVisualize(C, 8))).toEqual({ family: "turnVisualize", ord: 8 });
    expect(opaqueIds.clear("nope")).toBeNull();
  });

  it("load reads an existing handle and never mints one", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    expect(await t.ids.load({ tenantId: T, userId: U })).toBe(false); // no handle yet: old-format ids only
    expect(await t.keys.get(U)).toBeNull(); // and no key was minted
    const minted = await t.ids.ensureUser({ tenantId: T, userId: U });
    const cold = new OpaqueIds(t.keys, t.store);
    expect(await cold.load({ tenantId: T, userId: U })).toBe(true);
    expect(cold.knows(minted.handle)).toBe(true);
  });

  it("forgetSubject drops a user by UUID or by h_<handle>", async () => {
    const { ids, userIds: u } = await userIds();
    ids.forgetSubject(`h_${u.handle}`);
    expect(ids.cached(U)).toBeUndefined();
    await ids.ensureUser({ tenantId: T, userId: U });
    ids.forgetSubject(U);
    expect(ids.knows(u.handle)).toBe(false);
  });
});

describe("a handle whose h_ subject key is destroyed", () => {
  const ctx = async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    const u = await t.ids.ensureUser({ tenantId: T, userId: U });
    await t.keys.destroy(`h_${u.handle}`); // the user's data key stays alive: the erasure destroys them in turn
    return { t, handle: u.handle };
  };
  const refuses = async (t: ReturnType<typeof testOpaqueIds>, handle: string) => {
    const cold = new OpaqueIds(t.keys, t.store); // a restart
    expect(await cold.load({ tenantId: T, userId: U })).toBe(false);
    expect(await cold.ensureHandle(handle)).toBeNull();
    expect(await cold.warm()).toBe(0);
    expect(cold.cached(U)).toBeUndefined();
    await expect(cold.ensureUser({ tenantId: T, userId: U })).rejects.toBeInstanceOf(
      FieldKeyUnavailableError,
    );
    expect(cold.cached(U)).toBeUndefined();
  };

  it("is refused by a fresh instance (load, ensureHandle, warm, ensureUser)", async () => {
    const { t, handle } = await ctx();
    await refuses(t, handle);
  });

  it("is still refused after more than an hour", async () => {
    vi.useFakeTimers();
    try {
      const { t, handle } = await ctx();
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      await refuses(t, handle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is still refused after 1000+ other misses evict any in-memory note", async () => {
    const { t, handle } = await ctx();
    const ids = new OpaqueIds(t.keys, t.store);
    expect(await ids.ensureHandle(handle)).toBeNull();
    for (let i = 0; i < 1100; i++) await ids.ensureHandle(`${String(i).padStart(25, "b")}a`);
    expect(await ids.ensureHandle(handle)).toBeNull();
    expect(await ids.load({ tenantId: T, userId: U })).toBe(false);
    await expect(ids.ensureUser({ tenantId: T, userId: U })).rejects.toBeInstanceOf(
      FieldKeyUnavailableError,
    );
  });

  it("forgetSubject keeps no note: the key store is the only source", async () => {
    const { ids, userIds: u } = await userIds();
    ids.forgetSubject(`h_${u.handle}`);
    // The h_ key is not destroyed here, so nothing refuses a reload.
    expect(await ids.load({ tenantId: T, userId: U })).toBe(true);
  });
});

describe("a key store that fails the destroyed check", () => {
  class FlakyStore extends InMemoryKeyStore {
    down = false;
    override async wasDestroyed(subjectId: string) {
      if (this.down && subjectId.startsWith("h_")) throw new Error(`down: ${subjectId}`);
      return super.wasDestroyed(subjectId);
    }
  }
  it("surfaces FieldKeyStoreError from load, ensureHandle and warm, refuses ensureUser, and caches nothing", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    const keys = new FlakyStore();
    const handleOf = (await new OpaqueIds(keys, t.store).ensureUser({ tenantId: T, userId: U }))
      .handle;
    const cold = new OpaqueIds(keys, t.store);
    keys.down = true;
    const bad = (e: unknown) => expect(e).toBeInstanceOf(FieldKeyStoreError);
    await cold.load({ tenantId: T, userId: U }).then(() => expect.fail("no throw"), bad);
    await cold.ensureHandle(handleOf).then(() => expect.fail("no throw"), bad);
    await cold.warm().then(() => expect.fail("no throw"), bad);
    await cold.ensureUser({ tenantId: T, userId: U }).then(() => expect.fail("no throw"), bad);
    expect(cold.cached(U)).toBeUndefined();
    expect(cold.knows(handleOf)).toBe(false);
    // Back up: the same instance works (the failure was not remembered as a retirement).
    keys.down = false;
    expect(await cold.load({ tenantId: T, userId: U })).toBe(true);
  });
});

describe("the test id source", () => {
  it("builds the ids a test can compute without awaiting: deterministicUser equals what ensureUser gives", async () => {
    const ids = testIdSource();
    const built = await ids.ensureUser({ tenantId: T, userId: U });
    const computed = deterministicUser(U);
    expect(computed.handle).toBe(built.handle);
    expect(computed.ingest(D, 2)).toBe(built.ingest(D, 2));
    expect(deterministicUser(U2).handle).not.toBe(computed.handle);
  });
});

class GatedKeyStore extends InMemoryKeyStore {
  gate: Promise<void> | undefined;
  failWith: Error | undefined;
  override async getOrCreate(subjectId: string) {
    const dek = await super.getOrCreate(subjectId);
    if (this.failWith) throw this.failWith;
    await this.gate;
    return dek;
  }
  override async get(subjectId: string) {
    const dek = await super.get(subjectId);
    if (this.failWith) throw this.failWith;
    await this.gate;
    return dek;
  }
}

function gatedIds() {
  const keys = new GatedKeyStore();
  const store = new (
    testOpaqueIds().store.constructor as new () => ReturnType<typeof testOpaqueIds>["store"]
  )();
  store.add(U, T);
  return { keys, store, ids: new OpaqueIds(keys, store) };
}

describe("review fixes", () => {
  it("forget during an in-flight ensureUser: nothing is cached afterwards (1)", async () => {
    const g = gatedIds();
    let open: () => void = () => {};
    g.keys.gate = new Promise<void>((r) => {
      open = r;
    });
    const pending = g.ids.ensureUser({ tenantId: T, userId: U });
    const settled = pending.then(
      () => "ok",
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 5));
    g.ids.forget(U);
    open();
    expect(await settled).toBeInstanceOf(FieldKeyUnavailableError);
    expect(g.ids.cached(U)).toBeUndefined();
  });

  it("forget during an in-flight ensureHandle: nothing is cached afterwards (1)", async () => {
    const keys = new GatedKeyStore();
    const t = testOpaqueIds();
    t.store.add(U, T);
    const first = new OpaqueIds(keys, t.store);
    const minted = await first.ensureUser({ tenantId: T, userId: U });
    const cold = new OpaqueIds(keys, t.store);
    let open: () => void = () => {};
    keys.gate = new Promise<void>((r) => {
      open = r;
    });
    const pending = cold.ensureHandle(minted.handle);
    await new Promise((r) => setTimeout(r, 5));
    cold.forget(U);
    open();
    expect(await pending).toBeNull();
    expect(cold.cached(U)).toBeUndefined();
    expect(cold.knows(minted.handle)).toBe(false);
  });

  it("a key-store outage is FieldKeyStoreError with no user text, never a fallback (2)", async () => {
    const g = gatedIds();
    g.keys.failWith = new Error(`kek down ${U}`);
    const err = await g.ids.ensureUser({ tenantId: T, userId: U }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(FieldKeyStoreError);
    expect(String((err as Error).message)).not.toContain(U);
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(g.ids.cached(U)).toBeUndefined();

    // ensureHandle and warm: a stored handle, then the key store fails.
    g.keys.failWith = undefined;
    const minted = await g.ids.ensureUser({ tenantId: T, userId: U });
    const cold = new OpaqueIds(g.keys, g.store);
    g.keys.failWith = new Error(`kek down ${U}`);
    const e2 = await cold.ensureHandle(minted.handle).catch((e: Error) => e);
    expect(e2).toBeInstanceOf(FieldKeyStoreError);
    expect(String((e2 as Error).message)).not.toContain(U);
    const e3 = await cold.warm().catch((e: Error) => e);
    expect(e3).toBeInstanceOf(FieldKeyStoreError);
    expect(cold.cached(U)).toBeUndefined();
  });

  it("an opaque generation suffix is .2 and up: .1 is not an id (3)", async () => {
    const { ids, userIds: u } = await userIds();
    opaqueIds.install(ids);
    expect(opaqueIds.parse(`${u.ingest(D, 1)}.1`)).toBeNull();
    expect(opaqueIds.parse(`${u.visualize(D, 1)}.1`)).toBeNull();
    expect(opaqueIds.parse(u.ingest(D, 2))).toMatchObject({ generation: 2 });
    expect(opaqueIds.parse(u.ingest(D, 10))).toMatchObject({ generation: 10 });
    expect(opaqueIds.parse(`u_${U}:ingest-${D}.1`)).toMatchObject({ generation: 1 });
  });

  it("store errors are fixed-message HandleStoreError; a collision is HandleMismatchError (4)", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    t.store.claim = async () => {
      throw new Error(`boom h ${U}`);
    };
    const e1 = await t.ids.ensureUser({ tenantId: T, userId: U }).catch((e: Error) => e);
    expect(e1).toBeInstanceOf(HandleStoreError);
    expect((e1 as Error).message).not.toContain(U);
    expect((e1 as Error & { cause?: unknown }).cause).toBeUndefined();

    t.store.claim = async () => {
      throw Object.assign(new Error("duplicate key (id_handle)=(x)"), { code: "23505" });
    };
    await expect(t.ids.ensureUser({ tenantId: T, userId: U })).rejects.toBeInstanceOf(
      HandleMismatchError,
    );

    const other = testOpaqueIds();
    other.store.userOf = async () => {
      throw new Error("sql text");
    };
    other.store.read = async () => {
      throw new Error("sql text");
    };
    other.store.page = async () => {
      throw new Error("sql text");
    };
    await expect(other.ids.ensureHandle("a".repeat(26))).rejects.toBeInstanceOf(HandleStoreError);
    await expect(other.ids.load({ tenantId: T, userId: U })).rejects.toBeInstanceOf(
      HandleStoreError,
    );
    await expect(other.ids.warm()).rejects.toBeInstanceOf(HandleStoreError);
  });

  it("ensureHandle checks the shape first and remembers an absent handle (5)", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    let lookups = 0;
    const userOf = t.store.userOf.bind(t.store);
    t.store.userOf = async (h) => {
      lookups += 1;
      return userOf(h);
    };
    expect(await t.ids.ensureHandle("not a handle")).toBeNull();
    expect(await t.ids.ensureHandle(`${"a".repeat(25)}b`)).toBeNull(); // padding bits
    expect(lookups).toBe(0);
    const absent = "e".repeat(26);
    expect(await t.ids.ensureHandle(absent)).toBeNull();
    expect(await t.ids.ensureHandle(absent)).toBeNull();
    expect(lookups).toBe(1);
  });

  it("minting a user clears the recorded miss of their handle (5)", async () => {
    const keys = new InMemoryKeyStore();
    const other = new OpaqueIds(keys, testOpaqueIds().store);
    const handle = (await other.ensureUser({ tenantId: T, userId: U })).handle;
    const t = testOpaqueIds();
    const ids = new OpaqueIds(keys, t.store);
    t.store.add(U, T);
    expect(await ids.ensureHandle(handle)).toBeNull(); // recorded as a miss
    await ids.ensureUser({ tenantId: T, userId: U }); // claims the handle: clears the miss
    ids.forget(U);
    expect((await ids.ensureHandle(handle))?.handle).toBe(handle);
  });

  it("a handle whose user has no key is recorded as a miss: later calls skip the store and the key store (5)", async () => {
    const keys = new GatedKeyStore();
    const t = testOpaqueIds();
    t.store.add(U, T);
    const handle = (await new OpaqueIds(keys, t.store).ensureUser({ tenantId: T, userId: U }))
      .handle;
    await keys.destroy(U);
    let lookups = 0;
    let reads = 0;
    const userOf = t.store.userOf.bind(t.store);
    t.store.userOf = async (h) => {
      lookups += 1;
      return userOf(h);
    };
    const get = keys.get.bind(keys);
    keys.get = async (s) => {
      reads += 1;
      return get(s);
    };
    const cold = new OpaqueIds(keys, t.store);
    expect(await cold.ensureHandle(handle)).toBeNull();
    expect(await cold.ensureHandle(handle)).toBeNull();
    expect([lookups, reads]).toEqual([1, 1]);
  });

  it("forgetSubject of an h_ subject guards an in-flight ensureHandle that has not cached yet (2)", async () => {
    const keys = new GatedKeyStore();
    const t = testOpaqueIds();
    t.store.add(U, T);
    const minted = await new OpaqueIds(keys, t.store).ensureUser({ tenantId: T, userId: U });
    const cold = new OpaqueIds(keys, t.store);
    let open: () => void = () => {};
    keys.gate = new Promise<void>((r) => {
      open = r;
    });
    const pending = cold.ensureHandle(minted.handle);
    await new Promise((r) => setTimeout(r, 5));
    cold.forgetSubject(`h_${minted.handle}`);
    open();
    expect(await pending).toBeNull();
    expect(cold.cached(U)).toBeUndefined();
    expect(cold.knows(minted.handle)).toBe(false);
  });

  it("forget keeps no per-user state once nothing is in flight (3)", async () => {
    const { ids } = await userIds();
    for (let i = 0; i < 50; i++)
      ids.forget(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    ids.forgetSubject(`h_${"a".repeat(26)}`);
    expect((ids as unknown as { fetches: Map<string, unknown> }).fetches.size).toBe(0);
  });

  it("a user id stays strict, a document or chat id is lower-cased (4)", () => {
    const hexUser = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(() => legacyIds.ingest(hexUser.toUpperCase(), D, 2)).toThrow(RangeError);
    expect(() => legacyIds.conversation(hexUser.toUpperCase(), C)).toThrow(RangeError);
    expect(legacyIds.ingest(U, D.toUpperCase(), 2)).toBe(legacyIds.ingest(U, D, 2));
  });

  it("handleOf and handleOfId strip the lineage stream prefix like subjectOf (6)", async () => {
    const { ids, userIds: u } = await userIds();
    const line = `__loom_ui_lineage__:${u.documentLineage(D)}`;
    expect(opaqueIds.handleOf(line)).toBe(u.handle);
    expect(ids.handleOfId(line)).toBe(u.handle);
    expect(opaqueIds.handleOf(`__loom_ui_lineage__:${legacyIds.documentLineage(U, D)}`)).toBeNull();
  });

  it("the builders lower-case a UUID input (7)", async () => {
    const { userIds: u } = await userIds();
    expect(u.ingest(D.toUpperCase(), 2)).toBe(u.ingest(D, 2));
    expect(u.chatTitle(C.toUpperCase())).toBe(u.chatTitle(C));
    expect(legacyIds.suggestTags(U, D.toUpperCase(), 1)).toBe(legacyIds.suggestTags(U, D, 1));
  });
});
