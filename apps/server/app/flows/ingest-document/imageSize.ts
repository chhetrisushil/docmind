export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_SEGMENTS = 10_000;

const startsWith = (b: Uint8Array, at: number, bytes: readonly number[]): boolean =>
  b.length >= at + bytes.length && bytes.every((v, i) => b[at + i] === v);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const valid = (width: number, height: number): ImageSize | null =>
  width > 0 && height > 0 ? { width, height } : null;

function png(b: Uint8Array, v: DataView): ImageSize | null {
  if (!startsWith(b, 0, PNG_SIG) || !startsWith(b, 12, ascii("IHDR")) || b.length < 24) return null;
  return valid(v.getUint32(16), v.getUint32(20));
}

function jpeg(b: Uint8Array, v: DataView): ImageSize | null {
  if (!startsWith(b, 0, [0xff, 0xd8])) return null;
  let at = 2;
  for (let n = 0; n < MAX_SEGMENTS; n++) {
    if (at + 4 > b.length || b[at] !== 0xff) return null;
    const marker = b[at + 1] as number;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > b.length) return null;
      return valid(v.getUint16(at + 7), v.getUint16(at + 5));
    }
    const len = v.getUint16(at + 2);
    if (len < 2) return null;
    at += 2 + len;
  }
  return null;
}

function webp(b: Uint8Array, v: DataView): ImageSize | null {
  if (!startsWith(b, 0, ascii("RIFF")) || !startsWith(b, 8, ascii("WEBP"))) return null;
  if (startsWith(b, 12, ascii("VP8X"))) {
    if (b.length < 30) return null;
    const u24 = (o: number) =>
      (b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16);
    return valid(u24(24) + 1, u24(27) + 1);
  }
  if (startsWith(b, 12, ascii("VP8L"))) {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = v.getUint32(21, true);
    return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (startsWith(b, 12, ascii("VP8 "))) {
    if (b.length < 30 || !startsWith(b, 23, [0x9d, 0x01, 0x2a])) return null;
    return valid(v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff);
  }
  return null;
}

/** Pixel dimensions from the header alone (PNG, JPEG, WebP); null if unreadable or the mime does not match. Never decodes pixels. */
export function imageSize(bytes: Uint8Array, mime: string): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mime === "image/png") return png(bytes, view);
    if (mime === "image/jpeg") return jpeg(bytes, view);
    if (mime === "image/webp") return webp(bytes, view);
  } catch {
    return null;
  }
  return null;
}
