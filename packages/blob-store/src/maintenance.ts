import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isUuid, userDirOf } from "./paths";

/**
 * Deletes every blob a user owns (the user's whole directory). Erasure step 3 (spec §4.4): rows
 * first, then this, then the key. Removes the tenant directory when this was its last user. Idempotent; `userDirOf` checks the ids so a path can never be
 * built from anything but UUIDs.
 */
export async function eraseUserBlobs(
  root: string,
  tenantId: string,
  userId: string,
): Promise<void> {
  const userDir = userDirOf(root, tenantId, userId);
  await rm(userDir, { recursive: true, force: true });
  // The tenant directory is named by the tenant's id: it goes too once the last user's directory is gone. A
  // non-empty one (a colleague's blobs, or an upload that just landed) is left alone.
  try {
    await rmdir(dirname(userDir));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw err;
  }
}

/** Names of the entries of `dir` of one kind, or none if `dir` is gone. Symlinks are never listed. */
async function entries(dir: string, kind: "dir" | "file"): Promise<string[]> {
  try {
    const all = await readdir(dir, { withFileTypes: true });
    return all.filter((e) => (kind === "dir" ? e.isDirectory() : e.isFile())).map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}

/**
 * Removes `.tmp-*` files (what `EncryptedFsContentStore.stage()` leaves after a crash between stage
 * and commit) older than `olderThanMs` from `<root>/<uuid>/<uuid>/`. Run at startup. Entries that
 * are not real directories named by a canonical UUID, and symlinks anywhere, are skipped.
 * Returns how many files were removed.
 */
export async function removeStaleTemp(
  root: string,
  olderThanMs: number,
  now: number = Date.now(),
): Promise<number> {
  if (!isAbsolute(root)) throw new Error("blob root must be an absolute path");
  let removed = 0;
  for (const tenant of (await entries(root, "dir")).filter(isUuid)) {
    for (const user of (await entries(join(root, tenant), "dir")).filter(isUuid)) {
      const dir = join(root, tenant, user);
      for (const file of (await entries(dir, "file")).filter((n) => n.startsWith(".tmp-"))) {
        const path = join(dir, file);
        const info = await stat(path).catch(() => undefined);
        if (info?.isFile() && info.mtimeMs < now - olderThanMs) {
          await rm(path, { force: true });
          removed++;
        }
      }
    }
  }
  return removed;
}
