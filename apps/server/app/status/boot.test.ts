import { afterEach, describe, expect, it, vi } from "vitest";
import { STATUS_BOOT_FAILED, bootStatus } from "./boot";

const ID = "u_6a1f0c52-1111-4222-8333-444455556666:ingest-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

afterEach(() => vi.restoreAllMocks());

describe("bootStatus", () => {
  it("resolves and touches nothing when the model boots", async () => {
    const cleanup = vi.fn(async () => {});
    await bootStatus({ boot: async () => ({}) }, [cleanup]);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("throws a fixed message and logs the class only, even when the boot error carries an id", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new RangeError(`execution "${ID}" holds a sensitive state`);
    const result = await bootStatus({ boot: () => Promise.reject(failure) }, []).catch(
      (e: unknown) => e,
    );
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe(STATUS_BOOT_FAILED);
    expect(result).not.toBe(failure);
    expect(logged).toHaveBeenCalledWith("ingest status failed", "RangeError");
    expect(JSON.stringify(logged.mock.calls)).not.toContain(ID);
  });

  it("runs every cleanup step in order even when one rejects, and still throws the boot error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    const step =
      (name: string, fails = false) =>
      async () => {
        order.push(name);
        if (fails) throw new Error(`close failed for ${ID}`);
      };
    await expect(
      bootStatus({ boot: () => Promise.reject(new Error("boom")) }, [
        step("app", true),
        step("durable"),
        step("pool"),
      ]),
    ).rejects.toThrow(STATUS_BOOT_FAILED);
    expect(order).toEqual(["app", "durable", "pool"]);
  });
});
