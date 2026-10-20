import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned: ChildProcess[] = [];
const handSpawned: ChildProcess[] = [];
const runners: { close(): Promise<void> }[] = [];
let stdiolessSpawn = false;
let spawnCommand: string | null = null;
let onSpawn: (() => void) | null = null;
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const real = actual.spawn as (...a: unknown[]) => ChildProcess;
      const child = real(spawnCommand ?? args[0], ...args.slice(1));
      if (stdiolessSpawn) {
        child.kill("SIGKILL");
        return { pid: undefined, once: () => {}, on: () => {} } as unknown as ChildProcess;
      }
      spawned.push(child);
      onSpawn?.();
      return child;
    }) as typeof actual.spawn,
  };
});

import {
  ParseAbortedError,
  ParseCrashedError,
  ParseLimitError,
  ParseMemoryError,
  ParseRunner,
  type ParseRunnerOptions,
  ParseTimeoutError,
} from "./ParseRunner";
import { setRunnerInternals } from "./internals";
import { encodeFrame, limitedSpawn } from "./protocol";

const LIMITS = { wallClockMs: 10_000, memoryMb: 256, maxInputBytes: 1024, maxChars: 500 };
const hostile = resolve(__dirname, "../../test-fixtures/hostile.cjs");
/** A runner whose test-only internals (the parser module) are set through the hidden table. */
const withModule = (options: ParseRunnerOptions, parserModule?: string): ParseRunner => {
  const r = new ParseRunner(options);
  runners.push(r);
  if (parserModule) setRunnerInternals(r, { parserModule });
  return r;
};
const runner = (parserModule: string | null = hostile, limits = LIMITS) =>
  withModule({ limits }, parserModule ?? undefined);
const limited = (over: Partial<typeof LIMITS>) => runner(hostile, { ...LIMITS, ...over });
const bytes = (s: string) => new TextEncoder().encode(s);
const released = () => {
  expect(spawned).toHaveLength(1);
  const child = spawned[0] as ChildProcess;
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(child.stdin?.destroyed).toBe(true);
  expect(child.stdio[3]?.destroyed).toBe(true);
  expect(child.listenerCount("exit")).toBe(0);
};

// No test may leave a child behind: close every runner, then kill anything still alive.
afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.close()));
  for (const c of [...spawned, ...handSpawned.splice(0)]) {
    if (c.pid !== undefined && c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  }
});

