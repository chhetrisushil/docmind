import { describe, expect, it } from "vitest";
import { InFlight } from "./inFlight";

describe("InFlight", () => {
  it("allows up to max per key and frees a slot on release", () => {
    const f = new InFlight();
    const a = f.tryAcquire("u1", 2);
    const b = f.tryAcquire("u1", 2);
    expect(a && b).toBeTruthy();
    expect(f.tryAcquire("u1", 2)).toBeNull();
    a?.();
    expect(f.tryAcquire("u1", 2)).not.toBeNull();
  });

  it("counts keys separately and ignores a second release of the same slot", () => {
    const f = new InFlight();
    const a = f.tryAcquire("u1", 1);
    expect(f.tryAcquire("u2", 1)).not.toBeNull();
    a?.();
    a?.();
    expect(f.tryAcquire("u1", 1)).not.toBeNull();
    expect(f.tryAcquire("u1", 1)).toBeNull(); // the double release did not free two slots
  });
});
