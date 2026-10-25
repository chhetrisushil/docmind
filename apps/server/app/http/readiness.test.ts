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

  it("needs no session and no Origin or Fetch Metadata, like /healthz", async () => {
    const base = await serve(createReadiness({ ping: async () => {} }), true);
    const res = await fetch(`${base}/readyz`, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(200);
  });
});
