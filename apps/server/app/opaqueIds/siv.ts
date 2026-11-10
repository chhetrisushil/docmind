import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";
import { base32Decode, base32Encode } from "./base32";

/** HKDF info of the per-user id key; distinct from `docmind-tag-v1` and `docmind-entity-v1` (crypto/tagKeys.ts, entityKeys.ts). */
export const ID_KEY_INFO = "docmind-id-v1";
const MAC_INFO = `${ID_KEY_INFO}/mac`;
const ENC_INFO = `${ID_KEY_INFO}/enc`;
const HANDLE_LABEL = "user";

/** The three keys of one user's ids. `root` signs the handle; `mac` and `enc` are derived from it and never used for anything else. */
export interface IdKey {
  readonly root: Buffer;
  readonly mac: Buffer;
  readonly enc: Buffer;
}

/** Which kind of id a token holds. It is authenticated with the token, so a document token never opens as a chat token. */
export type TokenFamily = "doc" | "chat";

const hkdf = (key: Buffer, info: string) =>
  Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), info, 32));

/** The id key of a user, from the user's data key (the `TagKeys` / `EntityKeys` mechanism with its own label). */
export function deriveIdKey(dek: Buffer): IdKey {
  const root = hkdf(dek, ID_KEY_INFO);
  return { root, mac: hkdf(root, MAC_INFO), enc: hkdf(root, ENC_INFO) };
}

/** `H = base32(HMAC(idKey, "user"))`, truncated to 128 bits: 26 characters. */
export const handleOfKey = (key: IdKey): string =>
  base32Encode(createHmac("sha256", key.root).update(HANDLE_LABEL).digest().subarray(0, 16));

const UUID_BYTES = 16;
const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidBytes = (uuid: string): Buffer => Buffer.from(uuid.replaceAll("-", ""), "hex");
const bytesUuid = (b: Buffer): string => {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** The synthetic IV: HMAC-SHA256 over the family, a zero byte and the plaintext, cut to 128 bits. */
const ivOf = (key: IdKey, family: TokenFamily, plain: Buffer): Buffer =>
  createHmac("sha256", key.mac)
    .update(family)
    .update(Buffer.from([0]))
    .update(plain)
    .digest()
    .subarray(0, 16);

const ctr = (key: IdKey, iv: Buffer, data: Buffer, decrypt: boolean): Buffer => {
  const c = decrypt
    ? createDecipheriv("aes-256-ctr", key.enc, iv)
    : createCipheriv("aes-256-ctr", key.enc, iv);
  return Buffer.concat([c.update(data), c.final()]);
};

/** The characters of a token: 32 bytes (a 16-byte IV and a 16-byte ciphertext) in base32. */
export const TOKEN_LENGTH = 52;

/**
 * A synthetic-IV (SIV) seal of a UUID: `base32(IV || AES-256-CTR(enc, IV, uuid))` with `IV = HMAC(mac, family || 0 || uuid)[0..16]`.
 * Deterministic, so one document or chat always has one token; reversible only with the key. Node's `crypto` has no RFC 5297 AES-SIV
 * (Node 24: `getCiphers()` lists CTR but no SIV), so this is the standard HMAC-PRF plus CTR composition from its primitives.
 */
export function sealToken(key: IdKey, family: TokenFamily, uuid: string): string {
  if (!CANONICAL.test(uuid)) throw new RangeError("a token seals a canonical lower-case uuid");
  const plain = uuidBytes(uuid);
  const iv = ivOf(key, family, plain);
  return base32Encode(Buffer.concat([iv, ctr(key, iv, plain, false)]));
}

/** The UUID a token seals, or null when the token is malformed, of another family or fails authentication. */
export function openToken(key: IdKey, family: TokenFamily, token: string): string | null {
  const raw = base32Decode(token, 2 * UUID_BYTES);
  if (raw === null) return null;
  const iv = raw.subarray(0, 16);
  const plain = ctr(key, iv, raw.subarray(16), true);
  const expected = ivOf(key, family, plain);
  return timingSafeEqual(iv, expected) ? bytesUuid(plain) : null;
}
