import { resolve } from "node:path";

export interface DocumentLimits {
  /** Largest single file (spec §4.3: 50 MB). */
  maxFileBytes: number;
  /** Total plaintext bytes a tenant may store. */
  tenantMaxBytes: number;
  /** Most documents a tenant may hold. */
  tenantMaxDocuments: number;
  /** Uploads one user may have in flight at once, per server process. */
  maxConcurrentUploadsPerUser: number;
}

export const DEFAULT_LIMITS: DocumentLimits = {
  maxFileBytes: 50 * 1024 * 1024,
  tenantMaxBytes: 1024 * 1024 * 1024,
  tenantMaxDocuments: 500,
  maxConcurrentUploadsPerUser: 2,
};

// Reading a blob buffers it whole, so the per-file limit has a ceiling.
const MAX_FILE_CEILING = 256 * 1024 * 1024;

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  // The message names the variable only: the value could be anything the operator typed.
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Quotas from the environment, validated at startup so a typo fails the boot, not an upload. */
export function loadLimits(env: NodeJS.ProcessEnv = process.env): DocumentLimits {
  const limits: DocumentLimits = {
    maxFileBytes: positiveInt(env, "DOCMIND_MAX_UPLOAD_BYTES", DEFAULT_LIMITS.maxFileBytes),
    tenantMaxBytes: positiveInt(env, "DOCMIND_TENANT_MAX_BYTES", DEFAULT_LIMITS.tenantMaxBytes),
    tenantMaxDocuments: positiveInt(
      env,
      "DOCMIND_TENANT_MAX_DOCUMENTS",
      DEFAULT_LIMITS.tenantMaxDocuments,
    ),
    maxConcurrentUploadsPerUser: positiveInt(
      env,
      "DOCMIND_MAX_CONCURRENT_UPLOADS",
      DEFAULT_LIMITS.maxConcurrentUploadsPerUser,
    ),
  };
  if (limits.maxFileBytes > MAX_FILE_CEILING) {
    throw new Error("DOCMIND_MAX_UPLOAD_BYTES must be at most 268435456 (256 MiB)");
  }
  return limits;
}

/** Where blobs live: `DOCMIND_BLOB_DIR`, default `./data/blobs`, always absolute. */
export function loadBlobRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.DOCMIND_BLOB_DIR?.trim() || "data/blobs");
}
