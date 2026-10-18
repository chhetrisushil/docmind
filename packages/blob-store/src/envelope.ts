import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { BlobCorruptError } from "./errors";

const MAGIC = Buffer.from("DMB1");
const IV = 12;
const TAG = 16;
const KEY = 32;
const HEADER = MAGIC.length + IV + TAG + KEY + IV;

/** Bytes a sealed blob adds to its plaintext: header plus the trailing tag. */
export const OVERHEAD_BYTES = HEADER + TAG;

export interface BlobScope {
  tenantId: string;
  userId: string;
}

// Both the key wrap and the body authenticate who owns the blob, so a file copied into another
// user's (or tenant's) directory fails to open.
const aad = (scope: BlobScope): Buffer =>
  Buffer.from(`docmind-blob-v1\0${scope.tenantId}/${scope.userId}`);

/**
 * Seals a byte stream. Format: magic | wrapIv | wrapTag | wrappedBlobKey | bodyIv | ciphertext |
 * bodyTag. A fresh random key encrypts the body (AES-256-GCM, so the stream is never held in
 * memory); the user's data key wraps that key. Chunks are yielded as they are produced.
 */
export async function* sealStream(
  dek: Buffer,
  scope: BlobScope,
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Buffer> {
  const blobKey = randomBytes(KEY);
  const wrapIv = randomBytes(IV);
  const wrap = createCipheriv("aes-256-gcm", dek, wrapIv, { authTagLength: TAG });
  wrap.setAAD(aad(scope));
  const wrapped = Buffer.concat([wrap.update(blobKey), wrap.final()]);
  const bodyIv = randomBytes(IV);
  const body = createCipheriv("aes-256-gcm", blobKey, bodyIv, { authTagLength: TAG });
  body.setAAD(aad(scope));
  yield Buffer.concat([MAGIC, wrapIv, wrap.getAuthTag(), wrapped, bodyIv]);
  for await (const chunk of source) {
    const out = body.update(chunk);
    if (out.length > 0) yield out;
  }
  const last = body.final();
  if (last.length > 0) yield last;
  yield body.getAuthTag();
}

/** Opens a sealed blob, or throws `BlobCorruptError` (wrong key, owner, or any changed byte). */
export function openBytes(dek: Buffer, scope: BlobScope, sealed: Uint8Array): Buffer {
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (buf.length < OVERHEAD_BYTES || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BlobCorruptError("not a DocMind blob");
  }
  let at = MAGIC.length;
  const take = (n: number): Buffer => {
    const part = buf.subarray(at, at + n);
    at += n;
    return part;
  };
  const wrapIv = take(IV);
  const wrapTag = take(TAG);
  const wrapped = take(KEY);
  const bodyIv = take(IV);
  const bodyTag = buf.subarray(buf.length - TAG);
  const ciphertext = buf.subarray(at, buf.length - TAG);
  try {
    const unwrap = createDecipheriv("aes-256-gcm", dek, wrapIv, { authTagLength: TAG });
    unwrap.setAAD(aad(scope));
    unwrap.setAuthTag(wrapTag);
    const blobKey = Buffer.concat([unwrap.update(wrapped), unwrap.final()]);
    const body = createDecipheriv("aes-256-gcm", blobKey, bodyIv, { authTagLength: TAG });
    body.setAAD(aad(scope));
    body.setAuthTag(bodyTag);
    return Buffer.concat([body.update(ciphertext), body.final()]);
  } catch {
    // The Node error can name nothing sensitive, but a fixed message keeps it that way.
    throw new BlobCorruptError();
  }
}
