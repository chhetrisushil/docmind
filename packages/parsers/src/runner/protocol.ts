import type { ParseRejectCode, ParsedDocument } from "../types";

/** Parent to child. `module` (tests only) replaces the default parser list. */
export interface ChildRequest {
  parserId: string;
  bytes: Uint8Array;
  module?: string;
}
/** Child to parent. Nothing but a document, a rejection code or "failed": never a message or stack. */
export type ChildReply =
  | { ok: true; doc: ParsedDocument }
  | { ok: false; kind: "rejected"; code: ParseRejectCode }
  | { ok: false; kind: "failed" };
