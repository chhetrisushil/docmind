import { createDefaultParsers } from "../defaults";
import { ParserRegistry } from "../registry";
import { type DocumentParser, ParseRejectedError } from "../types";
import type { ChildReply, ChildRequest } from "./protocol";

const reply = (message: ChildReply) => process.send?.(message, () => process.exit(0));

// The child looks the parser up by id and never calls accepts(): a parser whose accepts() throws
// cannot crash a run here. Anything thrown by load or parse becomes the fixed "failed" reply.
process.once("message", async (request: ChildRequest) => {
  try {
    const parsers: DocumentParser[] = request.module
      ? (require(request.module) as { parsers: DocumentParser[] }).parsers
      : createDefaultParsers();
    const parser = new ParserRegistry(parsers).byId(request.parserId);
    if (!parser) return reply({ ok: false, kind: "failed" });
    reply({ ok: true, doc: await parser.parse(request.bytes) });
  } catch (err) {
    reply(
      err instanceof ParseRejectedError
        ? { ok: false, kind: "rejected", code: err.code }
        : { ok: false, kind: "failed" },
    );
  }
});
