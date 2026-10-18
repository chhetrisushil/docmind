import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterAll, describe, expect, it } from "vitest";
import { EncryptedFsContentStore } from "./EncryptedFsContentStore";
import { ADDRESS_PREFIX, deriveFingerprintKey, fingerprintOf } from "./address";
import { BlobKeyUnavailableError } from "./errors";
import { cleanupRoots, freshRoot } from "./testing/tempRoot";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const OTHER_USER = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

afterAll(cleanupRoots);

const bytes = (s: string) => new TextEncoder().encode(s);

async function* once(data: Uint8Array): AsyncGenerator<Uint8Array> {
  yield data;
}

const storeAt = (root: string, keys = new InMemoryKeyStore(), userId = USER) =>
  new EncryptedFsContentStore({ root, tenantId: TENANT, userId, keys });

const fingerprintFor = async (keys: InMemoryKeyStore, userId: string, s: string) =>
  fingerprintOf(deriveFingerprintKey(await keys.getOrCreate(userId)), bytes(s));

describe("EncryptedFsContentStore layout", () => {
  it("stores ciphertext at <root>/<tenant>/<user>/<keyed fingerprint of the plaintext>", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const store = storeAt(root, keys);
    const ref = await store.put(bytes("quarterly numbers"));
    const fp = await fingerprintFor(keys, USER, "quarterly numbers");
    expect(ref.__loomContent).toBe(`${ADDRESS_PREFIX}${fp}`);
    expect(ref.size).toBe(17);
    expect(fp).not.toBe(createHash("sha256").update("quarterly numbers").digest("hex"));
    expect(readdirSync(join(root, TENANT, USER))).toEqual([fp]);
  });

  it("stores identical bytes once for one user and leaves no temp files", async () => {
    const root = freshRoot();
    const store = storeAt(root);
    await store.put(bytes("same"));
    await store.put(bytes("same"));
    expect(readdirSync(join(root, TENANT, USER))).toHaveLength(1);
  });

  it("keeps two users' copies of the same bytes apart, under different fingerprints", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const a = storeAt(root, keys, USER);
    const b = storeAt(root, keys, OTHER_USER);
    const refA = await a.put(bytes("shared words"));
    expect(await b.get(refA)).toBeNull();
    const refB = await b.put(bytes("shared words"));
    expect(refB.__loomContent).not.toBe(refA.__loomContent);
    expect(readdirSync(join(root, TENANT))).toEqual([USER, OTHER_USER].sort());
  });

  it("stage() holds nothing at the final path until commit, and discard removes the temp file", async () => {
    const root = freshRoot();
    const store = storeAt(root);
    const staged = await store.stage(once(bytes("staged")));
    expect(staged.ref.__loomContent).toBe(`${ADDRESS_PREFIX}${staged.fingerprint}`);
    expect(await store.get(staged.ref)).toBeNull();
    await staged.discard();
    expect(readdirSync(join(root, TENANT, USER))).toEqual([]);
    await expect(staged.discard()).resolves.toBeUndefined(); // idempotent
    expect(readdirSync(join(root, TENANT, USER))).toEqual([]);

    const again = await store.stage(once(bytes("staged")));
    expect(await again.commit()).toEqual({ created: true });
    expect(await store.get(again.ref)).not.toBeNull();
    await again.discard(); // no-op after commit
    expect(await store.get(again.ref)).not.toBeNull();

    const dup = await store.stage(once(bytes("staged")));
    expect(await dup.commit()).toEqual({ created: false });
    expect(readdirSync(join(root, TENANT, USER))).toHaveLength(1);
  });

  it("refuses a second commit of the same staged blob", async () => {
    const store = storeAt(freshRoot());
    const staged = await store.stage(once(bytes("once only")));
    await staged.commit();
    await expect(staged.commit()).rejects.toThrow("blob is no longer staged");
  });

  it("refuses to commit a blob after it was discarded", async () => {
    const root = freshRoot();
    const store = storeAt(root);
    const staged = await store.stage(once(bytes("discarded first")));
    await staged.discard();
    await expect(staged.commit()).rejects.toThrow("blob is no longer staged");
    expect(readdirSync(join(root, TENANT, USER))).toEqual([]);
  });

  it("throws BlobKeyUnavailableError for a stored blob whose key was destroyed, and null for an absent address", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const store = storeAt(root, keys);
    const ref = await store.put(bytes("erased later"));
    await keys.destroy(USER);
    await expect(store.get(ref)).rejects.toThrow(BlobKeyUnavailableError);
    // An address whose file was never written stays absent, whatever the key state.
    const absent = { __loomContent: `${ADDRESS_PREFIX}${"0".repeat(64)}` };
    expect(await store.get(absent)).toBeNull();
  });

  it("treats a plain sha256 address, however well formed, as absent", async () => {
    const store = storeAt(freshRoot());
    await store.put(bytes("x"));
    const plain = `sha256:${createHash("sha256").update("x").digest("hex")}`;
    expect(await store.get({ __loomContent: plain, size: 1 })).toBeNull();
  });
});
