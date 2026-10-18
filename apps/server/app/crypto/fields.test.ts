import { InMemoryKeyStore, type KeyStore, encryptValue } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { FieldCrypto, FieldKeyStoreError, FieldKeyUnavailableError } from "./fields";

const U1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const U2 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

describe("FieldCrypto", () => {
  it("round-trips text and JSON, and the stored form holds neither", async () => {
    const fields = new FieldCrypto(new InMemoryKeyStore());
    const cipher = fields.forUser(U1);
    const title = await cipher.seal("document:d1:title", "Tax return 2025");
    expect(JSON.stringify(title)).not.toContain("Tax");
    expect(await cipher.openText("document:d1:title", title)).toBe("Tax return 2025");
    const summary = await cipher.seal("document:d1:summary", { tldr: "private" });
    expect(JSON.stringify(summary)).not.toContain("private");
    expect(await cipher.open("document:d1:summary", summary)).toEqual({ tldr: "private" });
  });

  it("does not open an envelope moved to another column, row or user", async () => {
    const fields = new FieldCrypto(new InMemoryKeyStore());
    const sealed = await fields.forUser(U1).seal("document:d1:title", "secret");
    await expect(fields.forUser(U1).open("document:d1:filename", sealed)).rejects.toThrow(
      /authenticate/,
    );
    await expect(fields.forUser(U1).open("document:d2:title", sealed)).rejects.toThrow(
      /authenticate/,
    );
    await fields.forUser(U2).seal("document:d1:title", "other"); // U2 gets a key of their own
    await expect(fields.forUser(U2).open("document:d1:title", sealed)).rejects.toThrow(
      /authenticate/,
    );
  });

  it("refuses a value that is not an envelope instead of passing it through", async () => {
    const cipher = new FieldCrypto(new InMemoryKeyStore()).forUser(U1);
    await cipher.seal("b", "x"); // make sure a key exists
    await expect(cipher.open("b", "plain text in the column")).rejects.toThrow(/envelope/);
    await expect(cipher.openText("b", { not: "an envelope" })).rejects.toThrow(/envelope/);
    await expect(cipher.open("b", null)).rejects.toThrow(/envelope/);
  });

  it("refuses an envelope sealed without the field binding", async () => {
    const keys = new InMemoryKeyStore();
    const cipher = new FieldCrypto(keys).forUser(U1);
    const unbound = encryptValue(await keys.getOrCreate(U1), "x");
    await expect(cipher.open("b", unbound)).rejects.toThrow(/envelope/);
  });

  it("openText refuses a sealed value that is not text", async () => {
    const cipher = new FieldCrypto(new InMemoryKeyStore()).forUser(U1);
    const sealed = await cipher.seal("b", { a: 1 });
    await expect(cipher.openText("b", sealed)).rejects.toThrow(/not text/);
  });

  it("cannot open anything once the user's key is destroyed, and does not mint a new one", async () => {
    const keys = new InMemoryKeyStore();
    const fields = new FieldCrypto(keys);
    const sealed = await fields.forUser(U1).seal("b", "gone soon");
    await keys.destroy(U1);
    await expect(fields.forUser(U1).open("b", sealed)).rejects.toBeInstanceOf(
      FieldKeyUnavailableError,
    );
    const err = await fields
      .forUser(U1)
      .seal("document:d9:title", "again")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FieldKeyUnavailableError);
    expect((err as Error).message).not.toContain(U1);
    expect((err as Error).message).not.toContain("d9");
  });

  it("does not touch the key store until a field is sealed or opened, then once per cipher", async () => {
    let calls = 0;
    const keys = new InMemoryKeyStore();
    const counting: KeyStore = {
      durable: false,
      getOrCreate: (id: string) => {
        calls++;
        return keys.getOrCreate(id);
      },
      get: (id: string) => {
        calls++;
        return keys.get(id);
      },
      destroy: (id: string) => keys.destroy(id),
    };
    const cipher = new FieldCrypto(counting).forUser(U1);
    expect(calls).toBe(0);
    const a = await cipher.seal("b", 1);
    await cipher.seal("b", 2);
    expect(calls).toBe(1);
    await cipher.open("b", a);
    await cipher.open("b", a);
    expect(calls).toBe(2);
  });

  it("refuses an envelope with a truncated tag or iv, and a tampered body", async () => {
    const cipher = new FieldCrypto(new InMemoryKeyStore()).forUser(U1);
    const sealed = (await cipher.seal("b", "x")) as { tag: string; iv: string; data: string };
    const shortTag = {
      ...sealed,
      tag: Buffer.from(sealed.tag, "base64").subarray(0, 4).toString("base64"),
    };
    await expect(cipher.open("b", shortTag)).rejects.toThrow(/envelope/);
    const shortIv = {
      ...sealed,
      iv: Buffer.from(sealed.iv, "base64").subarray(0, 8).toString("base64"),
    };
    await expect(cipher.open("b", shortIv)).rejects.toThrow(/envelope/);
    const sloppy = { ...sealed, tag: `${sealed.tag}\n` };
    await expect(cipher.open("b", sloppy)).rejects.toThrow(/envelope/);
    const body = Buffer.from(sealed.data, "base64");
    body[0] = (body[0] ?? 0) ^ 1;
    const flipped = { ...sealed, data: body.toString("base64") };
    await expect(cipher.open("b", flipped)).rejects.toThrow(/authenticate/);
  });

  it("reports store failures as an id-free FieldKeyStoreError on seal and open", async () => {
    const boom = (): Promise<never> => Promise.reject(new Error(`pg down for ${U1} kek k-1`));
    const failing: KeyStore = {
      durable: false,
      getOrCreate: boom,
      get: boom,
      destroy: async () => {},
    };
    const cipher = new FieldCrypto(failing).forUser(U1);
    const good = await new FieldCrypto(new InMemoryKeyStore()).forUser(U1).seal("b", "x");
    for (const run of [() => cipher.seal("b", "x"), () => cipher.open("b", good)]) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FieldKeyStoreError);
      expect(err).not.toBeInstanceOf(FieldKeyUnavailableError);
      expect((err as Error).message).not.toContain(U1);
      expect((err as Error).message).not.toContain("k-1");
    }
  });
});
