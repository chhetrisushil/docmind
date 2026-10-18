import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { loadKek } from "./kek";

const raw = randomBytes(32);
const b64 = raw.toString("base64");

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
      const kek = loadKek({ DOCMIND_KEK_FILE: join(dir, "kek") });
      expect(kek.key.export().equals(raw)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing key and a key of the wrong size", () => {
    expect(() => loadKek({})).toThrow(/DOCMIND_KEK/);
    expect(() => loadKek({ DOCMIND_KEK: randomBytes(16).toString("base64") })).toThrow(/32 bytes/);
  });

  it("refuses base64 that does not round-trip, naming the variable but not the value", () => {
    expect(() => loadKek({ DOCMIND_KEK: `${b64} ` })).toThrow(
      "DOCMIND_KEK must hold base64 of exactly 32 bytes",
    );
  });

  it("refuses an invalid key id, naming the variable", () => {
    for (const id of ["", "KEK-1", "a/b", "x".repeat(65)]) {
      expect(() => loadKek({ DOCMIND_KEK: b64, DOCMIND_KEK_ID: id })).toThrow("DOCMIND_KEK_ID");
    }
  });

  it("keeps the key bytes out of JSON and inspect output", () => {
    const kek = loadKek({ DOCMIND_KEK: b64 });
    const shown = JSON.stringify(kek) + inspect(kek);
    expect(shown).not.toContain(raw.toString("hex"));
    expect(shown).not.toContain(b64);
  });
});
