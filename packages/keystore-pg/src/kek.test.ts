import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { loadKek, loadKeks } from "./kek";

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

  it("loads a named key with its own id variable, defaulting no id for names other than DOCMIND_KEK", () => {
    const kek = loadKek({ OTHER: b64, OTHER_ID: "other-1" }, "OTHER");
    expect(kek.id).toBe("other-1");
    expect(() => loadKek({ OTHER: b64 }, "OTHER")).toThrow("OTHER_ID");
  });

  it("keeps the key bytes out of JSON and inspect output", () => {
    const kek = loadKek({ DOCMIND_KEK: b64 });
    const shown = JSON.stringify(kek) + inspect(kek);
    expect(shown).not.toContain(raw.toString("hex"));
    expect(shown).not.toContain(b64);
  });

  it("loadKeks puts the current KEK first and adds the previous one while rotating", () => {
    const other = randomBytes(32).toString("base64");
    expect(loadKeks({ DOCMIND_KEK: b64 }).map((k) => k.id)).toEqual(["kek-1"]);
    const both = loadKeks({
      DOCMIND_KEK: b64,
      DOCMIND_KEK_ID: "kek-2",
      DOCMIND_KEK_PREVIOUS: other,
      DOCMIND_KEK_PREVIOUS_ID: "kek-1",
    });
    expect(both.map((k) => k.id)).toEqual(["kek-2", "kek-1"]);
    expect(both[1]?.key.export().toString("base64")).toBe(other);
  });

  it("loadKeks refuses a previous KEK without an id, or with the current one's id", () => {
    const other = randomBytes(32).toString("base64");
    expect(() => loadKeks({ DOCMIND_KEK: b64, DOCMIND_KEK_PREVIOUS: other })).toThrow(/_ID/);
    expect(() =>
      loadKeks({ DOCMIND_KEK: b64, DOCMIND_KEK_PREVIOUS: other, DOCMIND_KEK_PREVIOUS_ID: "kek-1" }),
    ).toThrow(/different id/);
  });

  it("loadKeks applies the same strictness to the previous KEK, naming its variable", () => {
    expect(() =>
      loadKeks({
        DOCMIND_KEK: b64,
        DOCMIND_KEK_PREVIOUS: `${b64} `,
        DOCMIND_KEK_PREVIOUS_ID: "kek-0",
      }),
    ).toThrow("DOCMIND_KEK_PREVIOUS must hold base64 of exactly 32 bytes");
  });
});
