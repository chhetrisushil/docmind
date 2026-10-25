import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/**
 * The address a request came from, for throttling. By default only the socket's peer address is
 * believed: any client can send an X-Forwarded-For header, and trusting it would let an attacker
 * pick a fresh "address" for every guess. Set `trustProxy` only when the server is reachable
 * only through `hops` reverse proxies of yours (default 1), each of which appends the address it
 * saw. The header is then read as one list (repeated headers joined in order) and the entry `hops`
 * from the right is the client: everything to its left is client-controlled and never believed.
 * That entry is used once trimmed of any port and checked to be an IP. If the list is shorter than
 * `hops`, or the entry is not an IP, the socket is used (never the leftmost entry). Empty entries
 * count as entries, so they cannot shift the position. IPv4-mapped IPv6 addresses are written as
 * plain IPv4.
 */
export function clientIp(
  req: Pick<IncomingMessage, "headers" | "socket">,
  trustProxy: boolean,
  hops = 1,
): string {
  if (trustProxy && Number.isInteger(hops) && hops >= 1) {
    const forwarded = req.headers["x-forwarded-for"];
    const entries = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")).split(",");
    const chosen = entries.length >= hops ? (entries[entries.length - hops] ?? "").trim() : "";
    const ip = chosen
      .replace(/^\[([^\]]+)\](?::\d+)?$/, "$1")
      .replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1");
    if (isIP(ip) !== 0) return normalise(ip);
  }
  return normalise(req.socket.remoteAddress ?? "unknown");
}

const normalise = (ip: string): string =>
  ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1").toLowerCase();
