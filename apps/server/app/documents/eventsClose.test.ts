import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Authenticator } from "@docmind/auth";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../server";
import { documentEventRoutes } from "./events";
import { InMemoryProgressBus } from "./progress";
import { U1, U1B, openSse, testAuthenticator } from "./testHarness";

const ev = () => ({ documentId: randomUUID(), step: "chunk", status: "parsing" }) as const;

async function start(over: { authenticator?: Authenticator } = {}) {
  const bus = new InMemoryProgressBus();
  let beat: () => void = () => {};
  let ended: () => void = () => {};
  const events = documentEventRoutes({
    authenticator: over.authenticator ?? testAuthenticator,
    bus,
    maxStreamsPerUser: 2,
    schedule: (fn) => {
      beat = fn;
      return () => {};
    },
    onStreamEnd: () => ended(),
  });
  const server = createHttpServer(events.routes);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    bus,
    events,
    beat: () => beat(),
    nextEnd: () =>
      new Promise<void>((resolve) => {
        ended = resolve;
      }),
    open: (user: string) => openSse(`${base}/api/documents/events`, { "x-test-user": user }),
    async stop() {
      events.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let current: Awaited<ReturnType<typeof start>> | undefined;
afterEach(async () => {
  await current?.stop();
  current = undefined;
});

describe("closeUser", () => {
  it("ends every stream of that user at once and frees their slots, and no other user's", async () => {
    const t = await start();
    current = t;
    const [a1, a2] = [await t.open("alice"), await t.open("alice")];
    const other = await t.open("alice2");
    for (const s of [a1, a2, other]) expect(await s.next()).toBe("retry: 5000");

    const gone = t.nextEnd();
    t.events.closeUser(U1);
    await gone;
    for (const s of [a1, a2]) await expect(s.next()).rejects.toThrow(/^stream ended$/);

    const mine = ev();
    t.bus.publish({ userId: U1B }, mine);
    expect(await other.next()).toContain(mine.documentId); // the other user's stream is still attached
    other.close();
  });

  it("is not a shutdown: the group still accepts the user's next stream, and the cap is free again", async () => {
    const t = await start();
    current = t;
    const [a1, a2] = [await t.open("alice"), await t.open("alice")];
    await a1.next();
    await a2.next();
    t.events.closeUser(U1);
    const again = await t.open("alice");
    expect(again.res.status).toBe(200);
    expect(await again.next()).toBe("retry: 5000");
    again.close();
  });

  it("does nothing for a user with no stream", async () => {
    const t = await start();
    current = t;
    expect(() => t.events.closeUser(randomUUID())).not.toThrow();
  });
});

describe("heartbeat re-authentication", () => {
  const revocable = () => {
    const state = { revoked: false, fails: false };
    const authenticator: Authenticator = {
      async authenticate(req) {
        if (state.fails && state.revoked) throw new Error("db down");
        return state.revoked ? null : testAuthenticator.authenticate(req);
      },
    };
    return { state, authenticator };
  };

  it("keeps a stream whose session is still valid", async () => {
    const { authenticator } = revocable();
    const t = await start({ authenticator });
    current = t;
    const s = await t.open("alice");
    await s.next();
    t.beat();
    expect(await s.next()).toBe(": ping");
    const e = ev();
    await new Promise((r) => setTimeout(r, 20));
    t.bus.publish({ userId: U1 }, e);
    expect(await s.next()).toContain(e.documentId);
    s.close();
  });

  it("ends the stream at the next heartbeat once the session is gone", async () => {
    const { state, authenticator } = revocable();
    const t = await start({ authenticator });
    current = t;
    const s = await t.open("alice");
    await s.next();
    state.revoked = true;
    const gone = t.nextEnd();
    t.beat();
    await gone;
    expect(await s.next()).toBe(": ping");
    await expect(s.next()).rejects.toThrow(/^stream ended$/);
  });

  it("fails closed: a re-check that throws ends the stream", async () => {
    const { state, authenticator } = revocable();
    state.fails = true;
    const t = await start({ authenticator });
    current = t;
    const s = await t.open("alice");
    await s.next();
    state.revoked = true;
    const gone = t.nextEnd();
    t.beat();
    await gone;
    await expect(s.next().then(() => s.next())).rejects.toThrow(/^stream ended$/);
  });
});
