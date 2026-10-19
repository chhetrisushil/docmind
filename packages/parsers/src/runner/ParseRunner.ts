import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ParseRejectedError, ParsedDocument } from "../types";
import type { ChildReply, ChildRequest } from "./protocol";

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
/** The real (symlink-resolved) directory of a dependency, which the permission model needs spelled out. */
const packageRoot = (name: string): string => dirname(require.resolve(`${name}/package.json`));

/** Both spellings: the child's resolver reads the symlinked `node_modules/<name>` path first. */
const packagePaths = (pkgDir: string, name: string): string[] => [
  packageRoot(name),
  join(pkgDir, "node_modules", name),
];

const defaultEntry = (): string => {
  const sibling = join(__dirname, "child.js");
  return existsSync(sibling) ? sibling : join(__dirname, "../../dist/runner/child.js");
};

/**
 * Runs a parser on untrusted bytes in a fresh Node process: no filesystem beyond its own code, no
 * child processes, no inherited environment (the KEK and database URLs never reach it), stdio
 * ignored so a parser cannot block on a full pipe, killed with SIGKILL on every path that reaches
 * the `finally`. Network access is not covered by Node's permission model (documented limit).
 */
export class ParseRunner {
  constructor(private readonly options: ParseRunnerOptions) {}

  async run(parserId: string, bytes: Uint8Array): Promise<ParsedDocument> {
    const { limits } = this.options;
    const entry = this.options.childEntry ?? defaultEntry();
    const distDir = dirname(dirname(entry));
    const pkgDir = dirname(distDir);
    const readable = [
      distDir, // the compiled package: the child's own code
      join(pkgDir, "package.json"),
      ...packagePaths(pkgDir, "@docmind/contracts"),
      ...packagePaths(pkgDir, "zod"),
      ...(this.options.parserModule ? [dirname(this.options.parserModule)] : []),
    ];
    const child = fork(entry, [], {
      execArgv: [
        "--permission",
        ...readable.map((p) => `--allow-fs-read=${p}`),
        `--max-old-space-size=${limits.memoryMb}`,
      ],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
      env: {},
      cwd: dirname(entry),
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      return await this.exchange(child, { parserId, bytes, module: this.options.parserModule });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  }

  private exchange(child: ChildProcess, request: ChildRequest): Promise<ParsedDocument> {
    return new Promise((resolve, reject) => {
      child.once("message", (raw: ChildReply) => {
        if (raw && raw.ok === true) {
          const doc = ParsedDocument.safeParse(raw.doc);
          return doc.success ? resolve(doc.data) : reject(new ParseCrashedError());
        }
        if (raw && raw.ok === false && raw.kind === "rejected") {
          return reject(new ParseRejectedError(raw.code));
        }
        reject(new ParseCrashedError());
      });
      child.send(request, (err) => {
        if (err) reject(new ParseCrashedError());
      });
    });
  }
}
