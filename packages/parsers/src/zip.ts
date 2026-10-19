import { inflateRawSync } from "node:zlib";
import { ParseRejectedError } from "./types";

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

const MiB = 1024 * 1024;
export const docxZipLimits = (inputBytes: number): ZipLimits => ({
  maxEntries: 2000,
  maxEntryBytes: 64 * MiB,
  maxTotalBytes: Math.min(512 * MiB, 64 * inputBytes),
});

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const reject = (code: "too_large" | "corrupt_content" | "unsupported_content"): never => {
  throw new ParseRejectedError(code);
};

/**
 * A docx is a zip: before any zip library inflates it, check what it would cost (M3b D5). Declared
 * sizes are not trusted: every deflated entry is inflated here with its declared size as a hard
 * output cap, so a forged directory fails instead of inflating without bound. Stored and deflated
 * entries only; ZIP64, multi-disk and encrypted archives are refused (a docx never needs them).
 */
export function zipBudget(bytes: Uint8Array, limits: ZipLimits): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) =>
    at >= 0 && at + 2 <= bytes.length ? view.getUint16(at, true) : reject("corrupt_content");
  const u32 = (at: number) =>
    at >= 0 && at + 4 <= bytes.length ? view.getUint32(at, true) : reject("corrupt_content");

  // The end-of-central-directory record is in the last 22 + 65535 bytes. An archive shorter than 22
  // bytes has no valid record: the loop does not run and eocd stays -1.
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) reject("corrupt_content");
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0) reject("unsupported_content"); // multi-disk
  const count = u16(eocd + 10);
  const dirSize = u32(eocd + 12);
  const dirOffset = u32(eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff)
    reject("unsupported_content"); // ZIP64
  if (count > limits.maxEntries) reject("too_large");
  if (dirOffset + dirSize > eocd) reject("corrupt_content");

  let at = dirOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (u32(at) !== CENTRAL) reject("corrupt_content");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const compressed = u32(at + 20);
    const declared = u32(at + 24);
    const nameLen = u16(at + 28);
    const extraLen = u16(at + 30);
    const commentLen = u16(at + 32);
    const local = u32(at + 42);
    if (compressed === 0xffffffff || declared === 0xffffffff || local === 0xffffffff)
      reject("unsupported_content");
    if (flags & 0x1) reject("unsupported_content"); // encrypted
    if (method !== 0 && method !== 8) reject("unsupported_content");
    if (declared > limits.maxEntryBytes) reject("too_large");
    total += declared;
    if (total > limits.maxTotalBytes) reject("too_large");
    if (u32(local) !== LOCAL) reject("corrupt_content");
    const dataStart = local + 30 + u16(local + 26) + u16(local + 28);
    if (dataStart + compressed > dirOffset) reject("corrupt_content");
    const data = bytes.subarray(dataStart, dataStart + compressed);
    if (method === 0) {
      if (compressed !== declared) reject("corrupt_content");
    } else {
      let inflated: Buffer;
      try {
        // One byte past the declared size: reaching it proves the entry lies.
        inflated = inflateRawSync(data, { maxOutputLength: declared + 1 });
      } catch {
        throw new ParseRejectedError("corrupt_content"); // a lying size (RangeError at the cap) or a broken stream
      }
      if (inflated.length !== declared) reject("corrupt_content");
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
}
