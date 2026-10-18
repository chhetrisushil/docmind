import { type KeyObject, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
const WRAPPED_BYTES = IV_BYTES + TAG_BYTES + DEK_BYTES;
const AAD_PREFIX = Buffer.from("docmind-dek-v1\0");

const aad = (subjectId: string): Buffer => Buffer.concat([AAD_PREFIX, Buffer.from(subjectId)]);

/**
 * AES-256-GCM seal of a data key under the KEK, as iv || tag || ciphertext. The subject is
 * authenticated data: a wrapped key copied onto another user's row fails to open.
 */
export function wrapKey(kek: KeyObject, subjectId: string, dek: Buffer): Buffer {
  if (dek.length !== DEK_BYTES) throw new Error("the data key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(subjectId));
  const body = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Opens what `wrapKey` sealed. Throws if the KEK, the subject or the bytes are not the originals. */
export function unwrapKey(kek: KeyObject, subjectId: string, wrapped: Buffer): Buffer {
  if (wrapped.length !== WRAPPED_BYTES) throw new Error("malformed wrapped key");
  const iv = wrapped.subarray(0, IV_BYTES);
  const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = wrapped.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", kek, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(subjectId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
