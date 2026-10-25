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
    expect(clientIp(req("::ffff:1234"), false)).toBe("::ffff:1234");
  });

  it("uses a trusted forwarded entry only if it is a bare IP, else the socket", () => {
    expect(clientIp(req("10.0.0.2", "1.2.3.4,"), true)).toBe("10.0.0.2");
    expect(clientIp(req("10.0.0.2", "  198.51.100.7  "), true)).toBe("198.51.100.7");
    expect(clientIp(req("10.0.0.2", "not-an-ip"), true)).toBe("10.0.0.2");
    expect(clientIp(req("10.0.0.2", "1.2.3.4:5678"), true)).toBe("1.2.3.4");
  });
});

// Several requests-per-header cases: `forwarded` may be one header string or the repeated header's values.
const reqMulti = (remoteAddress: string, forwarded: string[]) =>
  ({
    headers: { "x-forwarded-for": forwarded },
    socket: { remoteAddress },
  }) as unknown as Parameters<typeof clientIp>[0];

describe("clientIp with a hop count", () => {
  it("defaults to one hop, exactly as before", () => {
    expect(clientIp(req("10.0.0.2", "6.6.6.6, 198.51.100.7"), true)).toBe("198.51.100.7");
    expect(clientIp(req("10.0.0.2", "6.6.6.6, 198.51.100.7"), true, 1)).toBe("198.51.100.7");
  });

  it("takes the entry `hops` from the right: the address the outermost trusted proxy saw", () => {
    // client -> CDN -> LB -> app: the LB appends the CDN's address, the CDN appends the client's.
    const xff = "203.0.113.50, 198.51.100.7, 10.1.1.1";
    expect(clientIp(req("10.0.0.2", xff), true, 1)).toBe("10.1.1.1");
    expect(clientIp(req("10.0.0.2", xff), true, 2)).toBe("198.51.100.7");
    expect(clientIp(req("10.0.0.2", xff), true, 3)).toBe("203.0.113.50");
  });

  it("ignores entries a client prepended, however many", () => {
    // The client sent "9.9.9.9, 8.8.8.8"; two trusted proxies then appended the real chain.
    const xff = "9.9.9.9, 8.8.8.8, 198.51.100.7, 10.1.1.1";
    expect(clientIp(req("10.0.0.2", xff), true, 2)).toBe("198.51.100.7");
    expect(clientIp(req("10.0.0.2", `${"7.7.7.7, ".repeat(50)}${xff}`), true, 2)).toBe(
      "198.51.100.7",
    );
  });

  it("falls back to the socket when the header has fewer entries than hops, never the leftmost", () => {
    expect(clientIp(req("10.0.0.2", "6.6.6.6"), true, 2)).toBe("10.0.0.2");
    expect(clientIp(req("10.0.0.2", "6.6.6.6, 5.5.5.5"), true, 3)).toBe("10.0.0.2");
    expect(clientIp(req("10.0.0.2"), true, 2)).toBe("10.0.0.2");
    expect(clientIp(req("10.0.0.2", ""), true, 2)).toBe("10.0.0.2");
  });

  it("counts an empty entry as an entry, so it cannot shift the position", () => {
    expect(clientIp(req("10.0.0.2", "6.6.6.6, , 198.51.100.7"), true, 2)).toBe("10.0.0.2");
    expect(clientIp(req("10.0.0.2", "198.51.100.7, 10.1.1.1,"), true, 2)).toBe("10.1.1.1");
    expect(clientIp(req("10.0.0.2", ",,,"), true, 2)).toBe("10.0.0.2");
  });

  it("trims whitespace around the chosen entry", () => {
    expect(clientIp(req("10.0.0.2", "6.6.6.6 ,\t198.51.100.7\t , 10.1.1.1  "), true, 2)).toBe(
      "198.51.100.7",
    );
  });

  it("uses the socket when the chosen entry is not an IP, whatever its neighbours say", () => {
    expect(clientIp(req("10.0.0.2", "6.6.6.6, unknown, 10.1.1.1"), true, 2)).toBe("10.0.0.2");
    expect(clientIp(req("10.0.0.2", "6.6.6.6, 1.2.3.4.5, 10.1.1.1"), true, 2)).toBe("10.0.0.2");
  });

  it("reads IPv6 entries, bracketed or with a port, and lowercases them", () => {
    expect(clientIp(req("10.0.0.2", "6.6.6.6, 2001:DB8::1, 10.1.1.1"), true, 2)).toBe(
      "2001:db8::1",
    );
    expect(clientIp(req("10.0.0.2", "6.6.6.6, [2001:db8::2]:443, 10.1.1.1"), true, 2)).toBe(
      "2001:db8::2",
    );
    expect(clientIp(req("10.0.0.2", "6.6.6.6, ::ffff:198.51.100.7, 10.1.1.1"), true, 2)).toBe(
      "198.51.100.7",
    );
  });

  it("treats repeated X-Forwarded-For headers as one list, in order", () => {
    // The first header is the client's; each proxy appends to the last one (or adds its own header).
    expect(clientIp(reqMulti("10.0.0.2", ["6.6.6.6", "198.51.100.7", "10.1.1.1"]), true, 2)).toBe(
      "198.51.100.7",
    );
    expect(clientIp(reqMulti("10.0.0.2", ["6.6.6.6, 5.5.5.5", "10.1.1.1"]), true, 2)).toBe(
      "5.5.5.5",
    );
    expect(clientIp(reqMulti("10.0.0.2", ["6.6.6.6", "10.1.1.1"]), true, 3)).toBe("10.0.0.2");
  });

  it("ignores the header and the hop count when not trusting the proxy", () => {
    expect(clientIp(req("203.0.113.9", "1.2.3.4, 5.6.7.8"), false, 2)).toBe("203.0.113.9");
  });
});
