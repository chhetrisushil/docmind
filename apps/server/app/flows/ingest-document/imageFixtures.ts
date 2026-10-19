/** Header-only image bytes for tests; enough for imageSize, never decodable. */
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16be = (n: number) => [(n >>> 8) & 255, n & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
const a = (s: string) => [...s].map((c) => c.charCodeAt(0));

export const pngBytes = (w: number, h: number) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...a("IHDR"),
    ...u32be(w),
    ...u32be(h),
    8,
    6,
    0,
    0,
    0,
  ]);
export const jpegBytes = (w: number, h: number) =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...u16be(16),
    ...new Array(14).fill(0),
    0xff,
    0xc0,
    ...u16be(17),
    8,
    ...u16be(h),
    ...u16be(w),
    ...new Array(10).fill(0),
  ]);
export const webpX = (w: number, h: number) =>
  new Uint8Array([
    ...a("RIFF"),
    0,
    0,
    0,
    0,
    ...a("WEBP"),
    ...a("VP8X"),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...u24le(w - 1),
    ...u24le(h - 1),
  ]);
export const webpL = (w: number, h: number) => {
  const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
  return new Uint8Array([
    ...a("RIFF"),
    0,
    0,
    0,
    0,
    ...a("WEBP"),
    ...a("VP8L"),
    5,
    0,
    0,
    0,
    0x2f,
    bits & 255,
    (bits >>> 8) & 255,
    (bits >>> 16) & 255,
    (bits >>> 24) & 255,
  ]);
};
export const webpLossy = (w: number, h: number) =>
  new Uint8Array([
    ...a("RIFF"),
    0,
    0,
    0,
    0,
    ...a("WEBP"),
    ...a("VP8 "),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    ...u16le(w),
    ...u16le(h),
  ]);
