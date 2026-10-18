import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/**
 * The address a request came from, for throttling. By default only the socket's peer address is
 * believed: any client can send an X-Forwarded-For header, and trusting it would let an attacker
 * pick a fresh "address" for every guess. Set `trustProxy` only when the server is reachable
 * through exactly one reverse proxy of yours, which appends the address it saw; the last entry is
 * then that address, once trimmed of any port and checked to be an IP. Anything else falls back to
 * the socket. IPv4-mapped IPv6 addresses are written as plain IPv4.
 */
export function clientIp(
  req: Pick<IncomingMessage, "headers" | "socket">,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const last =
      (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
        .split(",")
        .pop()
        ?.trim() ?? "";
    const ip = last
      .replace(/^\[([^\]]+)\](?::\d+)?$/, "$1")
      .replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1");
    if (isIP(ip) !== 0) return normalise(ip);
  }
  return normalise(req.socket.remoteAddress ?? "unknown");
}

const normalise = (ip: string): string =>
  ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1").toLowerCase();
