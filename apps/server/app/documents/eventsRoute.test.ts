import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../server";
import { documentEventRoutes } from "./events";
import { InMemoryProgressBus } from "./progress";
import { U1, U1B, U2, openSse, testAuthenticator } from "./testHarness";

const bus = new InMemoryProgressBus();
let onStreamEnd: () => void = () => {};
const events = documentEventRoutes({
  authenticator: testAuthenticator,
  bus,
  maxStreamsPerUser: 2,
  onStreamEnd: () => onStreamEnd(),
});
const server = createHttpServer(events.routes);
let base = "";
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ev = (documentId = randomUUID()) =>
  ({ documentId, step: "chunk", status: "parsing" }) as const;
const open = (user: string) => openSse(`${base}/api/documents/events`, { "x-test-user": user });
const ended = () =>
  new Promise<void>((resolve) => {
    onStreamEnd = resolve;
  });

describe("GET /api/documents/events", () => {
  it("sends the retry hint, then each progress event of the caller's own documents as JSON", async () => {
    const s = await open("alice");
    expect(s.res.headers.get("content-type")).toBe("text/event-stream");
    expect(s.res.headers.get("cache-control")).toBe("no-store");
    expect(s.res.headers.get("x-accel-buffering")).toBe("no");
    expect(await s.next()).toBe("retry: 5000");
    const e = ev();
    bus.publish({ userId: U1 }, e);
    expect(await s.next()).toBe(`id: 1\nevent: progress\ndata: ${JSON.stringify(e)}`);
    s.close();
  });

  it("does not deliver another user's or another tenant's events: the first thing alice sees is her own", async () => {
    const s = await open("alice");
    await s.next();
    bus.publish({ userId: U1B }, ev()); // same tenant, other user
    bus.publish({ userId: U2 }, ev()); // other tenant
    const mine = ev();
    bus.publish({ userId: U1 }, mine);
    expect(await s.next()).toContain(mine.documentId);
    s.close();
  });

  it("answers 401 without a session", async () => {
    expect((await fetch(`${base}/api/documents/events`)).status).toBe(401);
  });

  it("allows maxStreamsPerUser streams, refuses the next with a fixed 429, and frees a slot when one closes", async () => {
    const [a, b] = [await open("alice2"), await open("alice2")];
    const refused = await fetch(`${base}/api/documents/events`, {
      headers: { "x-test-user": "alice2" },
    });
    expect([refused.status, await refused.json()]).toEqual([
      429,
      { error: { code: "too_many_streams", message: "too many open event streams" } },
    ]);
    const freed = ended(); // the server-side end of the first stream
    a.close();
    await freed;
    const again = await open("alice2");
    expect(again.res.status).toBe(200);
    again.close();
    b.close();
  });

  it("closeAll ends every open stream, frees their slots, and leaves later streams possible", async () => {
    const s = await open("alice");
    expect(await s.next()).toBe("retry: 5000");
    const freed = ended();
    events.closeAll();
    await freed;
    await expect(s.next()).rejects.toThrow(/^stream ended$/);
    const again = await open("alice");
    expect(again.res.status).toBe(200);
    again.close();
  });
});
