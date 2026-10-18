import { isAbsolute, join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

/** True for a canonical lowercase UUID, the only form accepted as a tenant or user path segment. */
export const isUuid = (value: string): boolean => UUID.test(value);

/** Throws unless `root` is absolute and both ids are canonical lowercase UUIDs (they become path segments). */
export function assertScope(root: string, tenantId: string, userId: string): void {
  if (!isAbsolute(root)) throw new Error("blob root must be an absolute path");
  if (!isUuid(tenantId) || !isUuid(userId)) {
    throw new Error("tenantId and userId must be canonical lowercase UUIDs");
  }
}

/** `<root>/<tenantId>/<userId>`: the only directory a user's blobs live in. */
export function userDirOf(root: string, tenantId: string, userId: string): string {
  assertScope(root, tenantId, userId);
  return join(root, tenantId, userId);
}

/** `<userDir>/<fingerprint>`; the fingerprint must be 64 lowercase hex digits, so nothing else reaches a path. */
export function blobPath(userDir: string, fingerprint: string): string {
  if (!FINGERPRINT.test(fingerprint))
    throw new Error("fingerprint must be 64 lowercase hex digits");
  return join(userDir, fingerprint);
}
