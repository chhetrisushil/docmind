import { describe, expect, it, vi } from "vitest";
import { STATUS_MESSAGES } from "../status/model";
import { FIXED_ERROR, fixedError } from "./readers";

describe("the error a document shows to the UI", () => {
  it("is null, or one of the status model's fixed sentences, or a fixed fallback: never other text", () => {
    expect(fixedError(null)).toBeNull();
    for (const message of Object.values(STATUS_MESSAGES)) expect(fixedError(message)).toBe(message);
    expect(fixedError("ENOENT /var/blobs/quarterly-report.pdf for alice@example.com")).toBe(
      FIXED_ERROR,
    );
    expect(fixedError("")).toBe(FIXED_ERROR);
  });
});

describe("the source reader", () => {
  it("delegates to readSource, turning an empty passage into undefined", async () => {
    vi.resetModules();
    const readSource = vi.fn(async () => ({ applicable: false as const }));
    vi.doMock("../documents/source", () => ({ readSource }));
    const { readersFor } = await import("./readers");
    const deps = { pool: {}, blobs: {}, registry: {} } as never;
    const identity = { userId: "u", tenantId: "t" } as never;
    const r = readersFor(deps, identity);
    await expect(r.source({ id: "d", passage: "" })).resolves.toEqual({ applicable: false });
    expect(readSource).toHaveBeenLastCalledWith(deps, identity, "d", undefined);
    await r.source({ id: "d", passage: "p" });
    expect(readSource).toHaveBeenLastCalledWith(deps, identity, "d", "p");
    vi.doUnmock("../documents/source");
  });
});
