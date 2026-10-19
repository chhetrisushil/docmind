// Bundle entry: scripts/bundle-child.mjs inlines this file and every dependency into
// dist/child/child.cjs, the one file (and directory) the sandboxed child may read.
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

// Captured before any parser module loads, so replacing process.exit, process.kill or
// process._kill cannot disarm the deadline timer. A parser that reaches the native binding by other
// means is not stopped here; a CPU-burning one is still reaped by the kernel limit (limitedSpawn).
const reallyExit = (process as unknown as { reallyExit(code: number): never }).reallyExit;

const reply = (message: ChildReply) => {
  createWriteStream("", { fd: 3 }).end(encodeFrame(message), () => process.exit(0));
};

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const frame = Buffer.concat(chunks);
  const request = JSON.parse(frame.subarray(4).toString("utf8")) as ChildRequest;
  // Second layer behind the kernel CPU limit (see limitedSpawn): ends an idle hang when the parent
  // is gone. Unref'd, so it never keeps a finished child alive; it cannot fire in a synchronous loop.
  const deadlineMs = Math.min(request.wallClockMs + CHILD_GRACE_MS, 2_147_483_647); // setTimeout's ceiling
  setTimeout(() => reallyExit.call(process, CHILD_DEADLINE_EXIT), deadlineMs).unref();
  // A non-literal require stays a run-time require in the bundle (the parserModule test seam).
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
