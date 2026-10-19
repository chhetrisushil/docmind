import { randomUUID } from "node:crypto";
import { BlobKeyUnavailableError } from "@docmind/blob-store";
import {
  ParseAbortedError,
  ParseCrashedError,
  ParseLimitError,
  ParseMemoryError,
  ParseRejectedError,
  ParseTimeoutError,
} from "@docmind/parsers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldKeyStoreError, FieldKeyUnavailableError } from "../../crypto/fields";
import {
  DOCUMENT_FKEY_CONSTRAINTS,
  DocumentGoneError,
  FAILURE_CODES,
  PermanentIngestError,
} from "./errors";
import type { IngestStartInput } from "./flow";
import { type StepGuard, StepResult, stepEffect } from "./stepEffect";

const ref = (): IngestStartInput => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  documentId: randomUUID(),
});
const guard = () => {
  const calls: string[] = [];
  const port: StepGuard = { begin: async (_r, step) => void calls.push(`begin:${step}`) };
  return { port, calls };
};
const run = (work: Parameters<typeof stepEffect>[2], port: StepGuard) =>
  stepEffect("chunk", port, work).execute(ref(), {} as never);
const throwing = (make: () => unknown) => async () => {
  throw make();
};

afterEach(() => vi.restoreAllMocks());

describe("stepEffect", () => {
  it("checks the document first, runs the work, and reports done with its count", async () => {
    const { port, calls } = guard();
    expect(await run(async () => ({ count: 3 }), port)).toEqual({ outcome: "done", count: 3 });
    expect(calls).toEqual(["begin:chunk"]);
  });

  it.each([
    ["DocumentGoneError", () => new DocumentGoneError()],
    ["a destroyed user key", () => new FieldKeyUnavailableError()],
    ["a destroyed blob key", () => new BlobKeyUnavailableError()],
    [
      "a documents foreign-key violation",
      () =>
        Object.assign(new Error("fk"), { code: "23503", constraint: DOCUMENT_FKEY_CONSTRAINTS[0] }),
    ],
  ])("treats %s as document_gone, not a failure", async (_n, make) => {
    const { port } = guard();
    expect(await run(throwing(make), port)).toEqual({ outcome: "document_gone" });
  });

  it("treats a document that is gone at the check as document_gone and runs no work", async () => {
    const work = vi.fn();
    const port: StepGuard = { begin: throwing(() => new DocumentGoneError()) };
    expect(await run(work, port)).toEqual({ outcome: "document_gone" });
    expect(work).not.toHaveBeenCalled();
  });

  it("returns a permanent failure as the step's result with its code", async () => {
    const { port, calls } = guard();
    const out = await run(
      throwing(() => new PermanentIngestError("corrupt_content")),
      port,
    );
    expect(out).toEqual({ outcome: "failed", code: "corrupt_content" });
    expect(calls).toEqual(["begin:chunk"]);
  });

  it.each(FAILURE_CODES)("maps a parser rejection %s to its code", async (code) => {
    const { port } = guard();
    expect(
      await run(
        throwing(() => new ParseRejectedError(code)),
        port,
      ),
    ).toEqual({ outcome: "failed", code });
  });

  it.each([
    ["an input limit", () => new ParseLimitError("input")],
    ["the memory limit", () => new ParseMemoryError()],
  ])("maps %s to too_large", async (_n, make) => {
    const { port } = guard();
    expect(await run(throwing(make), port)).toEqual({ outcome: "failed", code: "too_large" });
  });

  it.each([
    ["a timeout", () => new ParseTimeoutError()],
    ["a crash", () => new ParseCrashedError()],
    ["a cancellation", () => new ParseAbortedError()],
    ["a key store outage", () => new FieldKeyStoreError()],
    [
      "a foreign-key violation on another constraint",
      () => Object.assign(new Error("fk"), { code: "23503", constraint: "other_fkey" }),
    ],
    [
      "a foreign-key violation without a constraint",
      () => Object.assign(new Error("fk"), { code: "23503" }),
    ],
    [
      "a unique violation",
      () =>
        Object.assign(new Error("dup"), {
          code: "23505",
          constraint: DOCUMENT_FKEY_CONSTRAINTS[0],
        }),
    ],
    ["a rejection with an unknown code", () => new ParseRejectedError("bogus" as never)],
    ["a permanent error with an unknown code", () => new PermanentIngestError("bogus" as never)],
  ])("rethrows %s with the fixed message and records no code", async (_n, make) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { port } = guard();
    const err = await run(throwing(make), port).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("ingest step failed: chunk");
    expect((err as Error).cause).toBeUndefined();
  });

  it("rethrows anything else with a fixed message that names the step only, and logs the class", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { port } = guard();
    await expect(
      run(
        throwing(() => new TypeError("Quarterly report.txt: secret sentence")),
        port,
      ),
    ).rejects.toThrow(/^ingest step failed: chunk$/);
    expect(spy).toHaveBeenCalledWith("ingest step failed", "chunk", "TypeError");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
  });

  it("keeps StepResult strict", () => {
    expect(StepResult.safeParse({ outcome: "done", text: "x" }).success).toBe(false);
  });
});
