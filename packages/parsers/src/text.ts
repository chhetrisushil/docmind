import { ParseRejectedError } from "./types";

const reject = (code: "unsupported_content" | "corrupt_content"): never => {
  throw new ParseRejectedError(code);
};

function strict(label: "utf-8" | "utf-16le", bytes: Uint8Array): string {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return reject("corrupt_content");
  }
}

function utf16(bytes: Uint8Array, bigEndian: boolean): string {
  if (bytes.length % 2 !== 0) reject("corrupt_content");
  if (!bigEndian) return strict("utf-16le", bytes);
  const swapped = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1] as number;
    swapped[i + 1] = bytes[i] as number;
  }
  return strict("utf-16le", swapped);
}

function decode(bytes: Uint8Array): string {
  const [a, b, c] = bytes;
  if (a === 0xff && b === 0xfe) return utf16(bytes.subarray(2), false);
  if (a === 0xfe && b === 0xff) return utf16(bytes.subarray(2), true);
  if (a === 0xef && b === 0xbb && c === 0xbf) return strict("utf-8", bytes.subarray(3));
  return strict("utf-8", bytes);
}

const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b]);
const isNoncharacter = (cp: number) => (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe;

/** Binary data decodes to controls and noncharacters; real text does not. Private-use and unassigned are kept. */
function assertText(text: string): void {
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 ? !ALLOWED_CONTROLS.has(cp) : cp >= 0x7f && cp <= 0x9f) {
      reject("unsupported_content");
    }
    if (isNoncharacter(cp) || (cp >= 0xd800 && cp <= 0xdfff)) reject("unsupported_content");
  }
}

/** Bytes to normalized text: BOM / UTF-16 detection, one U+FEFF stripped, CRLF and CR to LF, binary refused. */
export function decodeText(bytes: Uint8Array): string {
  // A doubled BOM leaves one U+FEFF after the BOM bytes; strip exactly one.
  const decoded = decode(bytes);
  const text = (decoded.startsWith("\ufeff") ? decoded.slice(1) : decoded).replace(/\r\n?/g, "\n");
  assertText(text);
  return text;
}

/**
 * `decodeText` for a bounded prefix: the same BOM detection, UTF-8 / UTF-16 handling, single U+FEFF strip, line-ending
 * normalization and `assertText` validation, but only the bytes needed for `maxUnits` UTF-16 units plus a margin are
 * decoded (UTF-8: 3 * maxUnits + 3 bytes, UTF-16: 4 * maxUnits + 4, since a CRLF is 4 bytes and one unit), cut back to a code-point boundary. `text` is a
 * prefix of `decodeText(bytes)` (so offsets agree); it has at least `maxUnits` units unless `complete`, and may have a
 * few more. `complete`: every byte was decoded. Invalid bytes beyond the prefix are not seen.
 */
export function decodeTextPrefix(
  bytes: Uint8Array,
  maxUnits: number,
): { text: string; complete: boolean } {
  const [a, b, c] = bytes;
  let body = bytes;
  let label: "utf-8" | "utf-16le" = "utf-8";
  let bigEndian = false;
  if (a === 0xff && b === 0xfe) {
    body = bytes.subarray(2);
    label = "utf-16le";
  } else if (a === 0xfe && b === 0xff) {
    body = bytes.subarray(2);
    label = "utf-16le";
    bigEndian = true;
  } else if (a === 0xef && b === 0xbb && c === 0xbf) {
    body = bytes.subarray(3);
  }
  const units = Math.max(0, Math.floor(maxUnits));
  let end = body.length;
  if (label === "utf-16le") {
    if (body.length % 2 !== 0) reject("corrupt_content");
    const limit = 4 * units + 4; // CRLF is 4 bytes and one unit
    if (end > limit) {
      end = limit;
      const hi = body[end - (bigEndian ? 2 : 1)] as number;
      if (hi >= 0xd8 && hi <= 0xdb) end -= 2;
    }
  } else {
    const limit = 3 * units + 3;
    if (end > limit) {
      end = limit;
      while (end > 0 && ((body[end] as number) & 0xc0) === 0x80) end--;
    }
  }
  const part = body.subarray(0, end);
  const decoded = label === "utf-8" ? strict("utf-8", part) : utf16(part, bigEndian);
  const text = (decoded.startsWith("\ufeff") ? decoded.slice(1) : decoded).replace(/\r\n?/g, "\n");
  assertText(text);
  return { text, complete: end === body.length };
}

/** A heading title: trimmed, at most `max` UTF-16 units, never ending in half a surrogate pair. */
export function cutHeading(s: string, max = 500): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const last = t.charCodeAt(max - 1);
  return t.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
