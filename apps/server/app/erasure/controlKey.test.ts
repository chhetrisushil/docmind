import { createSecretKey, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ERASURE_CONTROL_INFO, deriveControlKey, erasureControlKeys } from "./controlKey";

describe("the erasure control-stream key", () => {
  const kek = () => createSecretKey(randomBytes(32));

  it("is stable for the same KEK and at least 16 bytes", () => {
    const k = kek();
    const a = deriveControlKey(k);
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a.equals(deriveControlKey(k))).toBe(true);
  });

  it("differs by KEK and by info label, and is not the KEK", () => {
    const k = kek();
    expect(deriveControlKey(k).equals(deriveControlKey(kek()))).toBe(false);
    expect(deriveControlKey(k).equals(k.export())).toBe(false);
    expect(ERASURE_CONTROL_INFO).not.toBe("docmind-id-v1");
    const other = Buffer.from(hkdfSync("sha256", k, Buffer.alloc(0), "docmind-other-v1", 32));
    expect(other.equals(deriveControlKey(k))).toBe(false);
  });

  it("lists the current KEK's key first and the previous KEKs' keys after it", () => {
    const [a, b] = [kek(), kek()];
    const keys = erasureControlKeys([
      { id: "kek-2", key: a },
      { id: "kek-1", key: b },
    ]);
    expect(keys.current.equals(deriveControlKey(a))).toBe(true);
    expect(keys.previous).toHaveLength(1);
    expect(keys.previous[0]?.equals(deriveControlKey(b))).toBe(true);
  });
});
