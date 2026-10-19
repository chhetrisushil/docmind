import { createHmac } from "node:crypto";
import { deriveFingerprintKey } from "@docmind/blob-store";
import { InMemoryKeyStore, type KeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { EntityKeys, normalizeEntityName } from "./entityKeys";
import { FieldKeyStoreError, FieldKeyUnavailableError } from "./fields";

const U1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const U2 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

async function seeded(): Promise<{ keys: InMemoryKeyStore; entity: EntityKeys }> {
  const keys = new InMemoryKeyStore();
  await keys.getOrCreate(U1);
  await keys.getOrCreate(U2);
  return { keys, entity: new EntityKeys(keys) };
}

describe("EntityKeys", () => {
  it("gives one key to every spelling of a name", async () => {
    const { entity } = await seeded();
    const k = entity.forUser(U1);
    const a = await k.nameKey("Acme Ltd.");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await k.nameKey("ACME")).toBe(a);
    expect(await k.nameKey(" acme,  ltd ")).toBe(a);
  });

  it("separates different names and different users", async () => {
    const { entity } = await seeded();
    expect(await entity.forUser(U1).nameKey("Acme Labs")).not.toBe(
      await entity.forUser(U1).nameKey("Acme"),
    );
    expect(await entity.forUser(U1).nameKey("Acme")).not.toBe(
      await entity.forUser(U2).nameKey("Acme"),
    );
  });

  it("returns null for a name with nothing left after normalizing", async () => {
    const { entity } = await seeded();
    expect(await entity.forUser(U1).nameKey("!!!")).toBeNull();
    expect(normalizeEntityName("  ")).toBeNull();
  });

  it("is unavailable once the key is destroyed", async () => {
    const { keys, entity } = await seeded();
    await keys.destroy(U1);
    await expect(entity.forUser(U1).nameKey("Acme")).rejects.toBeInstanceOf(
      FieldKeyUnavailableError,
    );
  });

  it("reports a key-store outage as a store error without its message", async () => {
    const failing: KeyStore = {
      get: async () => {
        throw new Error("kms down for secret-subject");
      },
      getOrCreate: async () => {
        throw new Error("kms down");
      },
      destroy: async () => {},
    };
    const err = await new EntityKeys(failing)
      .forUser(U1)
      .nameKey("Acme")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FieldKeyStoreError);
    expect((err as Error).message).not.toContain("secret-subject");
  });

  it("is independent of the blob fingerprint key derived from the same data key", async () => {
    const { keys, entity } = await seeded();
    const dek = await keys.get(U1);
    if (!dek) throw new Error("test key missing");
    const viaFingerprintKey = createHmac("sha256", deriveFingerprintKey(dek))
      .update("acme")
      .digest("hex");
    expect(await entity.forUser(U1).nameKey("Acme")).not.toBe(viaFingerprintKey);
  });
});
