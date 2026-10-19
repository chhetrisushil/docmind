import { Locator } from "@docmind/contracts";
import { z } from "zod";

export const ParsedSection = z.object({
  headingPath: z.array(z.string().max(500)).max(16),
  text: z.string(),
  locator: Locator,
});
export type ParsedSection = z.infer<typeof ParsedSection>;

export const ParsedMedia = z.object({ mime: z.string().max(100), locator: Locator });
export type ParsedMedia = z.infer<typeof ParsedMedia>;

/** What every parser produces (spec 5.2). `text` is the whole document; sections slice it by locator. */
export const ParsedDocument = z.object({
  text: z.string(),
  sections: z.array(ParsedSection),
  media: z.array(ParsedMedia),
});
export type ParsedDocument = z.infer<typeof ParsedDocument>;

export interface DocumentParser {
  readonly id: string;
  /** The sniffed mime is authoritative; `ext` is only a hint and may be absent. */
  accepts(mime: string, ext?: string): boolean;
  parse(bytes: Uint8Array): ParsedDocument | Promise<ParsedDocument>;
}

export const PARSE_REJECT_CODES = ["unsupported_content", "corrupt_content", "too_large"] as const;
export type ParseRejectCode = (typeof PARSE_REJECT_CODES)[number];

/** The bytes are not a document this parser can read. Permanent: retrying the same bytes cannot help. */
export class ParseRejectedError extends Error {
  constructor(readonly code: ParseRejectCode) {
    super(`parse rejected: ${code}`);
    this.name = "ParseRejectedError";
  }
}