describe("ParseRunner", () => {
  beforeEach(() => {
    spawned.length = 0;
  });

  it("runs the real txt parser in a child and returns a validated document", async () => {
    const doc = await runner(null).run("txt", bytes("hello\nworld"));
    expect(doc.text).toBe("hello\nworld");
    expect(doc.sections).toHaveLength(1);
    released();
  });

  it("runs a test-module parser and returns its text", async () => {
    expect((await runner().run("echo", bytes("echoed"))).text).toBe("echoed");
    released();
  });

  it("maps a parser's rejection to ParseRejectedError with its code", async () => {
    const run = runner(null).run("txt", Uint8Array.from([0x41, 0, 0x42]));
    await expect(run).rejects.toMatchObject({
      name: "ParseRejectedError",
      code: "unsupported_content",
    });
    released();
  });

  it("maps an unknown parser id to a fixed crash error", async () => {
    await expect(runner().run("nope", bytes("x"))).rejects.toBeInstanceOf(ParseCrashedError);
    released();
  });

  it("never carries a thrown message: parse() throwing becomes a fixed crash", async () => {
    const run = runner().run("throws-parse", bytes("x"));
    await expect(run).rejects.toMatchObject({
      name: "ParseCrashedError",
      message: "parse crashed",
    });
    released();
  });

  it("does not call accepts() in the child: a throwing accepts() cannot crash a run", async () => {
    expect((await runner().run("throws-accepts", bytes("x"))).text).toBe("fine");
    released();
  });

  it("rejects a reply that fails ParsedDocument validation", async () => {
    const run = runner().run("bad-shape", bytes("x"));
    await expect(run).rejects.toMatchObject({
      name: "ParseCrashedError",
      message: "parse crashed",
    });
    released();
  });

  it.each(["garbage", "notjson", "oversized", "truncated", "extra"])(
    "a parser writing a bad frame to fd 3 (%s) yields a fixed crash and the parent survives",
    async (id) => {
      const run = runner().run(id, bytes("x"));
      await expect(run).rejects.toMatchObject({
        name: "ParseCrashedError",
        message: "parse crashed",
      });
      released();
    },
  );

  it("treats a reject code outside PARSE_REJECT_CODES as a crash without the smuggled text", async () => {
    const err = await runner()
      .run("badcode", bytes("x"))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParseCrashedError);
    expect(
      JSON.stringify([(err as Error).message, (err as { code?: unknown }).code]),
    ).not.toContain("SMUGGLED");
    released();
  });

  it("denies the child reads of packages/contracts/src", async () => {
    expect((await runner().run("readsrc", bytes("x"))).text).toBe("denied");
    released();
  });

  it("refuses a read one directory above the bundle (the grant is its directory only)", async () => {
    // The target exists (so ENOENT is not an acceptable outcome): packages/parsers/package.json.
    expect(existsSync(resolve(__dirname, "../../package.json"))).toBe(true);
    expect((await runner().run("escape-up", bytes("x"))).text).toBe("ERR_ACCESS_DENIED");
    released();
  });

  it("refuses a bare import the parent did not map (no node_modules resolution)", async () => {
    // zod is installed (hostile.cjs sits under packages/parsers), so MODULE_NOT_FOUND would be a false pass.
    expect(existsSync(resolve(__dirname, "../../node_modules/zod/package.json"))).toBe(true);
    expect((await runner().run("bare", bytes("x"))).text).toBe("ERR_ACCESS_DENIED");
    released();
  });

  it("kills a parser that never returns at the wall clock", async () => {
    const r = runner(hostile, { ...LIMITS, wallClockMs: 200 });
    await expect(r.run("spin", bytes("x"))).rejects.toBeInstanceOf(ParseTimeoutError);
    released();
    expect(spawned[0]?.signalCode).toBe("SIGKILL");
  });

  it.each(["exit", "signal"])(
    "a child that dies without a reply (%s) is a prompt crash",
    async (id) => {
      await expect(runner().run(id, bytes("x"))).rejects.toMatchObject({
        name: "ParseCrashedError",
        message: "parse crashed",
      });
      released();
    },
  );

  it("a parser that exhausts its heap is ParseMemoryError with a fixed message", async () => {
    const r = limited({ memoryMb: 32 });
    await expect(r.run("oom", bytes("x"))).rejects.toMatchObject({
      name: "ParseMemoryError",
      message: "parse ran out of memory",
    });
    released();
    expect(r.active()).toBe(0);
  });

  it("a child that exits 0 without writing a reply is a crash, not a hang", async () => {
    await expect(runner().run("exit0", bytes("x"))).rejects.toBeInstanceOf(ParseCrashedError);
    released();
  });

  it("a parser module that reads outside the grants while loading is a crash", async () => {
    const mod = resolve(__dirname, "../../test-fixtures/toplevel.cjs");
    await expect(runner(mod).run("x", bytes("x"))).rejects.toBeInstanceOf(ParseCrashedError);
    released();
  });

  it("a failed spawn (ENOENT) rejects with a crash instead of hanging", async () => {
    spawnCommand = "/nonexistent/node-binary";
    try {
      const r = new ParseRunner({ limits: LIMITS });
      await expect(r.run("txt", bytes("x"))).rejects.toBeInstanceOf(ParseCrashedError);
    } finally {
      spawnCommand = null;
    }
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.pid).toBeUndefined();
  });

  it("the exported constructor's options cannot carry the sandbox seams", () => {
    type Options = ConstructorParameters<typeof ParseRunner>[0];
    // @ts-expect-error not an option: it would widen the child's filesystem grants
    const a: Options = { limits: LIMITS, parserModule: "/x.cjs" };
    // @ts-expect-error not an option
    const b: Options = { limits: LIMITS, childEntry: "/x.js" };
    // @ts-expect-error not an option
    const c: Options = { limits: LIMITS, executable: "/bin/true" };
    // Even if a JavaScript caller passes them, the runner never reads them.
    const r = new ParseRunner(a);
    expect([b, c].length + r.active()).toBe(2);
  });

  it("a spawn that returns no stdio (EMFILE) rejects with a crash, not a TypeError", async () => {
    stdiolessSpawn = true;
    try {
      await expect(runner().run("echo", bytes("x"))).rejects.toBeInstanceOf(ParseCrashedError);
    } finally {
      stdiolessSpawn = false;
    }
  });

  it.each([
    [{ wallClockMs: 0 }, /limits\.wallClockMs must be/],
    [{ wallClockMs: 1.5 }, /limits\.wallClockMs must be/],
    [{ wallClockMs: 2147483648 }, /limits\.wallClockMs must be/],
    [{ memoryMb: 0 }, /limits\.memoryMb must be/],
    [{ memoryMb: Number.NaN }, /limits\.memoryMb must be/],
    [{ maxInputBytes: 0 }, /limits\.maxInputBytes must be/],
    [{ maxChars: 0 }, /limits\.maxChars must be/],
    [{ maxChars: 100_000_001 }, /limits\.maxChars must be/],
  ])("rejects invalid limits %#", (over, text) => {
    expect(() => new ParseRunner({ limits: { ...LIMITS, ...over } })).toThrow(text);
  });

  it("refuses an input over the limit before any process is started", async () => {
    const r = limited({ maxInputBytes: 4 });
    await expect(r.run("echo", bytes("12345"))).rejects.toMatchObject({
      name: "ParseLimitError",
      limit: "input",
    });
    expect(spawned).toHaveLength(0);
    expect(r.active()).toBe(0);
  });

  it("accepts an input exactly at the limit", async () => {
    expect((await limited({ maxInputBytes: 4 }).run("echo", bytes("1234"))).text).toBe("1234");
    released();
  });

  it("has fixed error messages", () => {
    expect(new ParseLimitError("input").message).toBe("parse input over limit");
    expect(new ParseLimitError("output").message).toBe("parse output over limit");
  });

  it("rejects text over maxChars as too_large", async () => {
    await expect(limited({ maxChars: 100 }).run("big", bytes("x"))).rejects.toMatchObject({
      name: "ParseRejectedError",
      code: "too_large",
    });
    released();
  });

  it("the child enforces maxChars before replying: 9 MiB of text would overflow the parent's reply cap", async () => {
    // Without the child check this would be a crash (oversized frame), not too_large.
    await expect(limited({ maxChars: 100 }).run("huge", bytes("x"))).rejects.toMatchObject({
      name: "ParseRejectedError",
      code: "too_large",
    });
    released();
  });

  it.each(["sectionbulk", "sectioncount", "headingbulk", "mediabulk"])(
    "the parent bounds the sections' text and headings and the section and media counts by maxChars (%s)",
    async (id) => {
      await expect(limited({ maxChars: 100 }).run(id, bytes("x"))).rejects.toMatchObject({
        name: "ParseLimitError",
        limit: "output",
      });
      released();
    },
  );

  it("accepts sections whose total text and count are exactly at maxChars", async () => {
    const r = limited({ maxChars: 150 });
    expect((await r.run("sectionbulk", bytes("x"))).sections).toHaveLength(5);
    released();
  });

  it("accepts text exactly at maxChars", async () => {
    expect((await limited({ maxChars: 1000 }).run("big", bytes("x"))).text).toHaveLength(1000);
    released();
  });

  it("the parent re-checks maxChars on a valid reply the child did not check", async () => {
    await expect(limited({ maxChars: 100 }).run("longvalid", bytes("x"))).rejects.toMatchObject({
      name: "ParseRejectedError",
      code: "too_large",
    });
    released();
  });

  it("the reply byte cap follows maxChars: a frame at the cap is accepted, one byte over is a crash", async () => {
    expect((await limited({ maxChars: 1 }).run("atcap", bytes("x"))).text).toBe("x");
    released();
    spawned.length = 0;
    await expect(limited({ maxChars: 1 }).run("overcap", bytes("x"))).rejects.toBeInstanceOf(
      ParseCrashedError,
    );
    released();
  });

  it("leaves no child behind after a success, a timeout or a crash", async () => {
    const r = limited({ wallClockMs: 300 });
    await r.run("echo", bytes("x"));
    await expect(r.run("spin", bytes("x"))).rejects.toBeInstanceOf(ParseTimeoutError);
    await expect(r.run("exit", bytes("x"))).rejects.toBeInstanceOf(ParseCrashedError);
    expect(r.active()).toBe(0);
    expect(spawned).toHaveLength(3);
    for (const c of spawned) expect(c.exitCode !== null || c.signalCode !== null).toBe(true);
  });

  it("a parser writing megabytes to stdout and stderr cannot block the run (stdio is not piped)", async () => {
    const r = runner();
    expect((await r.run("noisy", bytes("x"))).text).toBe("done");
    expect(r.active()).toBe(0);
    expect(spawned[0]?.stdout).toBeNull();
    expect(spawned[0]?.stderr).toBeNull();
    released();
  });
});

