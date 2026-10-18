import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OVERHEAD_BYTES, openBytes, sealStream } from "./envelope";
import { BlobCorruptError } from "./errors";

const DEK = randomBytes(32);
const SCOPE = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
};

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

async function seal(dek: Buffer, ...parts: string[]): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const piece of sealStream(dek, SCOPE, chunks(...parts))) out.push(piece);
  return Buffer.concat(out);
}

describe("blob envelope", () => {
  it("round-trips a multi-chunk stream and adds a fixed overhead", async () => {
    const sealed = await seal(DEK, "hello ", "wor", "ld");
    expect(sealed.length).toBe("hello world".length + OVERHEAD_BYTES);
    expect(openBytes(DEK, SCOPE, sealed).toString()).toBe("hello world");
  });

  it("round-trips an empty stream", async () => {
    expect(openBytes(DEK, SCOPE, await seal(DEK)).length).toBe(0);
  });

  it("does not contain the plaintext and differs on every seal", async () => {
    const a = await seal(DEK, "a recognisable sentence");
    const b = await seal(DEK, "a recognisable sentence");
    expect(a.includes("recognisable")).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it("fails to open after any single byte changes (header, body or tag)", async () => {
    const sealed = await seal(DEK, "tamper evident");
    for (const i of [0, 6, 20, 40, 70, 80, sealed.length - 1]) {
      const copy = Buffer.from(sealed);
      copy[i] = (copy[i] ?? 0) ^ 1;
      expect(() => openBytes(DEK, SCOPE, copy), `byte ${i}`).toThrow(BlobCorruptError);
    }
  });

  it("fails for another data key, another user, another tenant, and a truncated file", async () => {
    const sealed = await seal(DEK, "scoped");
    expect(() => openBytes(randomBytes(32), SCOPE, sealed)).toThrow(BlobCorruptError);
    expect(() =>
      openBytes(DEK, { ...SCOPE, userId: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1" }, sealed),
    ).toThrow(BlobCorruptError);
    expect(() =>
      openBytes(DEK, { ...SCOPE, tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, sealed),
    ).toThrow(BlobCorruptError);
    expect(() => openBytes(DEK, SCOPE, sealed.subarray(0, sealed.length - 1))).toThrow(
      BlobCorruptError,
    );
    expect(() => openBytes(DEK, SCOPE, Buffer.from("nope"))).toThrow(BlobCorruptError);
  });

  it("error messages carry no scope values", async () => {
    const sealed = await seal(DEK, "x");
    let caught: unknown;
    try {
      openBytes(randomBytes(32), SCOPE, sealed);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BlobCorruptError);
    expect(String(caught)).not.toContain(SCOPE.userId);
    expect(String(caught)).not.toContain(SCOPE.tenantId);
  });
});
