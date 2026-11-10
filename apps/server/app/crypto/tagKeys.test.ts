import { InMemoryKeyStore, type KeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { EntityKeys } from "./entityKeys";
import { FieldKeyStoreError, FieldKeyUnavailableError } from "./fields";
import { TagKeys } from "./tagKeys";

const U1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const U2 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

describe("TagKeys", () => {
  it("gives one 32-byte hash to every spelling of a name, and creates the user's key if there is none", async () => {
    const keys = new InMemoryKeyStore(); // no key for U1 yet: a user may tag before uploading
    const a = await new TagKeys(keys).forUser(U1).nameBind("Q3 Report");
    expect(a?.length).toBe(32);
    const k = new TagKeys(keys).forUser(U1);
    expect((await k.nameBind("  q3   REPORT "))?.equals(a as Buffer)).toBe(true);
    expect((await k.nameBind("Q3 Reports"))?.equals(a as Buffer)).toBe(false);
  });

  it("separates users, and separates tags from entities for the same name", async () => {
    const keys = new InMemoryKeyStore();
    const t = new TagKeys(keys);
    const one = await t.forUser(U1).nameBind("acme");
    const two = await t.forUser(U2).nameBind("acme");
    expect(one?.equals(two as Buffer)).toBe(false);
    await keys.getOrCreate(U1);
    const entity = await new EntityKeys(keys).forUser(U1).nameKey("acme");
    expect(one?.toString("hex")).not.toBe(entity);
  });

  it("is null for a name that is not valid, and refuses once the key was destroyed", async () => {
    const keys = new InMemoryKeyStore();
    const k = new TagKeys(keys).forUser(U1);
    expect(await k.nameBind("")).toBeNull();
    await keys.getOrCreate(U1);
    await keys.destroy(U1);
    await expect(new TagKeys(keys).forUser(U1).nameBind("x")).rejects.toBeInstanceOf(
      FieldKeyUnavailableError,
    );
  });

  it("maps a key-store outage to FieldKeyStoreError without passing its message on", async () => {
    const down = {
      getOrCreate: async (subject: string) => {
        throw new Error(`boom ${subject} kek-secret`);
      },
    } as unknown as KeyStore;
    const err = await new TagKeys(down)
      .forUser(U1)
      .nameBind("x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FieldKeyStoreError);
    expect(err).not.toBeInstanceOf(FieldKeyUnavailableError);
    expect((err as Error).message).not.toContain("kek-secret");
    expect((err as Error).message).not.toContain(U1);
  });
});
