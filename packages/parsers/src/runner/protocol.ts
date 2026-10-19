import type { ParseRejectCode, ParsedDocument } from "../types";

/** Parent to child, as one frame on stdin. `module` (tests only) replaces the default parser list. */
export interface ChildRequest {
  parserId: string;
  /** base64 of the document bytes. */
  bytes: string;
  module?: string;
  /** The child refuses text longer than this (too_large) before it serialises the reply. */
  maxChars: number;
}
/** Child to parent, as one frame on fd 3. Nothing but a document, a rejection code or "failed". */
export type ChildReply =
  | { ok: true; doc: ParsedDocument }
  | { ok: false; kind: "rejected"; code: ParseRejectCode }
  | { ok: false; kind: "failed" };

/**
 * Largest reply frame body for a character cap. Assumption: the reply carries the text at most
 * twice (the text and the sections that slice it) and JSON escapes a UTF-16 unit as up to 6 bytes
 * (\uXXXX), so 12 bytes a character, plus 8 MiB for locators, media and framing.
 */
export const maxReplyBytes = (maxChars: number): number => maxChars * 12 + 8 * 1024 * 1024;

/** Frame = 4-byte big-endian length + UTF-8 JSON body. */
export const encodeFrame = (value: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
};
