import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadKek } from "./kek";

const b64 = randomBytes(32).toString("base64");

describe("loadKek", () => {
  it("reads a base64 key from DOCMIND_KEK and names it", () => {
    const kek = loadKek({ DOCMIND_KEK: b64, DOCMIND_KEK_ID: "kek-7" });
    expect(kek.id).toBe("kek-7");
    expect(kek.key.toString("base64")).toBe(b64);
    expect(loadKek({ DOCMIND_KEK: b64 }).id).toBe("kek-1");
  });

  it("reads the key from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "docmind-kek-"));
    try {
      writeFileSync(join(dir, "kek"), `${b64}\n`);
      expect(loadKek({ DOCMIND_KEK_FILE: join(dir, "kek") }).key.toString("base64")).toBe(b64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing key and a key of the wrong size", () => {
    expect(() => loadKek({})).toThrow(/DOCMIND_KEK/);
    expect(() => loadKek({ DOCMIND_KEK: randomBytes(16).toString("base64") })).toThrow(/32 bytes/);
  });
});
