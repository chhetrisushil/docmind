import { createHmac, hkdfSync } from "node:crypto";
import type { KeyStore } from "@loom/plugin-crypto";
import { FieldKeyStoreError, FieldKeyUnavailableError } from "./fields";

export const ENTITY_KINDS = [
  "person",
  "organization",
  "product",
  "project",
  "place",
  "other",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
const ENTITY_INFO = "docmind-entity-v1";
const SUFFIX = /\s+(?:ltd|limited|inc|incorporated|llc|gmbh|plc|co|corp|corporation)$/;

/** One spelling per entity: NFKC, lower case, punctuation to spaces, whitespace collapsed, a trailing company form dropped. */
export function normalizeEntityName(name: string): string | null {
  const n = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(SUFFIX, "")
    .trim();
  return n === "" ? null : n.slice(0, 200);
}

/** HMAC keys for entity names, derived from each user's data key (D13). Make one per request, like FieldCrypto. */
export class EntityKeys {
  constructor(private readonly keys: KeyStore) {}

  forUser(userId: string): { nameKey(name: string): Promise<string | null> } {
    const keys = this.keys;
    let key: Promise<Buffer> | undefined;
    const derive = (): Promise<Buffer> =>
      keys.get(userId).then(
        (dek) => {
          if (!dek) throw new FieldKeyUnavailableError();
          return Buffer.from(hkdfSync("sha256", dek, Buffer.alloc(0), ENTITY_INFO, 32));
        },
        () => {
          // The store's own errors may name the subject or KEK, so they are not passed on.
          throw new FieldKeyStoreError();
        },
      );
    return {
      nameKey: async (name) => {
        const n = normalizeEntityName(name);
        if (n === null) return null;
        key ??= derive();
        return createHmac("sha256", await key)
          .update(n)
          .digest("hex");
      },
    };
  }
}
