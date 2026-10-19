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
