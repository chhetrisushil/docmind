import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootServing, listen, loadPort } from "./boot";
import { StartupConfigError } from "./startupError";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
const fresh = () => {
  const s = createServer();
  servers.push(s);
  return s;
};

describe("loadPort", () => {
  it("defaults to 3000 and accepts 0 to 65535", () => {
    expect(loadPort({})).toBe(3000);
    expect(loadPort({ PORT: " 8080 " })).toBe(8080);
    expect(loadPort({ PORT: "0" })).toBe(0);
  });
  it.each(["abc", "-1", "65536", "1.5"])("rejects %s as a StartupConfigError naming PORT", (v) => {
    expect(() => loadPort({ PORT: v })).toThrow(StartupConfigError);
    expect(() => loadPort({ PORT: v })).toThrow(/^PORT must be an integer between 0 and 65535$/);
  });
});

describe("bootServing", () => {
  it("does not start recovery and runs the cleanup when the port is taken", async () => {
    const taken = fresh();
    await listen(taken, 0, "127.0.0.1");
    const { port } = taken.address() as AddressInfo;
    const afterListen = vi.fn();
    const cleanup = vi.fn(async () => {});
    await expect(
      bootServing({
        bind: () => listen(fresh(), port, "127.0.0.1"),
        afterListen,
        cleanup,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(afterListen).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("starts the background work only after a successful listen", async () => {
    const order: string[] = [];
    const s = fresh();
    await bootServing({
      bind: async () => {
        await listen(s, 0, "127.0.0.1");
        order.push(`listening:${s.listening}`);
      },
      afterListen: () => order.push("recovery"),
      cleanup: async () => {
        order.push("cleanup");
      },
    });
    expect(order).toEqual(["listening:true", "recovery"]);
  });
});