describe("ParseRunner concurrency and abort", () => {
  beforeEach(() => {
    spawned.length = 0;
    onSpawn = null;
  });
  const gated = (maxConcurrent: number) => withModule({ limits: LIMITS, maxConcurrent }, hostile);
  const spawns = (n: number) =>
    new Promise<void>((res) => {
      const check = () => {
        if (spawned.length >= n) res();
      };
      onSpawn = check;
      check();
    });
  const dead = (c?: ChildProcess) => c && (c.exitCode !== null || c.signalCode !== null);

  it("denies the child the filesystem, child processes and the parent's environment", async () => {
    process.env.DOCMIND_PROBE_SECRET = "must-not-reach-the-child";
    try {
      const out = JSON.parse((await runner().run("probe", bytes("x"))).text);
      expect(out).toEqual({
        read: "ERR_ACCESS_DENIED",
        write: "ERR_ACCESS_DENIED",
        spawn: "ERR_ACCESS_DENIED",
        env: [],
      });
    } finally {
      // biome-ignore lint/performance/noDelete: assigning undefined would leave the string "undefined"
      delete process.env.DOCMIND_PROBE_SECRET;
    }
    released();
  });

  it("aborting a running parse kills the child and rejects ParseAbortedError", async () => {
    const r = gated(1);
    const started = spawns(1);
    const ac = new AbortController();
    const run = r.run("spin", bytes("x"), { signal: ac.signal });
    await started;
    ac.abort();
    await expect(run).rejects.toMatchObject({
      name: "ParseAbortedError",
      message: "parse aborted",
    });
    released();
    expect(spawned[0]?.signalCode).toBe("SIGKILL");
    expect([r.active(), r.queued()]).toEqual([0, 0]);
  });

  it("an already-aborted signal never spawns", async () => {
    const r = gated(1);
    const ac = new AbortController();
    ac.abort();
    await expect(r.run("echo", bytes("x"), { signal: ac.signal })).rejects.toBeInstanceOf(
      ParseAbortedError,
    );
    expect(spawned).toHaveLength(0);
    expect(r.active()).toBe(0);
  });

  it("runs at most maxConcurrent children and queues the rest in order", async () => {
    const r = gated(1);
    const started = spawns(1);
    const hold = new AbortController();
    const first = r.run("spin", bytes("x"), { signal: hold.signal });
    const second = r.run("echo", bytes("queued"));
    expect([r.active(), r.queued()]).toEqual([1, 1]);
    await started;
    expect(spawned).toHaveLength(1);
    hold.abort();
    await expect(first).rejects.toBeInstanceOf(ParseAbortedError);
    expect((await second).text).toBe("queued");
    expect(spawned).toHaveLength(2);
    expect(spawned.every(dead)).toBe(true);
    expect([r.active(), r.queued()]).toEqual([0, 0]);
  });

  it("with maxConcurrent 2 the third run waits", async () => {
    const r = gated(2);
    const a = new AbortController();
    const b = new AbortController();
    const one = r.run("spin", bytes("x"), { signal: a.signal });
    const two = r.run("spin", bytes("x"), { signal: b.signal });
    const three = r.run("echo", bytes("third"));
    expect([r.active(), r.queued()]).toEqual([2, 1]);
    await spawns(2);
    expect(spawned).toHaveLength(2);
    expect(r.active()).toBe(2);
    // Both rejections get a handler before either abort: `two` rejects as soon as `b` aborts, and
    // awaiting `one` first would leave it unhandled for a tick (an unhandled rejection).
    const aborted = [one, two].map((run) => expect(run).rejects.toBeInstanceOf(ParseAbortedError));
    a.abort();
    b.abort();
    await Promise.all(aborted);
    expect((await three).text).toBe("third");
    expect(spawned.every(dead)).toBe(true);
    expect([r.active(), r.queued()]).toEqual([0, 0]);
  });

  it("a crashed run frees its slot for the next one", async () => {
    const r = gated(1);
    const crashed = r.run("exit", bytes("x"));
    const next = r.run("echo", bytes("after"));
    await expect(crashed).rejects.toBeInstanceOf(ParseCrashedError);
    expect((await next).text).toBe("after");
    expect(spawned.every(dead)).toBe(true);
    expect([r.active(), r.queued()]).toEqual([0, 0]);
  });

  it("an aborted run still waiting for a slot never starts a child", async () => {
    const r = gated(1);
    const started = spawns(1);
    const hold = new AbortController();
    const first = r.run("spin", bytes("x"), { signal: hold.signal });
    const waiting = new AbortController();
    const second = r.run("echo", bytes("x"), { signal: waiting.signal });
    waiting.abort();
    await expect(second).rejects.toBeInstanceOf(ParseAbortedError);
    expect(r.queued()).toBe(0);
    await started;
    hold.abort();
    await expect(first).rejects.toBeInstanceOf(ParseAbortedError);
    expect(spawned).toHaveLength(1);
    expect([r.active(), r.queued()]).toEqual([0, 0]);
  });

  it("runs queued parses in submission order", async () => {
    const r = gated(1);
    const started = spawns(1);
    const hold = new AbortController();
    const first = r.run("spin", bytes("x"), { signal: hold.signal });
    const order: string[] = [];
    const a = r.run("echo", bytes("a")).then((d) => order.push(d.text));
    const b = r.run("echo", bytes("b")).then((d) => order.push(d.text));
    await started;
    hold.abort();
    await expect(first).rejects.toBeInstanceOf(ParseAbortedError);
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
    expect([r.active(), r.queued()]).toEqual([0, 0]);
  });

  it("a closed reply pipe on a live child is a crash, not a wall-clock timeout", async () => {
    const r = limited({ wallClockMs: 2_000_000_000 });
    await expect(r.run("close3spin", bytes("x"))).rejects.toBeInstanceOf(ParseCrashedError);
    released();
    expect(r.active()).toBe(0);
  });

  it("rejects an invalid maxConcurrent", () => {
    expect(() => gated(0)).toThrow(/maxConcurrent must be/);
  });

  it("close() aborts a running parse and a queued one, kills the child, and is idempotent", async () => {
    const r = gated(1);
    const started = spawns(1);
    const settled = Promise.allSettled([r.run("spin", bytes("x")), r.run("spin", bytes("x"))]);
    await started;
    const first = r.close();
    expect(r.close()).toBe(first);
    await first;
    expect(spawned[0]?.signalCode).toBe("SIGKILL"); // close() resolves only after the child is gone
    const results = await settled;
    for (const res of results) {
      expect(res).toMatchObject({ status: "rejected", reason: { name: "ParseAbortedError" } });
    }
    expect(spawned).toHaveLength(1);
    released();
    expect(spawned[0]?.signalCode).toBe("SIGKILL");
    expect([r.active(), r.queued()]).toEqual([0, 0]);
    await expect(r.close()).resolves.toBeUndefined();
  });

  it("a closed runner refuses new runs without spawning", async () => {
    const r = gated(1);
    await r.close();
    await expect(r.run("echo", bytes("x"))).rejects.toBeInstanceOf(ParseAbortedError);
    expect(spawned).toHaveLength(0);
  });

  it("a child killed by the kernel CPU limit (SIGXCPU) is a timeout, not a crash", async () => {
    await expect(runner().run("xcpu", bytes("x"))).rejects.toMatchObject({
      name: "ParseTimeoutError",
      message: "parse timed out",
    });
    released();
  });

  // Started by hand through the runner's own launcher, but nothing ever reads fd 3 or kills it:
  // the parent has stopped reading. The child must end itself (POSIX only).
  it.each([
    ["spin", "SIGXCPU"], // a synchronous loop: the kernel CPU limit, 3 s soft limit
    ["hang", "exit 124"], // idle but alive: the child's own timer
    ["patched-hang", "exit 124"], // the parser replaced process.exit and process.kill
    ["patched-kill-hang", "exit 124"], // ... and process._kill too
  ])(
    "an orphaned %s child ends itself (%s)",
    async (parserId, signal) => {
      const entry = join(__dirname, "../../dist/child/child.cjs");
      const { spawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const launch = limitedSpawn(1, process.execPath, [entry]);
      const child = spawn(launch.command, launch.args, {
        stdio: ["pipe", "ignore", "ignore", "pipe"],
        env: {},
        cwd: dirname(entry),
      });
      handSpawned.push(child);
      const exited = new Promise<string | null>((res) =>
        child.once("exit", (code, sig) => res(sig ?? `exit ${code}`)),
      );
      const request = { parserId, bytes: "", module: hostile, maxChars: 500, wallClockMs: 1 };
      child.stdin?.end(encodeFrame(request));
      expect(await exited).toBe(signal);
    },
    20_000,
  );
});
