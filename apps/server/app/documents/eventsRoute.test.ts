import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../server";
import { shutdown } from "../shutdown";
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

  it("subscribes with the session's user only: a query parameter or header naming another user changes nothing", async () => {
    const s = await openSse(`${base}/api/documents/events?userId=${U1B}&user=${U2}`, {
      "x-test-user": "alice",
      "x-user-id": U1B,
    });
    await s.next();
    bus.publish({ userId: U1B }, ev());
    bus.publish({ userId: U2 }, ev());
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

  it("caps per user: another user is unaffected by a full one", async () => {
    const [a, b] = [await open("alice2"), await open("alice2")];
    const other = await open("alice");
    expect(other.res.status).toBe(200);
    for (const s of [a, b, other]) s.close();
  });

  it("two concurrent opens at cap-1 do not both succeed", async () => {
    const first = await open("bob");
    const racers = await Promise.all([open("bob"), open("bob")]);
    expect(racers.map((r) => r.res.status).sort()).toEqual([200, 429]);
    for (const s of [first, ...racers]) s.close();
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

// The same route set driven with a fake socket: the exit paths a real client cannot produce on demand.
describe("stream slots on every exit path", () => {
  const request = (user: string) =>
    ({ headers: { "x-test-user": user } }) as unknown as IncomingMessage;
  const fakeRes = (accepts = true) => {
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      write: vi.fn(() => accepts),
      end: vi.fn(() => {
        res.writableEnded = true;
        res.emit("close");
      }),
      destroy: vi.fn(() => {
        res.destroyed = true;
        res.emit("close");
      }),
    });
    return res;
  };
  const setup = () => {
    const ownBus = new InMemoryProgressBus();
    const subscribe = vi.spyOn(ownBus, "subscribe");
    const done = vi.fn();
    const route = documentEventRoutes({
      authenticator: testAuthenticator,
      bus: ownBus,
      maxStreamsPerUser: 1,
      onStreamEnd: done,
    }).routes["GET /api/documents/events"];
    const call = async (res: ReturnType<typeof fakeRes>) =>
      route?.(request("alice"), res as unknown as ServerResponse, { params: {} });
    return { ownBus, subscribe, done, call };
  };

  it("a backpressure destroy releases the slot", async () => {
    const { ownBus, done, call, subscribe } = setup();
    await call(fakeRes(false));
    ownBus.publish({ userId: U1 }, ev()); // the full buffer destroys the response
    expect(done).toHaveBeenCalledTimes(1);
    await call(fakeRes());
    expect(subscribe).toHaveBeenCalledTimes(2); // the cap of 1 admitted the next stream
  });

  it("a socket error releases the slot", async () => {
    const { done, call, subscribe } = setup();
    const res = fakeRes();
    await call(res);
    res.emit("error", new Error("boom"));
    expect(done).toHaveBeenCalledTimes(1);
    await call(fakeRes());
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("a response already destroyed when the route runs takes no slot and does not subscribe", async () => {
    const { done, call, subscribe } = setup();
    const gone = fakeRes();
    gone.destroyed = true;
    await call(gone);
    expect(subscribe).not.toHaveBeenCalled();
    expect(gone.writeHead).not.toHaveBeenCalled();
    await call(fakeRes());
    expect([subscribe.mock.calls.length, done.mock.calls.length]).toEqual([1, 0]);
  });
});

describe("shutdown with an open stream (F10)", () => {
  it("closeAll lets shutdown finish: the server drain no longer waits on the event stream", async () => {
    const own = documentEventRoutes({ authenticator: testAuthenticator, bus });
    const srv = createHttpServer(own.routes);
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/documents/events`;
    const s = await openSse(url, { "x-test-user": "alice" });
    expect(await s.next()).toBe("retry: 5000");
    const closed = vi.fn(async () => {});
    own.closeAll(); // main.ts: timers, then this, then the drain
    await shutdown(srv, { close: closed });
    expect(closed).toHaveBeenCalledTimes(1);
    await expect(s.next()).rejects.toThrow(/^stream ended$/);
  });
});
