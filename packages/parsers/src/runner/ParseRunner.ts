import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import {
  PARSE_REJECT_CODES,
  type ParseRejectCode,
  ParseRejectedError,
  ParsedDocument,
} from "../types";
import { type ChildReply, type ChildRequest, encodeFrame, maxReplyBytes } from "./protocol";

export interface ParseLimits {
  wallClockMs: number;
  memoryMb: number;
  /** Largest input the parent will hand to a child. */
  maxInputBytes: number;
  /** Longest parsed text (UTF-16 code units) a parse may return; over it is too_large. */
  maxChars: number;
}
export interface ParseRunnerOptions {
  limits: ParseLimits;
  /** The compiled child entry. Default: `dist/runner/child.js` next to or above this file. */
  childEntry?: string;
  /** Tests only: a CommonJS file exporting `parsers`. */
  parserModule?: string;
  /** Tests only: the Node executable to spawn. */
  executable?: string;
}

export class ParseCrashedError extends Error {
  constructor() {
    super("parse crashed");
    this.name = "ParseCrashedError";
  }
}
export class ParseTimeoutError extends Error {
  constructor() {
    super("parse timed out");
    this.name = "ParseTimeoutError";
  }
}
export class ParseLimitError extends Error {
  constructor(readonly limit: "input") {
    super(`parse ${limit} over limit`);
    this.name = "ParseLimitError";
  }
}
/** Bare specifiers the child's built code imports, resolved by the parent to real files. */
const BARE_SPECIFIERS = ["@docmind/contracts", "zod"] as const;
const real = (p: string): string => realpathSync(p);
const specifierMap = (): Record<string, string> =>
  Object.fromEntries(BARE_SPECIFIERS.map((name) => [name, real(require.resolve(name))]));
/** Own built files and the real dirs of the two dependencies: no node_modules path, no src. */
const readablePaths = (entry: string, map: Record<string, string>): string[] => {
  const distDir = dirname(dirname(entry));
  const contractsPkg = real(require.resolve("@docmind/contracts/package.json"));
  return [
    distDir,
    join(dirname(distDir), "package.json"),
    dirname(map["@docmind/contracts"] as string), // contracts' dist
    contractsPkg,
    dirname(real(require.resolve("zod/package.json"))),
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
  private readonly live = new Set<ChildProcess>();

  /** Children currently alive (spawned and not yet exited). */
  active(): number {
    return this.live.size;
  }

  constructor(private readonly options: ParseRunnerOptions) {
    const { wallClockMs, memoryMb, maxInputBytes, maxChars } = options.limits;
    if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1) {
      throw new RangeError("limits.maxInputBytes must be a positive integer");
    }
    // The reply frame length is a uint32: 100M chars * 12 + 8 MiB still fits.
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 100_000_000) {
      throw new RangeError("limits.maxChars must be a positive integer of at most 100000000");
    }
    if (!Number.isInteger(wallClockMs) || wallClockMs < 1 || wallClockMs > 2147483647) {
      throw new RangeError("limits.wallClockMs must be an integer in 1..2147483647");
    }
    if (!Number.isInteger(memoryMb) || memoryMb < 1) {
      throw new RangeError("limits.memoryMb must be a positive integer");
    }
  }

  async run(parserId: string, bytes: Uint8Array): Promise<ParsedDocument> {
    const { limits } = this.options;
    if (bytes.byteLength > limits.maxInputBytes) throw new ParseLimitError("input");
    const entry = this.options.childEntry ?? defaultEntry();
    const map = specifierMap();
    const readable = readablePaths(entry, map);
    if (this.options.parserModule) readable.push(dirname(this.options.parserModule));
    const args = [
      "--permission",
      ...readable.map((p) => `--allow-fs-read=${p}`),
      `--max-old-space-size=${limits.memoryMb}`,
      entry,
      JSON.stringify(map),
    ];
    const child = spawn(this.options.executable ?? process.execPath, args, {
      stdio: ["pipe", "ignore", "ignore", "pipe"],
      env: {},
      cwd: dirname(entry),
    });
    this.live.add(child);
    // Spawn failures (ENOENT, EACCES, EAGAIN) emit 'error' and never 'exit'; kill failures emit it too.
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.on("error", () => {
        if (child.pid === undefined) resolve(); // never started: no exit will come
      });
    });
    // Never started, or stdio unassigned (EMFILE): nothing to exchange with.
    if (child.pid === undefined || !child.stdin || !child.stdio?.[3]) {
      child.stdin?.destroy();
      child.stdio?.[3]?.destroy();
      this.live.delete(child);
      throw new ParseCrashedError();
    }
    try {
      const request: ChildRequest = {
        parserId,
        bytes: Buffer.from(bytes).toString("base64"),
        module: this.options.parserModule,
        maxChars: limits.maxChars,
      };
      return await this.exchange(child, request);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdin?.destroy();
      child.stdio?.[3]?.destroy();
      await exited;
      this.live.delete(child);
    }
  }

  private exchange(child: ChildProcess, request: ChildRequest): Promise<ParsedDocument> {
    return new Promise((resolve, reject) => {
      const out = child.stdio[3] as Readable;
      const cap = maxReplyBytes(this.options.limits.maxChars);
      const parts: Buffer[] = [];
      let have = 0;
      let settled = false;
      const settle = (err: Error) => {
        clearTimeout(timer);
        if (!settled) reject(err);
        settled = true;
      };
      const crash = () => settle(new ParseCrashedError());
      // The wall clock only rejects; the caller's `finally` SIGKILLs the child and closes the pipes.
      const timer: NodeJS.Timeout = setTimeout(
        () => settle(new ParseTimeoutError()),
        this.options.limits.wallClockMs,
      );
      const finish = (frame: Buffer) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        try {
          const doc = decodeReply(frame);
          // The child checks too, but a compromised child cannot skip the parent's check.
          if (doc.text.length > this.options.limits.maxChars)
            throw new ParseRejectedError("too_large");
          resolve(doc);
        } catch (err) {
          reject(err);
        }
      };
      out.on("error", crash);
      out.on("close", crash); // a truncated or empty frame
      out.on("data", (chunk: Buffer) => {
        if (settled) return;
        parts.push(chunk);
        have += chunk.length;
        if (have < 4) return;
        const head = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
        const len = head.readUInt32BE(0);
        if (len > cap || have > 4 + len) return crash(); // oversized or extra bytes
        if (have < 4 + len) return; // keep chunks; concatenate once, when complete
        finish(head.subarray(4));
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
