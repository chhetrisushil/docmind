import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shared by every blob-store test: fresh temp roots, removed by one `cleanupRoots()` in `afterAll`. */
const roots: string[] = [];

export const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "dm-blobs-"));
  roots.push(root);
  return root;
};

export const cleanupRoots = (): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
};
