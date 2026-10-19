import type { DocumentParser } from "./types";

/** Parsers by id. Built by the composition root; there is no global registry. */
export class ParserRegistry {
  constructor(private readonly parsers: readonly DocumentParser[]) {
    const seen = new Set<string>();
    parsers.forEach((p, i) => {
      if (seen.has(p.id)) throw new Error(`duplicate parser id at position ${i}`);
      seen.add(p.id);
    });
  }
  select(mime: string, ext?: string): DocumentParser | undefined {
    return this.parsers.find((p) => p.accepts(mime, ext));
  }
  byId(id: string): DocumentParser | undefined {
    return this.parsers.find((p) => p.id === id);
  }
  ids(): string[] {
    return this.parsers.map((p) => p.id);
  }
}
