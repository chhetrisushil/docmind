import { createWriteStream } from "node:fs";
import { createDefaultParsers } from "../defaults";
import { ParserRegistry } from "../registry";
import { type DocumentParser, ParseRejectedError } from "../types";
import {
  CHILD_DEADLINE_EXIT,
  CHILD_GRACE_MS,
  type ChildReply,
  type ChildRequest,
  encodeFrame,
} from "./protocol";

const reply = (message: ChildReply) => {
  createWriteStream("", { fd: 3 }).end(encodeFrame(message), () => process.exit(0));
};

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const frame = Buffer.concat(chunks);
  const request = JSON.parse(frame.subarray(4).toString("utf8")) as ChildRequest;
  // The parent SIGKILLs at its wall clock; this is the backstop if the parent is gone or stuck.
  // Unref'd, so it never keeps a finished child alive (it cannot fire inside a synchronous loop).
  const deadlineMs = Math.min(request.wallClockMs + CHILD_GRACE_MS, 2_147_483_647); // setTimeout's ceiling
  setTimeout(() => process.exit(CHILD_DEADLINE_EXIT), deadlineMs).unref();
  const parsers: DocumentParser[] = request.module
    ? (require(request.module) as { parsers: DocumentParser[] }).parsers
    : createDefaultParsers();
  // By id, never accepts(): a parser whose accepts() throws cannot crash a run here.
  const parser = new ParserRegistry(parsers).byId(request.parserId);
  if (!parser) return reply({ ok: false, kind: "failed" });
  const bytes = new Uint8Array(Buffer.from(request.bytes, "base64"));
  const doc = await parser.parse(bytes);
  if (typeof doc?.text === "string" && doc.text.length > request.maxChars) {
    return reply({ ok: false, kind: "rejected", code: "too_large" });
  }
  reply({ ok: true, doc });
}

main().catch((err) =>
  reply(
    err instanceof ParseRejectedError
      ? { ok: false, kind: "rejected", code: err.code }
      : { ok: false, kind: "failed" },
  ),
);
