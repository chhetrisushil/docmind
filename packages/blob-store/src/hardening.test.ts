import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterAll, describe, expect, it } from "vitest";
import { EncryptedFsContentStore } from "./EncryptedFsContentStore";
import { ADDRESS_PREFIX, deriveFingerprintKey, fingerprintOf, parseAddress } from "./address";
import { BlobCorruptError } from "./errors";
import { cleanupRoots, freshRoot } from "./testing/tempRoot";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const B = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

afterAll(cleanupRoots);

const bytes = (s: string) => new TextEncoder().encode(s);

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield bytes(part);
}

const storeFor = (root: string, userId = A, keys = new InMemoryKeyStore(), maxBytes?: number) =>
  new EncryptedFsContentStore({
    root,
    tenantId: TENANT,
    userId,
    keys,
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });

// The file name a blob gets: the keyed fingerprint of its plaintext under that user's key.
const fingerprintFor = async (keys: InMemoryKeyStore, userId: string, s: string) =>
  fingerprintOf(deriveFingerprintKey(await keys.getOrCreate(userId)), bytes(s));

describe("size cap", () => {
  it("accepts a multi-chunk stream whose total is exactly maxBytes", async () => {
    const store = storeFor(freshRoot(), A, new InMemoryKeyStore(), 10);
    const ref = await store.putStream(chunks("01234", "56789"));
    expect(ref.size).toBe(10);
    expect(Buffer.from((await store.get(ref)) as Uint8Array).toString()).toBe("0123456789");
  });
});

describe("tampering and misplacement", () => {
  it("throws BlobCorruptError when a byte of the stored file was changed", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const store = storeFor(root, A, keys);
    const ref = await store.put(bytes("original"));
    const file = join(root, TENANT, A, await fingerprintFor(keys, A, "original"));
    const sealed = readFileSync(file);
    sealed[sealed.length - 20] = (sealed[sealed.length - 20] ?? 0) ^ 1;
    writeFileSync(file, sealed);
    await expect(store.get(ref)).rejects.toBeInstanceOf(BlobCorruptError);
  });

  it("will not open a file copied into another user's directory", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const a = storeFor(root, A, keys);
    const b = storeFor(root, B, keys);
    const ref = await a.put(bytes("a's secret"));
    const name = await fingerprintFor(keys, A, "a's secret");
    mkdirSync(join(root, TENANT, B), { recursive: true });
    copyFileSync(join(root, TENANT, A, name), join(root, TENANT, B, name));
    await keys.getOrCreate(B);
    await expect(b.get(ref)).rejects.toBeInstanceOf(BlobCorruptError);
  });

  it("will not open a file renamed to another address", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const store = storeFor(root, A, keys);
    await store.put(bytes("one"));
    const two = await store.put(bytes("two"));
    copyFileSync(
      join(root, TENANT, A, await fingerprintFor(keys, A, "one")),
      join(root, TENANT, A, await fingerprintFor(keys, A, "two")),
    );
    await expect(store.get(two)).rejects.toBeInstanceOf(BlobCorruptError);
  });

  it("cannot stage or put new bytes once the key is destroyed, so no fingerprint can be tested", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const store = storeFor(root, A, keys);
    await store.put(bytes("known file"));
    await keys.destroy(A);
    expect(await keys.get(A)).toBeNull(); // no data key, so no derived fingerprint key either
    const refused = "was destroyed (shredded); cannot recreate";
    await expect(store.put(bytes("known file"))).rejects.toThrow(refused);
    await expect(store.stage(chunks("known file"))).rejects.toThrow(refused);
    expect(readdirSync(join(root, TENANT, A))).toHaveLength(1); // only the blob written before erasure
  });
});

describe("hostile refs and construction", () => {
  it("never leaves the user's directory for a crafted address", async () => {
    const root = freshRoot();
    const store = storeFor(root);
    await store.put(bytes("keep me"));
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "do not touch");
    const hostile = [
      `${ADDRESS_PREFIX}../../outside.txt`,
      `${ADDRESS_PREFIX}${"A".repeat(64)}`,
      `${ADDRESS_PREFIX}${"a".repeat(63)}`,
      ADDRESS_PREFIX,
      `${ADDRESS_PREFIX}${"a".repeat(64)}/../x`,
      "../outside.txt",
    ];
    for (const address of hostile) {
      expect(parseAddress(address)).toBeNull(); // every fixture is refused by the parser itself
      expect(await store.get({ __loomContent: address, size: 0 })).toBeNull();
      await store.delete({ __loomContent: address, size: 0 });
    }
    expect(readFileSync(outside, "utf8")).toBe("do not touch");
    expect(readdirSync(join(root, TENANT, A))).toHaveLength(1);
  });

  it("rejects a relative root and ids that are not canonical lowercase UUIDs", () => {
    const keys = new InMemoryKeyStore();
    expect(() => storeFor("relative/root")).toThrow("blob root must be an absolute path");
    for (const userId of ["..", `${A}/x`, A.toUpperCase(), ""]) {
      expect(
        () => new EncryptedFsContentStore({ root: freshRoot(), tenantId: TENANT, userId, keys }),
      ).toThrow("tenantId and userId must be canonical lowercase UUIDs");
    }
  });

  it("creates private directories and files", async () => {
    if (process.platform === "win32") return;
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    await storeFor(root, A, keys).put(bytes("private"));
    expect(statSync(join(root, TENANT, A)).mode & 0o077).toBe(0);
    expect(
      statSync(join(root, TENANT, A, await fingerprintFor(keys, A, "private"))).mode & 0o077,
    ).toBe(0);
  });
});
