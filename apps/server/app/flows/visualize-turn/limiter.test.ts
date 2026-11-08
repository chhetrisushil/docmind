import { describe, expect, it } from "vitest";
import { UserRateLimit } from "./limiter";

describe("UserRateLimit", () => {
  it("allows 10 per user per minute and refuses the 11th, per user", () => {
    const t = 0;
    const l = new UserRateLimit(10, 60_000, () => t);
    for (let i = 0; i < 10; i++) expect(l.tryAcquire("a")).toBe(true);
    expect(l.tryAcquire("a")).toBe(false);
    expect(l.tryAcquire("b")).toBe(true);
  });
  it("lets a request through again once the oldest has left the window", () => {
    let t = 0;
    const l = new UserRateLimit(2, 60_000, () => t);
    expect(l.tryAcquire("a")).toBe(true);
    t = 30_000;
    expect(l.tryAcquire("a")).toBe(true);
    expect(l.tryAcquire("a")).toBe(false);
    t = 60_000; // the first is exactly one window old: gone
    expect(l.tryAcquire("a")).toBe(true);
    expect(l.tryAcquire("a")).toBe(false);
  });
  it("forgets idle users, so the map does not grow without bound", () => {
    let t = 0;
    const l = new UserRateLimit(1, 1_000, () => t);
    for (let i = 0; i < 1_000; i++) l.tryAcquire(`u${i}`);
    t = 10_000;
    l.tryAcquire("fresh");
    expect(l.size()).toBeLessThanOrEqual(2);
  });
});
