import { describe, expect, it } from "vitest";
import { sanitizeFilename, sniff, titleFromFilename } from "./sniff";

const hex = (s: string) => Buffer.from(s.replace(/\s/g, ""), "hex");
const text = (s: string) => Buffer.from(s);

describe("sniff", () => {
  it("recognises binary formats by signature, whatever the extension says", () => {
    expect(sniff(text("%PDF-1.7\n..."), "x.png")?.kind).toBe("pdf");
    expect(sniff(hex("89504e470d0a1a0a0000000d"), "x.pdf")?.kind).toBe("png");
    expect(sniff(hex("ffd8ffe000104a464946"), "x")?.kind).toBe("jpg");
    expect(
      sniff(Buffer.concat([text("RIFF"), hex("24000000"), text("WEBPVP8 ")]), "x.jpg")?.kind,
    ).toBe("webp");
    expect(sniff(hex("89504e470d0a1a0a"), "x.pdf")?.mime).toBe("image/png");
  });

  it("accepts OLE2 only as .doc and ZIP only as .docx", () => {
    const ole = hex("d0cf11e0a1b11ae1 0000");
    const zip = hex("504b0304 1400");
    expect(sniff(ole, "report.DOC")?.kind).toBe("doc");
    expect(sniff(ole, "sheet.xls")).toBeNull();
    expect(sniff(zip, "report.docx")?.kind).toBe("docx");
    expect(sniff(zip, "archive.zip")).toBeNull();
    expect(sniff(zip, "deck.pptx")).toBeNull();
    expect(sniff(zip, "noext")).toBeNull();
  });

  it("accepts text by content plus a known extension", () => {
    expect(sniff(text("# Title\n\nSome text\n"), "notes.md")?.kind).toBe("md");
    expect(sniff(text("* Heading\n"), "plan.org")?.kind).toBe("org");
    expect(sniff(text("plain\r\n"), "a.txt")?.mime).toBe("text/plain");
    expect(sniff(text("naïve café"), "a.TXT")?.kind).toBe("txt");
    expect(sniff(hex("fffe 6800 6900"), "u16.txt")?.kind).toBe("txt"); // UTF-16 LE with BOM
  });

  it("rejects binary content disguised as text, unknown extensions, and empty files", () => {
    expect(sniff(hex("00 01 02 03 04"), "a.txt")).toBeNull();
    expect(sniff(text("hello\u0000world"), "a.txt")).toBeNull();
    expect(sniff(text("hello"), "a.exe")).toBeNull();
    expect(sniff(text("hello"), "noextension")).toBeNull();
    expect(sniff(Buffer.alloc(0), "a.txt")).toBeNull();
    expect(sniff(hex("7f454c46 02 01 01 00"), "a.txt")).toBeNull(); // ELF binary
  });
});

describe("sanitizeFilename", () => {
  it("keeps only a safe base name", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\a.docx")).toBe("a.docx");
    expect(sanitizeFilename("a\u0000b\u0007c.txt")).toBe("abc.txt");
    expect(sanitizeFilename("evil\u202etxt.exe")).toBe("eviltxt.exe");
    expect(sanitizeFilename("  spaced  name.md ")).toBe("spaced name.md");
    expect(sanitizeFilename("Cafe\u0301.txt")).toBe("Caf\u00e9.txt"); // NFC
  });

  it("is never empty and never longer than 200 code points", () => {
    for (const bad of ["", "   ", "///", "..", "\u0000"])
      expect(sanitizeFilename(bad)).toBe("untitled");
    expect([...sanitizeFilename(`${"é".repeat(500)}.txt`)].length).toBeLessThanOrEqual(200);
  });
});

describe("titleFromFilename", () => {
  it("drops the last extension only", () => {
    expect(titleFromFilename("Quarterly report.final.docx")).toBe("Quarterly report.final");
    expect(titleFromFilename("notes.md")).toBe("notes");
    expect(titleFromFilename(".gitignore")).toBe(".gitignore");
    expect(titleFromFilename("README")).toBe("README");
  });
});
