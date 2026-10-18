import { describe, expect, it } from "vitest";
import { clientIp } from "./clientIp";

const req = (remoteAddress: string | undefined, forwarded?: string) =>
  ({
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
    socket: { remoteAddress },
  }) as Parameters<typeof clientIp>[0];

describe("clientIp", () => {
  it("believes only the socket by default, whatever the headers say", () => {
    expect(clientIp(req("203.0.113.9", "1.2.3.4"), false)).toBe("203.0.113.9");
  });

  it("takes the last forwarded entry (the one our proxy added) when told to trust it", () => {
    expect(clientIp(req("10.0.0.2", "6.6.6.6, 198.51.100.7"), true)).toBe("198.51.100.7");
  });

  it("falls back to the socket when trusting but there is no header", () => {
    expect(clientIp(req("10.0.0.2"), true)).toBe("10.0.0.2");
  });

  it("writes an IPv4-mapped address as IPv4, and survives a missing address", () => {
    expect(clientIp(req("::ffff:203.0.113.9"), false)).toBe("203.0.113.9");
    expect(clientIp(req(undefined), false)).toBe("unknown");
  });
});
