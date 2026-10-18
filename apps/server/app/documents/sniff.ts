export const SNIFF_BYTES = 4096;

export type DocumentKind = "txt" | "md" | "org" | "doc" | "docx" | "pdf" | "png" | "jpg" | "webp";
export interface Sniffed {
  kind: DocumentKind;
  mime: string;
}

const MIME: Record<DocumentKind, string> = {
  txt: "text/plain",
  md: "text/markdown",
  org: "text/x-org",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};
const found = (kind: DocumentKind): Sniffed => ({ kind, mime: MIME[kind] });

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((byte, i) => b[at + i] === byte);

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
};

// C0 controls other than TAB, LF, VT, FF, CR and ESC mark binary content.
const isBinaryByte = (byte: number): boolean =>
  byte < 0x20 && ![0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b].includes(byte);

function looksLikeText(head: Uint8Array): boolean {
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) return true; // UTF-16 BOM
  return head.every((byte) => !isBinaryByte(byte));
}

/**
 * What a file is, decided from its first bytes. The extension is a hint that only breaks ties the
 * bytes cannot: OLE2 and ZIP containers are shared by many Office formats, and text has no
 * signature. `filename` must already be sanitized. Returns null for anything unsupported.
 * (Deep validation of docx and pdf is the M3 parsers' job, inside the sandbox.)
 */
export function sniff(head: Uint8Array, filename: string): Sniffed | null {
  if (head.length === 0) return null;
  const ext = extensionOf(filename);
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return found("pdf"); // %PDF-
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return found("png");
  if (startsWith(head, [0xff, 0xd8, 0xff])) return found("jpg");
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
    return found("webp"); // RIFF....WEBP
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return ext === "doc" ? found("doc") : null;
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return ext === "docx" ? found("docx") : null;
  if (!looksLikeText(head)) return null;
  if (ext === "txt") return found("txt");
  if (ext === "md" || ext === "markdown") return found("md");
  if (ext === "org") return found("org");
  return null;
}

const MAX_NAME_CODE_POINTS = 200;

// Control characters and the bidi overrides that make a name display as something else.
const isUnsafeCodePoint = (cp: number): boolean =>
  cp <= 0x1f ||
  (cp >= 0x7f && cp <= 0x9f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2066 && cp <= 0x2069);

const stripUnsafe = (s: string): string =>
  Array.from(s)
    .filter((ch) => !isUnsafeCodePoint(ch.codePointAt(0) ?? 0))
    .join("");

/** A display-safe base name. Never used to build a path; the original is not kept. */
export function sanitizeFilename(raw: string): string {
  const base = stripUnsafe(raw.normalize("NFC")).split(/[\\/]/).pop() ?? "";
  const collapsed = base.replace(/\s+/g, " ").trim();
  const trimmed = Array.from(collapsed).slice(0, MAX_NAME_CODE_POINTS).join("").trim();
  return trimmed === "" || /^\.+$/.test(trimmed) ? "untitled" : trimmed;
}

/** The default title: the file name without its last extension. */
export function titleFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
