import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../server";
import { createReadiness } from "./readiness";

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

let server: ReturnType<typeof createHttpServer> | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function serve(readiness: ReturnType<typeof createReadiness>, secure = false) {
  server = createHttpServer({ "GET /readyz": readiness.handler }, { secure });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("readiness", () => {
  it("answers 200 when the ping succeeds", async () => {
    const base = await serve(createReadiness({ ping: async () => {} }));
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
  });

  it("answers 503 db_unavailable when the ping fails, and never shows the error", async () => {
    const base = await serve(
      createReadiness({
        ping: async () => {
          throw new Error("password authentication failed for user secret at 10.1.2.3");
        },
      }),
    );
    const res = await fetch(`${base}/readyz`);
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ status: "unavailable", reason: "db_unavailable" });
    expect(text).not.toContain("secret");
  });

  it("answers 503 db_unavailable when the ping outlasts the timeout", async () => {
    const hang = deferred();
    const base = await serve(createReadiness({ ping: () => hang.promise, timeoutMs: 30 }));
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable", reason: "db_unavailable" });
    hang.resolve();
  });

  it("answers 503 shutting_down once shutdown begins, without pinging", async () => {
    let pings = 0;
    const readiness = createReadiness({
      ping: async () => {
        pings += 1;
      },
    });
    const base = await serve(readiness);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    readiness.beginShutdown();
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable", reason: "shutting_down" });
    expect(pings).toBe(1);
  });

  it("shares one ping among concurrent probes, then pings again once it settles", async () => {
    const gate = deferred();
    let pings = 0;
    const readiness = createReadiness({
      ping: async () => {
        pings += 1;
        await gate.promise;
      },
    });
    const base = await serve(readiness);
    const probes = Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/readyz`)));
    await new Promise((r) => setTimeout(r, 50));
    gate.resolve();
    const responses = await probes;
    expect(responses.map((r) => r.status)).toEqual(Array(20).fill(200));
    expect(pings).toBe(1);
    await fetch(`${base}/readyz`);
    expect(pings).toBe(2);
  });

  it("treats a synchronous throw from the ping as a 503", async () => {
    const base = await serve(
      createReadiness({
        ping: () => {
          throw new Error("boom");
        },
      }),
    );
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable", reason: "db_unavailable" });
  });

  it("does not cache a rejected ping: the next probe pings again and can succeed", async () => {
    let pings = 0;
    const base = await serve(
      createReadiness({
        ping: async () => {
          pings += 1;
          if (pings === 1) throw new Error("down");
        },
      }),
    );
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect(pings).toBe(2);
  });

  it("does not reuse a ping that has outlived a few timeouts", async () => {
    let t = 0;
    let pings = 0;
    const hang = deferred();
    const base = await serve(
      createReadiness({
        ping: () => {
          pings += 1;
          return pings === 1 ? hang.promise : Promise.resolve();
        },
        timeoutMs: 20,
        now: () => t,
      }),
    );
    expect((await fetch(`${base}/readyz`)).status).toBe(503); // the first ping hangs
    t = 40; // within three timeouts: the hung ping is shared, not repeated
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    expect(pings).toBe(1);
    t = 61; // past three timeouts: a fresh ping
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect(pings).toBe(2);
    hang.resolve();
  });

  it("answers HEAD like GET, with no body", async () => {
    const readiness = createReadiness({ ping: async () => {} });
    server = createHttpServer({
      "GET /readyz": readiness.handler,
      "HEAD /readyz": readiness.handler,
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ok = await fetch(`${base}/readyz`, { method: "HEAD" });
    expect([ok.status, await ok.text()]).toEqual([200, ""]);
    readiness.beginShutdown();
    const down = await fetch(`${base}/readyz`, { method: "HEAD" });
    expect([down.status, await down.text()]).toEqual([503, ""]);
  });

  it("close() ends the ping's own resource and turns the probe off", async () => {
    let closed = 0;
    const readiness = createReadiness({
      ping: async () => {},
      closePing: async () => {
        closed += 1;
      },
    });
    await readiness.close();
    expect(closed).toBe(1);
  });

  it("needs no session and no Origin or Fetch Metadata, like /healthz", async () => {
    const base = await serve(createReadiness({ ping: async () => {} }), true);
    const res = await fetch(`${base}/readyz`, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(200);
  });
});
