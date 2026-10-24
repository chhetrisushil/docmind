import { describe, expect, it } from "vitest";
import { cutHeading, decodeText, decodeTextPrefix } from "./text";
import { ParseRejectedError } from "./types";

describe("cutHeading", () => {
  it("trims and leaves short titles alone", () => {
    expect(cutHeading("  hi  ")).toBe("hi");
  });
  it("cuts to max units", () => {
    expect(cutHeading("abcdef", 4)).toBe("abcd");
  });
  it("drops a high surrogate left at the cut by a non-BMP char", () => {
    const s = "ab\u{1F600}cd"; // units: a b D83D DE00 c d
    expect(cutHeading(s, 3)).toBe("ab");
    expect(cutHeading(s, 4)).toBe("ab\u{1F600}");
  });
});

const enc = (s: string) => new TextEncoder().encode(s);
const u16 = (s: string, be: boolean, bom = true) => {
  const out: number[] = bom ? (be ? [0xfe, 0xff] : [0xff, 0xfe]) : [];
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    out.push(...(be ? [u >> 8, u & 255] : [u & 255, u >> 8]));
  }
  return new Uint8Array(out);
};
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));

describe("decodeTextPrefix", () => {
  const line = "héllo wörld \u{1F600} 日本語 text\r\n";
  const samples: Record<string, Uint8Array> = {
    ascii: enc("abc def\n".repeat(200)),
    multibyte: enc(line.repeat(100)),
    bom: cat(Uint8Array.of(0xef, 0xbb, 0xbf), enc(line.repeat(100))),
    doubleBom: cat(Uint8Array.of(0xef, 0xbb, 0xbf), enc(`\ufeff${line.repeat(50)}`)),
    crlf: enc("a\r\nb\rc\n".repeat(300)),
    le: u16(line.repeat(100), false),
    be: u16(line.repeat(100), true),
  };
  for (const [name, bytes] of Object.entries(samples)) {
    it(`${name}: a prefix of decodeText at every limit, equal when complete`, () => {
      const full = decodeText(bytes);
      for (const n of [0, 1, 2, 3, 4, 5, 7, 10, 33, 100, 500, 1000, 100000]) {
        const r = decodeTextPrefix(bytes, n);
        expect(full.startsWith(r.text)).toBe(true);
        if (r.complete) expect(r.text).toBe(full);
        else expect(r.text.length).toBeGreaterThanOrEqual(Math.min(n, full.length));
      }
      expect(decodeTextPrefix(bytes, 1_000_000)).toEqual({ text: full, complete: true });
    });
  }

  it("never splits a surrogate pair or a UTF-8 sequence at the cut", () => {
    for (const s of ["\u{1F600}".repeat(50), "日".repeat(50)]) {
      for (const bytes of [enc(s), u16(s, false), u16(s, true)]) {
        const full = decodeText(bytes);
        for (let n = 0; n < 40; n++) {
          const r = decodeTextPrefix(bytes, n);
          expect(full.startsWith(r.text)).toBe(true);
        }
      }
    }
  });

  it("is incomplete for a long input and decodes only a bounded amount", () => {
    const r = decodeTextPrefix(enc("a".repeat(10_000)), 100);
    expect(r.complete).toBe(false);
    expect(r.text.length).toBeLessThanOrEqual(3 * 100 + 3);
  });

  it("still rejects invalid bytes and binary inside the prefix", () => {
    const bad = cat(enc("abc"), Uint8Array.of(0xff, 0xfe, 0xfd), enc("x".repeat(100)));
    expect(() => decodeText(bad)).toThrow(ParseRejectedError);
    expect(() => decodeTextPrefix(bad, 50)).toThrow(ParseRejectedError);
    const ctl = enc(`ab\u0001cd${"x".repeat(100)}`);
    expect(() => decodeTextPrefix(ctl, 50)).toThrow(ParseRejectedError);
    expect(() => decodeTextPrefix(Uint8Array.of(0xff, 0xfe, 0x61), 5)).toThrow(ParseRejectedError);
  });
});
