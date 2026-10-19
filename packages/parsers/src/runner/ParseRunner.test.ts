import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawned: ChildProcess[] = [];
let stdiolessSpawn = false;
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (stdiolessSpawn) {
        child.kill("SIGKILL");
        return { pid: undefined, once: () => {}, on: () => {} } as unknown as ChildProcess;
      }
      spawned.push(child);
      return child;
    }) as typeof actual.spawn,
  };
});

import { ParseCrashedError, ParseLimitError, ParseRunner, ParseTimeoutError } from "./ParseRunner";

const LIMITS = { wallClockMs: 10_000, memoryMb: 256, maxInputBytes: 1024, maxChars: 500 };
const hostile = resolve(__dirname, "../../test-fixtures/hostile.cjs");
const runner = (parserModule: string | null = hostile, limits = LIMITS) =>
  new ParseRunner({ limits, ...(parserModule ? { parserModule } : {}) });
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

  it("refuses a bare import the parent did not map (no node_modules resolution)", async () => {
    await expect(runner().run("bare", bytes("x"))).rejects.toBeInstanceOf(ParseCrashedError);
    released();
  });

  it("kills a parser that never returns at the wall clock", async () => {
    const r = runner(hostile, { ...LIMITS, wallClockMs: 200 });
    await expect(r.run("spin", bytes("x"))).rejects.toBeInstanceOf(ParseTimeoutError);
    released();
    expect(spawned[0]?.signalCode).toBe("SIGKILL");
  });

  it.each(["exit", "signal", "oom"])(
    "a child that dies without a reply (%s) is a prompt crash",
    async (id) => {
      await expect(runner().run(id, bytes("x"))).rejects.toMatchObject({
        name: "ParseCrashedError",
        message: "parse crashed",
      });
      released();
    },
  );

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
    const r = new ParseRunner({ limits: LIMITS, executable: "/nonexistent/node-binary" });
    await expect(r.run("txt", bytes("x"))).rejects.toBeInstanceOf(ParseCrashedError);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.pid).toBeUndefined();
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
    [{ maxChars: 700_000_001 }, /limits\.maxChars must be/],
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
  });

  it("rejects text over maxChars as too_large, from the child", async () => {
    await expect(limited({ maxChars: 100 }).run("big", bytes("x"))).rejects.toMatchObject({
      name: "ParseRejectedError",
      code: "too_large",
    });
    released();
  });

  it("accepts text exactly at maxChars", async () => {
    expect((await limited({ maxChars: 1000 }).run("big", bytes("x"))).text).toHaveLength(1000);
    released();
  });

  it("the parent re-checks maxChars on the reply, whatever the child says", async () => {
    // Tell the child a larger cap than the parent's, so only the parent's check can refuse.
    const mod = resolve(__dirname, "../../test-fixtures/hostile.cjs");
    const r = new ParseRunner({ limits: { ...LIMITS, maxChars: 100 }, parserModule: mod });
    const bigFrame = r as unknown as {
      exchange: (c: unknown, q: { maxChars: number }) => Promise<unknown>;
    };
    const orig = bigFrame.exchange.bind(r);
    bigFrame.exchange = (c, q) => orig(c, { ...q, maxChars: 10_000 }); // child no longer enforces
    await expect(r.run("big", bytes("x"))).rejects.toMatchObject({
      name: "ParseRejectedError",
      code: "too_large",
    });
    released();
  });

  it("a reply over the derived byte cap is a crash, not a document", async () => {
    // "garbage" declares an 8-byte body of invalid UTF-8; "oversized" is covered above. With a
    // tiny cap the frame limit is 1 MiB + 6, still far under what a real reply needs here.
    await expect(limited({ maxChars: 1 }).run("garbage", bytes("x"))).rejects.toBeInstanceOf(
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

  it("a parser writing megabytes to stdout and stderr cannot block the run or reach the parent", async () => {
    const writes: string[] = [];
    const spies = [process.stdout, process.stderr].map((s) =>
      vi.spyOn(s, "write").mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write),
    );
    try {
      const r = runner();
      expect((await r.run("noisy", bytes("x"))).text).toBe("done");
      expect(r.active()).toBe(0);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(writes.filter((w) => /xxxxxxxx|yyyyyyyy|zzzzzzzz/.test(w))).toEqual([]);
    released();
  });
});
