import { describe, expect, it } from "vitest";
import { runDocumentParserConformance } from "./testing/conformance";
import { txtParser } from "./txt";
import { ParseRejectedError } from "./types";

const utf8 = (s: string) => new TextEncoder().encode(s);
const utf16le = (s: string, bom = true) => {
  const b = Buffer.alloc((bom ? 2 : 0) + s.length * 2);
  if (bom) b.writeUInt16LE(0xfeff, 0);
  for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), (bom ? 2 : 0) + i * 2);
  return new Uint8Array(b);
};
const utf16be = (s: string) => {
  const le = utf16le(s);
  const out = new Uint8Array(le.length);
  for (let i = 0; i < le.length; i += 2) {
    out[i] = le[i + 1] as number;
    out[i + 1] = le[i] as number;
  }
  out[0] = 0xfe;
  out[1] = 0xff;
  return out;
};

runDocumentParserConformance(
  () => txtParser,
  {
    valid: [
      { name: "ascii", bytes: utf8("one\n\ntwo\n"), mime: "text/plain", ext: "txt" },
      {
        name: "utf-8 with BOM",
        bytes: Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8("héllo")]),
        mime: "text/plain",
      },
      { name: "utf-16le", bytes: utf16le("héllo wörld"), mime: "text/plain" },
    ],
    rejected: [
      { name: "nul bytes", bytes: Uint8Array.from([0x68, 0, 0x69, 0, 0, 0xff, 0]) },
      { name: "invalid utf-8", bytes: Uint8Array.from([0xc3, 0x28]) },
      {
        name: "BOM-less UTF-16-looking bytes",
        bytes: Uint8Array.from([0x41, 0, 0x42, 0x43, 0x44, 0, 0x46, 0x47]),
      },
      {
        name: "UTF-16 BOM over binary",
        bytes: Uint8Array.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00]),
      },
    ],
  },
  "txt",
);

describe("txtParser", () => {
  it("decodes UTF-8, UTF-8 with BOM, and UTF-16 LE and BE (with BOM)", async () => {
    for (const bytes of [
      utf8("naïve café"),
      Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8("naïve café")]),
      utf16le("naïve café"),
      utf16be("naïve café"),
    ]) {
      expect((await txtParser.parse(bytes)).text).toBe("naïve café");
    }
  });

  it("normalises line endings and gives one section whose locator covers the text", async () => {
    const doc = await txtParser.parse(utf8("a\r\nb\rc\n"));
    expect(doc.text).toBe("a\nb\nc\n");
    expect(doc.sections).toEqual([
      { headingPath: [], text: "a\nb\nc\n", locator: { kind: "chars", start: 0, end: 6 } },
    ]);
  });

  it("treats an empty or whitespace-only file as an empty document, not an error", async () => {
    expect(await txtParser.parse(new Uint8Array())).toEqual({ text: "", sections: [], media: [] });
    expect((await txtParser.parse(utf8(" \n\t\n"))).sections).toEqual([]);
  });

  it.each([
    ["a NUL byte", Uint8Array.from([0x41, 0x00, 0x42, 0x43]), "unsupported_content"],
    [
      "8 bytes that look like BOM-less UTF-16",
      Uint8Array.from([0x41, 0, 0x42, 0x43, 0x44, 0, 0x46, 0x47]),
      "unsupported_content",
    ],
    [
      "BOM-less UTF-16LE (NULs are rejected as UTF-8)",
      utf16le("hello", false),
      "unsupported_content",
    ],
    ["a C0 control", utf8("ok\u0001bad"), "unsupported_content"],
    ["a C1 control", utf8("ok\u0085bad"), "unsupported_content"],
    ["noncharacter U+FFFE", utf16le("a\ufffeb"), "unsupported_content"],
    ["noncharacter U+FDD0", utf8("a\ufdd0b"), "unsupported_content"],
    ["noncharacter U+1FFFF", utf8("a\u{1ffff}b"), "unsupported_content"],
    ["invalid UTF-8", Uint8Array.from([0xc3, 0x28]), "corrupt_content"],
    ["a lone surrogate in UTF-16", Uint8Array.from([0xff, 0xfe, 0x00, 0xd8]), "corrupt_content"],
    ["an odd-length UTF-16 body", Uint8Array.from([0xff, 0xfe, 0x41]), "corrupt_content"],
  ])("rejects %s", async (_n, bytes, code) => {
    await expect(Promise.resolve().then(() => txtParser.parse(bytes))).rejects.toMatchObject({
      name: "ParseRejectedError",
      code,
    });
    await expect(Promise.resolve().then(() => txtParser.parse(bytes))).rejects.toBeInstanceOf(
      ParseRejectedError,
    );
  });

  it("accepts private-use and unassigned code points", async () => {
    const t = "Shot on \uf8ff iPhone \ue0b0 \u0378";
    expect((await txtParser.parse(utf8(t))).text).toBe(t);
  });

  it("strips exactly one leading U+FEFF after the BOM, locators still slice", async () => {
    const doc = await txtParser.parse(
      Uint8Array.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...utf8("hi")]),
    );
    expect(doc.text).toBe("hi");
    expect(doc.sections[0]?.locator).toEqual({ kind: "chars", start: 0, end: 2 });
    expect((await txtParser.parse(utf16le("\ufeffhi"))).text).toBe("hi");
  });

  it("keeps tab, form feed and escape (log files), which the sniffer also allows", async () => {
    expect((await txtParser.parse(utf8("a\tb\fc\u001b[0m"))).text).toBe("a\tb\fc\u001b[0m");
  });

  it("matches by mime or case-insensitive extension", () => {
    expect(txtParser.accepts("text/plain")).toBe(true);
    expect(txtParser.accepts("application/octet-stream", "TXT")).toBe(true);
    expect(txtParser.accepts("text/markdown")).toBe(false);
    expect(txtParser.accepts("text/plain; charset=utf-8")).toBe(true);
    expect(txtParser.accepts("TEXT/Plain")).toBe(true);
  });
});
