import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { loadKek } from "./kek";

const raw = randomBytes(32);
const b64 = raw.toString("base64");

function errorOf(env: NodeJS.ProcessEnv): string {
  try {
    loadKek(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected loadKek to throw");
}

describe("loadKek", () => {
  it("reads a base64 key from DOCMIND_KEK and names it", () => {
    const kek = loadKek({ DOCMIND_KEK: b64, DOCMIND_KEK_ID: "kek-7" });
    expect(kek.id).toBe("kek-7");
    expect(kek.key.export().equals(raw)).toBe(true);
    expect(loadKek({ DOCMIND_KEK: b64 }).id).toBe("kek-1");
  });

  it("reads the key from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "docmind-kek-"));
    try {
      writeFileSync(join(dir, "kek"), `${b64}\n`);
      expect(
        loadKek({ DOCMIND_KEK_FILE: join(dir, "kek") })
          .key.export()
          .equals(raw),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing key and a key of the wrong size", () => {
    expect(() => loadKek({})).toThrow(/DOCMIND_KEK/);
    expect(() => loadKek({ DOCMIND_KEK: randomBytes(16).toString("base64") })).toThrow(/32 bytes/);
  });

  it("refuses base64 that does not round-trip, naming the variable but not the value", () => {
    const message = errorOf({ DOCMIND_KEK: `${b64} ` });
    expect(message).toContain("DOCMIND_KEK");
    expect(message).not.toContain(b64);
  });

  it("refuses both key sources at once", () => {
    expect(errorOf({ DOCMIND_KEK: b64, DOCMIND_KEK_FILE: "/nonexistent" })).toMatch(/not both/);
  });

  it("refuses an invalid key id, naming the variable", () => {
    for (const id of ["", "KEK-1", "a/b", "x".repeat(65)]) {
      expect(errorOf({ DOCMIND_KEK: b64, DOCMIND_KEK_ID: id })).toContain("DOCMIND_KEK_ID");
    }
  });

  it("keeps the key bytes out of JSON and inspect output", () => {
    const kek = loadKek({ DOCMIND_KEK: b64 });
    const shown = JSON.stringify(kek) + inspect(kek);
    expect(shown).not.toContain(raw.toString("hex"));
    expect(shown).not.toContain(b64);
  });
});
