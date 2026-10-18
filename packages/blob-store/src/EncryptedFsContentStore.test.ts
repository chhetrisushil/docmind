import { readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { runContentStoreConformance } from "@loom/conformance";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterAll, describe, expect, it } from "vitest";
import { EncryptedFsContentStore } from "./EncryptedFsContentStore";
import { BlobCorruptError, BlobTooLargeError } from "./errors";
import { cleanupRoots, freshRoot } from "./testing/tempRoot";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

afterAll(cleanupRoots);

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

const newStore = (maxBytes?: number) =>
  new EncryptedFsContentStore({
    root: freshRoot(),
    tenantId: TENANT,
    userId: USER,
    keys: new InMemoryKeyStore(),
    maxBytes,
  });

// The same contract every ContentStore owes (Loom ADR 0046), run on a fresh directory each time.
// The addresses are keyed (hmac-sha256:), which the kit accepts: it only compares them with each other.
runContentStoreConformance(() => newStore(), "EncryptedFsContentStore");

describe("EncryptedFsContentStore failure handling", () => {
  it("rejects a blob swapped to another file's name in the same user directory", async () => {
    const store = newStore();
    const a = await store.put(Buffer.from("document A"));
    const b = await store.put(Buffer.from("document B"));
    const fa = a.__loomContent.slice("hmac-sha256:".length);
    const fb = b.__loomContent.slice("hmac-sha256:".length);
    renameSync(join(store.userDir, fb), join(store.userDir, "tmp-swap"));
    renameSync(join(store.userDir, fa), join(store.userDir, fb));
    renameSync(join(store.userDir, "tmp-swap"), join(store.userDir, fa));
    await expect(store.get(a)).rejects.toThrow(BlobCorruptError);
    await expect(store.get(b)).rejects.toThrow(BlobCorruptError);
  });

  it("removes the partial temp file when the source stream throws", async () => {
    const store = newStore();
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("partial");
      throw new Error("source broke");
    }
    await expect(store.stage(failing())).rejects.toThrow("source broke");
    expect(readdirSync(store.userDir)).toEqual([]);
  });

  it("removes the partial temp file when the size cap trips", async () => {
    const store = newStore(10);
    async function* big(): AsyncGenerator<Uint8Array> {
      yield Buffer.alloc(6);
      yield Buffer.alloc(6);
    }
    await expect(store.stage(big())).rejects.toThrow(BlobTooLargeError);
    expect(readdirSync(store.userDir)).toEqual([]);
  });

  it("reports created for exactly one of two concurrent commits of the same bytes", async () => {
    const store = newStore();
    const bytes = Buffer.from("same bytes");
    const [x, y] = await Promise.all([store.stage(once(bytes)), store.stage(once(bytes))]);
    const results = await Promise.all([x.commit(), y.commit()]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(Buffer.from((await store.get(x.ref)) as Uint8Array).equals(bytes)).toBe(true);
    expect(readdirSync(store.userDir)).toEqual([x.fingerprint]);
  });

  it("rejects a non-positive-integer maxBytes", () => {
    for (const maxBytes of [Number.NaN, 0, -1, 1.5])
      expect(() => newStore(maxBytes)).toThrow("maxBytes must be a positive integer");
  });
});
