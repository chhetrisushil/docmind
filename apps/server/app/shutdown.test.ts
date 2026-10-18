import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { shutdown } from "./shutdown";

describe("shutdown", () => {
  it("lets the in-flight request finish before it closes the app", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    let arrived: () => void = () => undefined;
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const server = createServer((_req, res) => {
      arrived();
      release = () => {
        order.push("response sent");
        res.end("done");
      };
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const inFlight = fetch(url).then((r) => r.text());
    await requestArrived;
    const closing = shutdown(server, {
      close: async () => {
        order.push("app closed");
      },
    });
    release();

    expect(await inFlight).toBe("done");
    await closing;
    expect(order).toEqual(["response sent", "app closed"]);
  });

  it("does not close the app when the server fails to close", async () => {
    const server = createServer(); // never listened: close() reports ERR_SERVER_NOT_RUNNING
    let closed = false;
    await expect(
      shutdown(server, {
        close: async () => {
          closed = true;
        },
      }),
    ).rejects.toThrow();
    expect(closed).toBe(false);
  });
});
