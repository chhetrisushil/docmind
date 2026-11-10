import { createHmac, hkdfSync } from "node:crypto";
import { normaliseTagName } from "@docmind/contracts";
import type { KeyStore } from "@loom/plugin-crypto";
import { FieldKeyStoreError, FieldKeyUnavailableError } from "./fields";

const TAG_INFO = "docmind-tag-v1";

/**
 * The keyed lookup hash of a tag name (the `EntityKeys` pattern, `crypto/entityKeys.ts`): HMAC-SHA256 over the normalised name
 * under a key derived from the owner's data key with its own HKDF info string, so the database never compares plaintext and
 * the hash cannot be tested against guesses once the key is destroyed. Make one per request, like FieldCrypto.
 * Unlike entity names, a tag can be the user's first write, so the data key is created when it does not exist; only a
 * destroyed key reads as unavailable.
 */
export class TagKeys {
  constructor(private readonly keys: KeyStore) {}

  forUser(userId: string): { nameBind(name: string): Promise<Buffer | null> } {
    const keys = this.keys;
    let key: Promise<Buffer> | undefined;
    const derive = (): Promise<Buffer> =>
      keys.getOrCreate(userId).then(
        (dek) => Buffer.from(hkdfSync("sha256", dek, Buffer.alloc(0), TAG_INFO, 32)),
        async () => {
          // The store's own errors may name the subject or KEK, so they are not passed on.
          const destroyed = (await keys.wasDestroyed?.(userId).catch(() => false)) === true;
          throw destroyed ? new FieldKeyUnavailableError() : new FieldKeyStoreError();
        },
      );
    return {
      nameBind: async (name) => {
        const n = normaliseTagName(name);
        if (n === null) return null;
        key ??= derive();
        return createHmac("sha256", await key)
          .update(n)
          .digest();
      },
    };
  }
}
