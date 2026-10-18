import { mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterAll, describe, expect, it } from "vitest";
import { EncryptedFsContentStore } from "./EncryptedFsContentStore";
import { eraseUserBlobs, removeStaleTemp } from "./maintenance";
import { cleanupRoots, freshRoot } from "./testing/tempRoot";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const B = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
afterAll(cleanupRoots);

describe("eraseUserBlobs", () => {
  it("removes one user's blobs, leaves the neighbour's, and is idempotent", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const a = new EncryptedFsContentStore({ root, tenantId: T, userId: A, keys });
    const b = new EncryptedFsContentStore({ root, tenantId: T, userId: B, keys });
    const refA = await a.put(new TextEncoder().encode("a's file"));
    const refB = await b.put(new TextEncoder().encode("b's file"));

    await eraseUserBlobs(root, T, A);
    await eraseUserBlobs(root, T, A);

    expect(await a.get(refA)).toBeNull();
    expect(await b.get(refB)).not.toBeNull();
  });

  it("refuses ids that are not canonical UUIDs, so a path can never be built from them", async () => {
    const root = freshRoot();
    for (const [t, u] of [
      ["..", A],
      [T, "../.."],
      [T, A.toUpperCase()],
      [`${T}/x`, A],
    ] as const) {
      await expect(eraseUserBlobs(root, t, u)).rejects.toThrow(/UUID/);
    }
    await expect(eraseUserBlobs("relative/dir", T, A)).rejects.toThrow(/absolute/);
  });
});

describe("removeStaleTemp", () => {
  it("removes only old .tmp- files and keeps finished blobs", async () => {
    const root = freshRoot();
    const dir = join(root, T, A);
    mkdirSync(dir, { recursive: true });
    const old = join(dir, ".tmp-old");
    const fresh = join(dir, ".tmp-fresh");
    const blob = join(dir, "a".repeat(64));
    for (const f of [old, fresh, blob]) writeFileSync(f, "x");
    utimesSync(old, 1, 1); // 1970
    utimesSync(blob, 1, 1); // an old committed blob must survive too
    const removed = await removeStaleTemp(root, 60_000, Date.now());
    expect(removed).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([".tmp-fresh", "a".repeat(64)].sort());
  });

  it("removes the temp file a real stage() leaves behind", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const store = new EncryptedFsContentStore({ root, tenantId: T, userId: A, keys });
    const staged = await store.stage(
      (async function* () {
        yield new TextEncoder().encode("crash before commit");
      })(),
    );
    const [tmp] = readdirSync(store.userDir);
    expect(tmp).toMatch(/^\.tmp-/);
    utimesSync(join(store.userDir, tmp as string), 1, 1);
    expect(await removeStaleTemp(root, 1, Date.now())).toBe(1);
    expect(readdirSync(store.userDir)).toEqual([]);
    await staged.discard();
  });

  it("ignores directories that are not <uuid>/<uuid>", async () => {
    const root = freshRoot();
    mkdirSync(join(root, "lost+found"), { recursive: true });
    writeFileSync(join(root, "lost+found", ".tmp-x"), "x");
    utimesSync(join(root, "lost+found", ".tmp-x"), 1, 1);
    mkdirSync(join(root, T, "not-a-uuid"), { recursive: true });
    writeFileSync(join(root, T, "not-a-uuid", ".tmp-x"), "x");
    utimesSync(join(root, T, "not-a-uuid", ".tmp-x"), 1, 1);
    expect(await removeStaleTemp(root, 1, Date.now())).toBe(0);
    expect(readdirSync(join(root, "lost+found"))).toEqual([".tmp-x"]);
    expect(readdirSync(join(root, T, "not-a-uuid"))).toEqual([".tmp-x"]);
  });

  it("never follows symlinks and never removes a symlinked .tmp- entry", async () => {
    const root = freshRoot();
    const outside = freshRoot();
    writeFileSync(join(outside, ".tmp-victim"), "x");
    utimesSync(join(outside, ".tmp-victim"), 1, 1);
    // symlinked user dir inside a real tenant dir, and a symlinked tenant dir
    mkdirSync(join(root, T), { recursive: true });
    symlinkSync(outside, join(root, T, A));
    symlinkSync(outside, join(root, B));
    // symlinked temp entry inside a real user dir
    const dir = join(root, T, B);
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(outside, ".tmp-victim"), join(dir, ".tmp-link"));
    expect(await removeStaleTemp(root, 1, Date.now())).toBe(0);
    expect(readdirSync(outside)).toEqual([".tmp-victim"]);
    expect(readdirSync(dir)).toEqual([".tmp-link"]);
  });

  it("rejects a relative root", async () => {
    await expect(removeStaleTemp("relative/dir", 1)).rejects.toThrow(/absolute/);
  });
});
