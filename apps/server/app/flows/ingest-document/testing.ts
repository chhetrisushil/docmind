import { ParserRegistry, createDefaultParsers } from "@docmind/parsers";
import type { IngestDeps } from "./deps";

/** Fakes of every ingest port, for tests that run the flow over an in-memory Loom app. */
export function fakeIngestDeps(over: Partial<IngestDeps> = {}): IngestDeps {
  return {
    guard: { begin: async () => {} },
    source: {
      meta: async () => ({ mime: "text/plain", contentAddress: "a" }),
      read: async () => new Uint8Array([104]),
    },
    parsed: { put: async () => {}, take: async () => undefined, drop: async () => {} },
    registry: new ParserRegistry(createDefaultParsers()),
    runner: {
      run: async () => ({
        text: "h",
        sections: [
          { headingPath: [], text: "h", locator: { kind: "chars" as const, start: 0, end: 1 } },
        ],
        media: [],
      }),
    },
    ...over,
  };
}
