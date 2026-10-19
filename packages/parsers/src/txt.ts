import { type DocumentParser, ParseRejectedError, type ParsedDocument } from "./types";

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

/** UTF-16 written without a BOM has a NUL in every other byte of ASCII-range text. */
function bomlessUtf16(bytes: Uint8Array): "le" | "be" | undefined {
  const n = Math.min(bytes.length, 4096) & ~1;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) even++;
    if (bytes[i + 1] === 0) odd++;
  }
  const pairs = n / 2;
  if (pairs < 4) return undefined; // too short to tell UTF-16 from a stray NUL
  if (odd >= pairs * 0.3 && even === 0) return "le";
  if (even >= pairs * 0.3 && odd === 0) return "be";
  return undefined;
}

function decode(bytes: Uint8Array): string {
  const [a, b, c] = bytes;
  if (a === 0xff && b === 0xfe) return utf16(bytes.subarray(2), false);
  if (a === 0xfe && b === 0xff) return utf16(bytes.subarray(2), true);
  if (a === 0xef && b === 0xbb && c === 0xbf) return strict("utf-8", bytes.subarray(3));
  const guess = bomlessUtf16(bytes);
  if (guess) return utf16(bytes, guess === "be");
  return strict("utf-8", bytes);
}

const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b]);
const UNASSIGNED_OR_PRIVATE = /[\p{Cn}\p{Co}\p{Cs}]/u;

/** Binary data decodes to controls, noncharacters or unassigned code points; real text does not. */
function assertText(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const cu = text.charCodeAt(i);
    if (cu < 0x20 ? !ALLOWED_CONTROLS.has(cu) : cu >= 0x7f && cu <= 0x9f) {
      reject("unsupported_content");
    }
    if (cu < 0x7f) continue; // ASCII fast path
    const ch = String.fromCodePoint(text.codePointAt(i) as number);
    if (UNASSIGNED_OR_PRIVATE.test(ch)) reject("unsupported_content");
    if (ch.length === 2) i++;
  }
}

export const txtParser: DocumentParser = {
  id: "txt",
  accepts: (mime, ext) => mime === "text/plain" || ext?.toLowerCase() === "txt",
  parse(bytes): ParsedDocument {
    const text = decode(bytes).replace(/\r\n?/g, "\n");
    assertText(text);
    if (text.trim() === "") return { text: "", sections: [], media: [] };
    return {
      text,
      sections: [{ headingPath: [], text, locator: { kind: "chars", start: 0, end: text.length } }],
      media: [],
    };
  },
};
