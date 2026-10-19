import { createDeflateRaw } from "node:zlib";
import { describe, expect, it } from "vitest";
import { makeZip } from "./testing/makeZip";
import { ParseRejectedError } from "./types";
import { docxZipLimits, zipBudget } from "./zip";

const MiB = 1024 * 1024;
const enc = (s: string) => new TextEncoder().encode(s);
const code = (fn: () => void) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof ParseRejectedError ? e.code : `threw ${String(e)}`;
  }
};
const LIMITS = { maxEntries: 10, maxEntryBytes: MiB, maxTotalBytes: 2 * MiB };

describe("zipBudget", () => {
  it("accepts a small stored and deflated archive", () => {
    const zip = makeZip([
      { name: "a.xml", data: enc("<a/>") },
      { name: "b.xml", data: enc("<b>".repeat(100)), method: 8 },
    ]);
    expect(code(() => zipBudget(zip, LIMITS))).toBe("ok");
  });

  it("refuses too many entries, a too-large entry and a too-large total as too_large", () => {
    const many = makeZip(Array.from({ length: 11 }, (_, i) => ({ name: `${i}`, data: enc("x") })));
    expect(code(() => zipBudget(many, LIMITS))).toBe("too_large");
    const big = makeZip([{ name: "big", data: new Uint8Array(MiB + 1), method: 8 }]);
    expect(code(() => zipBudget(big, LIMITS))).toBe("too_large");
    const total = makeZip(
      [0, 1, 2].map((i) => ({ name: `${i}`, data: new Uint8Array(MiB), method: 8 as const })),
    );
    expect(code(() => zipBudget(total, LIMITS))).toBe("too_large");
  });

  it("caps inflation at the declared size: a 1 GiB bomb declared as 1000 bytes is refused without inflating it", async () => {
    const deflate = createDeflateRaw();
    const chunks: Buffer[] = [];
    deflate.on("data", (c: Buffer) => chunks.push(c));
    const ended = new Promise<void>((resolve) => deflate.on("end", resolve));
    const zeros = Buffer.alloc(MiB);
    for (let i = 0; i < 1024; i++) {
      if (!deflate.write(zeros)) await new Promise((r) => deflate.once("drain", r));
    }
    deflate.end();
    await ended;
    const bomb = makeZip([
      {
        name: "bomb",
        data: new Uint8Array(0),
        method: 8,
        declaredSize: 1000,
        precompressed: Buffer.concat(chunks),
      },
    ]);
    const before = process.memoryUsage().rss;
    expect(code(() => zipBudget(bomb, LIMITS))).toBe("corrupt_content");
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * MiB);
  }, 60_000);

  it("refuses a directory the end record undercounts (jszip walks headers, not the count)", () => {
    const zip = makeZip(
      [
        { name: "a", data: enc("a") },
        { name: "b", data: enc("b") },
      ],
      { eocdCount: 1 },
    );
    expect(code(() => zipBudget(zip, LIMITS))).toBe("corrupt_content");
  });

  it("refuses a gap between the directory and the end record (jszip shifts offsets by it)", () => {
    const zip = makeZip([{ name: "a", data: enc("a") }], { gap: 8 });
    expect(code(() => zipBudget(zip, LIMITS))).toBe("corrupt_content");
  });

  it("refuses garbage and a truncated directory as corrupt_content", () => {
    expect(code(() => zipBudget(enc("PK\u0003\u0004 not a zip at all"), LIMITS))).toBe(
      "corrupt_content",
    );
    const zip = makeZip([{ name: "a", data: enc("a") }]);
    expect(code(() => zipBudget(zip.subarray(0, zip.length - 5), LIMITS))).toBe("corrupt_content");
  });

  it("refuses archives shorter than an end-of-directory record as corrupt_content", () => {
    for (const n of [0, 1, 4, 21])
      expect(code(() => zipBudget(new Uint8Array(n), LIMITS))).toBe("corrupt_content");
  });

  it("refuses an encrypted entry and an unknown method as unsupported_content", () => {
    const encrypted = makeZip([{ name: "a", data: enc("a"), flags: 1 }]);
    expect(code(() => zipBudget(encrypted, LIMITS))).toBe("unsupported_content");
    const bzip = makeZip([{ name: "a", data: enc("a"), method: 12 as never }]);
    expect(code(() => zipBudget(bzip, LIMITS))).toBe("unsupported_content");
  });

  it("docxZipLimits scales the total with the input and caps it at 512 MiB", () => {
    expect(docxZipLimits(1000).maxTotalBytes).toBe(64_000);
    expect(docxZipLimits(50 * MiB).maxTotalBytes).toBe(512 * MiB);
  });
});
