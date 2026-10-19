import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import {
  PARSE_REJECT_CODES,
  type ParseRejectCode,
  ParseRejectedError,
  ParsedDocument,
} from "../types";
import { type ChildReply, type ChildRequest, MAX_REPLY_BYTES, encodeFrame } from "./protocol";

export interface ParseLimits {
  wallClockMs: number;
  memoryMb: number;
}
export interface ParseRunnerOptions {
  limits: ParseLimits;
  /** The compiled child entry. Default: `dist/runner/child.js` next to or above this file. */
  childEntry?: string;
  /** Tests only: a CommonJS file exporting `parsers`. */
  parserModule?: string;
}

export class ParseCrashedError extends Error {
  constructor() {
    super("parse crashed");
    this.name = "ParseCrashedError";
  }
}
const pkgJsonDir = (name: string): string => dirname(require.resolve(`${name}/package.json`));
/** Own built files, contracts' dist + package.json, zod as resolved: never src, .turbo or node_modules. */
const readablePaths = (entry: string): string[] => {
  const distDir = dirname(dirname(entry));
  const nm = join(dirname(distDir), "node_modules");
  const contracts = pkgJsonDir("@docmind/contracts");
  const zod = pkgJsonDir("zod");
  return [
    distDir,
    join(dirname(distDir), "package.json"),
    join(contracts, "dist"),
    join(contracts, "package.json"),
    zod,
    // The resolver reads the symlinked spellings first.
    join(nm, "@docmind/contracts"),
    join(nm, "@docmind/contracts/dist"),
    join(nm, "@docmind/contracts/package.json"),
    join(nm, "zod"),
    join(contracts, "node_modules/zod"),
  ];
};

const defaultEntry = (): string => {
  const sibling = join(__dirname, "child.js");
  return existsSync(sibling) ? sibling : join(__dirname, "../../dist/runner/child.js");
};

/**
 * Runs a parser on untrusted bytes in a fresh Node process: no filesystem beyond its own code, no
 * child processes, no inherited environment (the KEK and database URLs never reach it). There is no
 * Node IPC channel (a parser could poison it): the request is one length-prefixed JSON frame on
 * the child's stdin, the reply one frame on fd 3, read with a byte cap and validated strictly;
 * anything malformed is ParseCrashedError. stdout/stderr are ignored; every pipe is destroyed and
 * the child SIGKILLed on every path through the `finally`. Network access is not covered by Node's
 * permission model (documented limit).
 */
export class ParseRunner {
  constructor(private readonly options: ParseRunnerOptions) {}

  async run(parserId: string, bytes: Uint8Array): Promise<ParsedDocument> {
    const { limits } = this.options;
    const entry = this.options.childEntry ?? defaultEntry();
    const readable = readablePaths(entry);
    if (this.options.parserModule) readable.push(dirname(this.options.parserModule));
    const args = [
      "--permission",
      ...readable.map((p) => `--allow-fs-read=${p}`),
      `--max-old-space-size=${limits.memoryMb}`,
      entry,
    ];
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "ignore", "ignore", "pipe"],
      env: {},
      cwd: dirname(entry),
    });
    child.on("error", () => {}); // spawn/kill failures: 69a2 maps no-reply ends to a rejection
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const request: ChildRequest = {
        parserId,
        bytes: Buffer.from(bytes).toString("base64"),
        module: this.options.parserModule,
      };
      return await this.exchange(child, request);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdin?.destroy();
      child.stdio[3]?.destroy();
      await exited;
    }
  }

  private exchange(child: ChildProcess, request: ChildRequest): Promise<ParsedDocument> {
    return new Promise((resolve, reject) => {
      const out = child.stdio[3] as Readable;
      const parts: Buffer[] = [];
      let have = 0;
      let settled = false;
      const crash = () => {
        if (!settled) reject(new ParseCrashedError());
        settled = true;
      };
      const finish = (frame: Buffer) => {
        if (settled) return;
        settled = true;
        try {
          resolve(decodeReply(frame));
        } catch (err) {
          reject(err);
        }
      };
      out.on("error", crash);
      out.on("close", crash); // a truncated or empty frame
      out.on("data", (chunk: Buffer) => {
        parts.push(chunk);
        have += chunk.length;
        if (have < 4) return;
        const all = Buffer.concat(parts);
        const len = all.readUInt32BE(0);
        if (len > MAX_REPLY_BYTES || have > 4 + len) return crash(); // oversized or extra bytes
        if (have === 4 + len) finish(all.subarray(4));
      });
      child.stdin?.on("error", crash);
      child.stdin?.end(encodeFrame(request));
    });
  }
}

/** Strict reply validation; every failure is the same fixed error. */
const decodeReply = (body: Buffer): ParsedDocument => {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new ParseCrashedError();
  }
  const r = raw as Partial<ChildReply> | null;
  if (r && typeof r === "object" && r.ok === true) {
    const doc = ParsedDocument.safeParse((r as { doc?: unknown }).doc);
    if (doc.success) return doc.data;
  } else if (r && typeof r === "object" && r.ok === false && "kind" in r && r.kind === "rejected") {
    const code = (r as { code?: unknown }).code;
    if (PARSE_REJECT_CODES.some((c) => c === code)) {
      throw new ParseRejectedError(code as ParseRejectCode);
    }
  }
  throw new ParseCrashedError();
};
