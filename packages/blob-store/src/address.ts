import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** HKDF `info` for the fingerprint key. A new label (v2) is a new, unrelated key. */
export const FINGERPRINT_INFO = "docmind-fingerprint-v1";
/** Scheme of this store's content addresses. Not `sha256:`: the value is keyed, not a plain hash. */
export const ADDRESS_PREFIX = "hmac-sha256:";

const FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * The key a user's fingerprints are computed under, derived from their data key. HKDF keeps it
 * independent of the AES uses of the same data key, and destroying the data key (erasure step 4)
 * destroys it too: afterwards nobody can compute a fingerprint to test a known file against. The
 * data key is uniformly random, so an empty salt is fine. Never log or return the result.
 */
export function deriveFingerprintKey(dek: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", dek, Buffer.alloc(0), FINGERPRINT_INFO, 32));
}

/** HMAC-SHA256 of the plaintext under the user's fingerprint key, as 64 lowercase hex digits. */
export function fingerprintOf(fingerprintKey: Buffer, bytes: Uint8Array): string {
  return createHmac("sha256", fingerprintKey).update(bytes).digest("hex");
}

/** Streaming form of `fingerprintOf`: same key, same hex, fed chunk by chunk. */
export function fingerprintHasher(fingerprintKey: Buffer): {
  update(chunk: Uint8Array): void;
  digest(): string;
} {
  const hmac = createHmac("sha256", fingerprintKey);
  return {
    update: (chunk) => {
      hmac.update(chunk);
    },
    digest: () => hmac.digest("hex"),
  };
}

export const addressOf = (fingerprint: string): string => `${ADDRESS_PREFIX}${fingerprint}`;

/** The fingerprint inside an address this store could have issued, or null for anything else. */
export function parseAddress(address: string): string | null {
  if (!address.startsWith(ADDRESS_PREFIX)) return null;
  const fingerprint = address.slice(ADDRESS_PREFIX.length);
  return FINGERPRINT.test(fingerprint) ? fingerprint : null;
}

/** Compares lengths first (timingSafeEqual throws on unequal lengths), then in constant time. */
export function sameFingerprint(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
