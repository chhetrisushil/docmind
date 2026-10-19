import { describe, expect, it } from "vitest";
import {
  type DocumentParser,
  PARSE_REJECT_CODES,
  ParseRejectedError,
  ParsedDocument,
} from "../types";

export interface ParserFixtures {
  valid: { name: string; bytes: Uint8Array; mime: string; ext?: string }[];
  /** Bytes of the right container but unreadable content, or plain garbage. */
  rejected: { name: string; bytes: Uint8Array }[];
}
type Check = (parser: DocumentParser, fixtures: ParserFixtures) => Promise<string | undefined>;

const copy = (b: Uint8Array) => Uint8Array.from(b);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const CHECKS: Record<string, Check> = {
  "has a non-empty id": async (p) => (p.id.length > 0 ? undefined : "empty id"),

  "accepts its own types and not others": async (p, f) => {
    for (const v of f.valid) {
      if (!p.accepts(v.mime, v.ext)) return `${v.name}: does not accept ${v.mime}`;
      if (v.ext && !p.accepts("application/octet-stream", v.ext.toUpperCase())) {
        return `${v.name}: extension match is case sensitive`;
      }
    }
    return p.accepts("application/x-docmind-unknown")
      ? "accepts application/x-docmind-unknown"
      : undefined;
  },

  "produces a valid ParsedDocument": async (p, f) => {
    for (const v of f.valid) {
      const out = ParsedDocument.safeParse(await p.parse(copy(v.bytes)));
      if (!out.success) return `${v.name}: output fails the ParsedDocument schema`;
    }
    return undefined;
  },

  "section locators slice the text": async (p, f) => {
    for (const v of f.valid) {
      const doc = await p.parse(copy(v.bytes));
      for (const [i, s] of doc.sections.entries()) {
        if (s.locator.kind !== "chars") continue;
        if (doc.text.slice(s.locator.start, s.locator.end) !== s.text) {
          return `${v.name}: section ${i} does not equal text.slice(${s.locator.start}, ${s.locator.end})`;
        }
      }
    }
    return undefined;
  },

  "is deterministic": async (p, f) => {
    for (const v of f.valid) {
      if (!same(await p.parse(copy(v.bytes)), await p.parse(copy(v.bytes))))
        return `${v.name}: two parses differ`;
    }
    return undefined;
  },

  "does not modify its input": async (p, f) => {
    for (const v of f.valid) {
      const input = copy(v.bytes);
      await p.parse(input);
      if (!same([...input], [...v.bytes])) return `${v.name}: the input bytes were modified`;
    }
    return undefined;
  },

  "rejects what it cannot read with ParseRejectedError": async (p, f) => {
    for (const r of f.rejected) {
      try {
        await p.parse(copy(r.bytes));
        return `${r.name}: did not reject`;
      } catch (err) {
        if (!(err instanceof ParseRejectedError)) {
          return `${r.name}: threw ${err instanceof Error ? err.constructor.name : typeof err}, not ParseRejectedError`;
        }
        if (!PARSE_REJECT_CODES.includes(err.code)) return `${r.name}: unknown code`;
      }
    }
    return undefined;
  },
};

export function runDocumentParserConformance(
  factory: () => DocumentParser,
  fixtures: ParserFixtures,
  label = "DocumentParser",
): void {
  describe(`${label} conformance (DocumentParser)`, () => {
    for (const [name, check] of Object.entries(CHECKS)) {
      it(name, async () => expect(await check(factory(), fixtures)).toBeUndefined());
    }
  });
}
