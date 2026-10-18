import { type KeyStore, decryptValue, encryptValue, envelopeAad } from "@loom/plugin-crypto";

const AAD_VERSION = "docmind-field-v1";
const ENVELOPE_TAG = "loom/aes-256-gcm";

/** The owner's data key does not exist (never created, or destroyed by erasure). */
export class FieldKeyUnavailableError extends Error {
  constructor() {
    super("the data key for this field's owner is unavailable");
    this.name = "FieldKeyUnavailableError";
  }
}

export interface UserFieldCipher {
  /** Seals any JSON value. `bind` names the row and column, e.g. `document:<id>:title`. */
  seal(bind: string, value: unknown): Promise<unknown>;
  /** Opens what `seal` produced for the same `bind`; throws for anything else. */
  open(bind: string, envelope: unknown): Promise<unknown>;
  openText(bind: string, envelope: unknown): Promise<string>;
}

/** A field envelope: Loom's shape, sealed by this module (carries our AAD marker). */
const isFieldEnvelope = (v: unknown): boolean => {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    e.__loomEnc === ENVELOPE_TAG &&
    typeof e.iv === "string" &&
    typeof e.tag === "string" &&
    typeof e.data === "string" &&
    envelopeAad(v) === AAD_VERSION
  );
};

/**
 * Application-level AEAD for the `*_enc` columns, under the owning user's data key (spec §4.4).
 * It reuses Loom's envelope. The AAD binds user + row + column, so a value copied to another
 * row, column or user does not open. Make one cipher per request: it fetches the key lazily, once.
 * Error messages never carry plaintext, key material or the ids in a bind string.
 */
export class FieldCrypto {
  constructor(private readonly keys: KeyStore) {}

  forUser(userId: string): UserFieldCipher {
    const keys = this.keys;
    let sealKey: Promise<Buffer> | undefined;
    let openKey: Promise<Buffer> | undefined;
    const forSeal = (): Promise<Buffer> => {
      // The store's own error names the subject (and a destroyed key must not be re-minted).
      sealKey ??= keys.getOrCreate(userId).catch(() => {
        throw new FieldKeyUnavailableError();
      });
      return sealKey;
    };
    const forOpen = (): Promise<Buffer> => {
      openKey ??= keys.get(userId).then((key) => {
        if (!key) throw new FieldKeyUnavailableError();
        return key;
      });
      return openKey;
    };
    const context = (bind: string): string => `${userId}|${bind}`;
    const open = async (bind: string, envelope: unknown): Promise<unknown> => {
      // decryptValue returns a non-envelope untouched; a plaintext in an *_enc column is a bug.
      if (!isFieldEnvelope(envelope)) throw new Error("encrypted field does not hold an envelope");
      return decryptValue(await forOpen(), envelope, context(bind));
    };
    return {
      seal: async (bind, value) =>
        encryptValue(await forSeal(), value, { v: AAD_VERSION, bind: context(bind) }),
      open,
      openText: async (bind, envelope) => {
        const value = await open(bind, envelope);
        if (typeof value !== "string") throw new Error("encrypted field is not text");
        return value;
      },
    };
  }
}
