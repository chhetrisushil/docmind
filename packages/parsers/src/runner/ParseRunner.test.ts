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

import { ParseCrashedError, ParseRunner, ParseTimeoutError } from "./ParseRunner";

const LIMITS = { wallClockMs: 10_000, memoryMb: 256 };
const hostile = resolve(__dirname, "../../test-fixtures/hostile.cjs");
const runner = (parserModule: string | null = hostile, limits = LIMITS) =>
  new ParseRunner({ limits, ...(parserModule ? { parserModule } : {}) });
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
    [{ wallClockMs: 0, memoryMb: 256 }, /limits\.wallClockMs must be/],
    [{ wallClockMs: 1.5, memoryMb: 256 }, /limits\.wallClockMs must be/],
    [{ wallClockMs: 2147483648, memoryMb: 256 }, /limits\.wallClockMs must be/],
    [{ wallClockMs: 1000, memoryMb: 0 }, /limits\.memoryMb must be/],
    [{ wallClockMs: 1000, memoryMb: Number.NaN }, /limits\.memoryMb must be/],
  ])("rejects invalid limits %#", (limits, text) => {
    expect(() => new ParseRunner({ limits })).toThrow(text);
  });
});
