import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM seal of a data key under the KEK, as iv || tag || ciphertext. The subject is
 * authenticated data: a wrapped key copied onto another user's row fails to open.
 */
export function wrapKey(kek: Buffer, subjectId: string, dek: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(Buffer.from(subjectId, "utf8"));
  const body = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Opens what `wrapKey` sealed. Throws if the KEK, the subject or the bytes are not the originals. */
export function unwrapKey(kek: Buffer, subjectId: string, wrapped: Buffer): Buffer {
  const iv = wrapped.subarray(0, IV_BYTES);
  const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = wrapped.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", kek, iv);
  decipher.setAAD(Buffer.from(subjectId, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
