import { type IncomingMessage, request } from "node:http";
import { type AddressInfo, type Socket, connect } from "node:net";
import { type MockInstance, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAT_STREAM_ROUTE, chatStreamRoutes } from "./chats/stream";
import { documentEventRoutes } from "./documents/events";
import { documentRoutes } from "./documents/routes";
import { DEFAULT_HTTP_LIMITS, createHttpServer, loadMaxConnections } from "./server";

const server = createHttpServer();
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("http server", () => {
  it("GET /healthz returns ok", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers an unknown route with a JSON 404", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "no such route" } });
  });

  it("answers an unparseable request target with a JSON 400 and keeps serving", async () => {
    // fetch normalizes URLs, so send the raw target `//` (invalid against a base URL).
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      request({ host: "127.0.0.1", port: Number(new URL(base).port), path: "//" }, resolve)
        .on("error", reject)
        .end();
    });
    expect(res.statusCode).toBe(400);
    let body = "";
    for await (const chunk of res) body += chunk;
    expect(JSON.parse(body).error).toEqual({
      code: "bad_request",
      message: "invalid request target",
    });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe("handler failures", () => {
  const marked = new Error("secret detail sk-live-1234");
  const failing = createHttpServer({
    "GET /rejects": async () => {
      throw new Error("boom");
    },
    "GET /throws": () => {
      throw new Error("boom");
    },
    "GET /marked": () => {
      throw marked;
    },
    "GET /rejects-after-headers": async (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      throw new Error("boom");
    },
  });
  let url = "";
  let consoleError: MockInstance<typeof console.error>;

  beforeAll(async () => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(failing.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      failing.close(() => resolve());
      failing.closeAllConnections();
    });
    consoleError.mockRestore();
  });

  it.each(["/rejects", "/throws"])(
    "answers a JSON 500 when %s fails, and keeps serving",
    async (path) => {
      const res = await fetch(`${url}${path}`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: "internal", message: "internal error" } });
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
    },
  );

  it("logs the failure server-side and keeps the 500 body fixed", async () => {
    const res = await fetch(`${url}/marked`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: { code: "internal", message: "internal error" } });
    expect(body).not.toContain("secret detail");
    // P11: class name, method and path only; never the error object or its message.
    expect(consoleError).toHaveBeenCalledWith("handler failed", "GET", "/marked", "Error");
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain("secret detail");
    for (const call of consoleError.mock.calls) expect(call).not.toContain(marked);
  });

  it("ends a response that already started instead of hanging or crashing", async () => {
    const res = await fetch(`${url}/rejects-after-headers`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("partial");
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });
});

describe("route parameters", () => {
  const withParams = createHttpServer({
    "GET /things/:id": (_req, res, ctx) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: ctx.params.id }));
    },
    "GET /things/new": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ exact: true }));
    },
    "DELETE /things/:id/parts/:part": (_req, res, ctx) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ctx.params));
    },
  });
  let paramBase = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => withParams.listen(0, "127.0.0.1", resolve));
    paramBase = `http://127.0.0.1:${(withParams.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => withParams.close(() => resolve()));
  });

  it("passes a path segment as a parameter, decoded", async () => {
    expect(await (await fetch(`${paramBase}/things/abc`)).json()).toEqual({ id: "abc" });
    expect(await (await fetch(`${paramBase}/things/a%20b`)).json()).toEqual({ id: "a b" });
  });

  it("prefers an exact route to a parameterised one", async () => {
    expect(await (await fetch(`${paramBase}/things/new`)).json()).toEqual({ exact: true });
  });

  it("supports several parameters and requires the method to match", async () => {
    const del = await fetch(`${paramBase}/things/1/parts/2`, { method: "DELETE" });
    expect(await del.json()).toEqual({ id: "1", part: "2" });
    expect((await fetch(`${paramBase}/things/1/parts/2`)).status).toBe(404);
  });

  it("does not match an empty segment, an extra segment or a bad escape", async () => {
    expect((await fetch(`${paramBase}/things/`)).status).toBe(404);
    expect((await fetch(`${paramBase}/things/a/b`)).status).toBe(404);
    expect((await fetch(`${paramBase}/things/%E0%A4%A`)).status).toBe(404);
  });

  it("matches a literal colon segment through the pattern, with the segment as the value", async () => {
    expect(await (await fetch(`${paramBase}/things/:id`)).json()).toEqual({ id: ":id" });
  });

  it("decodes an encoded slash into one segment", async () => {
    expect(await (await fetch(`${paramBase}/things/a%2Fb`)).json()).toEqual({ id: "a/b" });
  });

  it("treats a parameter named like an object prototype key as plain data", async () => {
    expect(await (await fetch(`${paramBase}/things/__proto__`)).json()).toEqual({
      id: "__proto__",
    });
  });
});

describe("server limits", () => {
  it("applies the documented defaults", () => {
    const s = createHttpServer();
    expect([s.headersTimeout, s.requestTimeout, s.keepAliveTimeout]).toEqual([20_000, 0, 5_000]);
    expect([s.maxConnections, s.maxHeadersCount]).toEqual([2000, 100]);
    expect(DEFAULT_HTTP_LIMITS.connectionsCheckingIntervalMs).toBe(5_000);
  });

  it("reads DOCMIND_MAX_CONNECTIONS, naming the variable on a bad value", () => {
    expect(loadMaxConnections({})).toBe(2000);
    expect(loadMaxConnections({ DOCMIND_MAX_CONNECTIONS: "65535" })).toBe(65_535);
    for (const bad of ["0", "-1", "abc", "65536", "1.5"]) {
      expect(() => loadMaxConnections({ DOCMIND_MAX_CONNECTIONS: bad })).toThrow(
        /DOCMIND_MAX_CONNECTIONS must be/,
      );
    }
  });

  async function started(
    routes: Parameters<typeof createHttpServer>[0],
    limits: Parameters<typeof createHttpServer>[2],
  ) {
    const server = createHttpServer(routes, { secure: false, log: () => {} }, limits);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, port: (server.address() as AddressInfo).port };
  }
  const closed = (socket: Socket) =>
    new Promise<void>((resolve) => socket.once("close", () => resolve()));

  it("cuts a client that sends its headers too slowly, destroying the socket", async () => {
    const { server, port } = await started(
      {},
      { headersTimeoutMs: 50, connectionsCheckingIntervalMs: 10 },
    );
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    socket.on("data", () => {});
    socket.write("GET /healthz HTTP/1.1\r\nHost: x\r\n"); // never finishes the header block
    await closed(socket);
    server.close();
  });

  it("answers 503 timeout when a JSON route never answers, then keeps serving", async () => {
    const { server, port } = await started(
      { "GET /hang": () => new Promise<void>(() => {}) },
      { requestTimeoutMs: 20 },
    );
    const res = await fetch(`http://127.0.0.1:${port}/hang`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("timeout");
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    server.closeAllConnections();
    server.close();
  });

  it("destroys the socket when the route times out after headers were sent", async () => {
    const { server, port } = await started(
      {
        "GET /half": (_req, res) => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.write("partial"); // never ends
        },
      },
      { requestTimeoutMs: 20 },
    );
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    socket.on("data", () => {});
    socket.write("GET /half HTTP/1.1\r\nHost: x\r\n\r\n");
    await closed(socket);
    server.close();
  });

  it("never times out a streaming route (upload, SSE), which outlives the route timeout", async () => {
    let timedOut = false;
    const { server, port } = await started(
      {
        "GET /api/documents/events": (_req, res) => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(": open\n\n");
        },
        "GET /hang": () => new Promise<void>(() => {}),
        // A request timer armed here would answer 503 before the handler ends the response.
        "POST /api/documents": (req, res) => {
          req.resume();
          req.on("end", () => {
            setTimeout(() => res.end("done"), 80);
          });
        },
      },
      { requestTimeoutMs: 20 },
    );
    const sse = connect(port, "127.0.0.1");
    sse.on("error", () => {});
    sse.on("close", () => {
      timedOut = true;
    });
    sse.write("GET /api/documents/events HTTP/1.1\r\nHost: x\r\n\r\n");
    await new Promise<void>((resolve) => sse.once("data", () => resolve()));
    // A non-streaming route armed alongside it times out; the stream is still open after.
    expect((await fetch(`http://127.0.0.1:${port}/hang`)).status).toBe(503);
    const res = await fetch(`http://127.0.0.1:${port}/api/documents`, {
      method: "POST",
      body: "x",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("done");
    expect(timedOut).toBe(false);
    sse.destroy();
    await closed(sse);
    server.closeAllConnections();
    server.close();
  });

  it("never times out the chat stream route, which outlives the route timeout", async () => {
    let timedOut = false;
    const { server, port } = await started(
      {
        [CHAT_STREAM_ROUTE]: (_req, res) => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(": open\n\n");
        },
        "GET /hang": () => new Promise<void>(() => {}),
      },
      { requestTimeoutMs: 20 },
    );
    const sse = connect(port, "127.0.0.1");
    sse.on("error", () => {});
    sse.on("close", () => {
      timedOut = true;
    });
    sse.write("GET /api/chats/c/stream HTTP/1.1\r\nHost: x\r\n\r\n");
    await new Promise<void>((resolve) => sse.once("data", () => resolve()));
    // A non-streaming route armed alongside it times out; the stream is still open after.
    expect((await fetch(`http://127.0.0.1:${port}/hang`)).status).toBe(503);
    expect(timedOut).toBe(false);
    sse.destroy();
    await closed(sse);
    server.closeAllConnections();
    server.close();
  });

  it("refuses the connection past the cap", async () => {
    const { server, port } = await started({}, { maxConnections: 1 });
    const first = connect(port, "127.0.0.1");
    first.on("error", () => {});
    await new Promise<void>((resolve) => server.once("connection", () => resolve()));
    const second = connect(port, "127.0.0.1");
    second.on("error", () => {});
    await closed(second);
    expect(first.destroyed).toBe(false);
    first.destroy();
    server.closeAllConnections();
    server.close();
  });

  it("exempts only keys the real route tables register", () => {
    const registered = new Set([
      // biome-ignore lint/suspicious/noExplicitAny: only the route keys are read
      ...Object.keys(documentRoutes({} as any)),
      // biome-ignore lint/suspicious/noExplicitAny: only the route keys are read
      ...Object.keys(documentEventRoutes({} as any).routes),
      // biome-ignore lint/suspicious/noExplicitAny: only the route keys are read
      ...Object.keys(chatStreamRoutes({} as any).routes),
    ]);
    expect([...DEFAULT_HTTP_LIMITS.streamingRoutes].filter((k) => !registered.has(k))).toEqual([]);
  });

  it("survives a handler that settles after its 503", async () => {
    let settle: () => void = () => {};
    const late = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, port } = await started(
      {
        "GET /late": async (_req, res) => {
          await late;
          res.writeHead(200); // headers already sent by the 503: throws inside the wrapper
          res.end();
        },
      },
      { requestTimeoutMs: 20 },
    );
    expect((await fetch(`http://127.0.0.1:${port}/late`)).status).toBe(503);
    settle();
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith("handler failed", "GET", "/late", "Error"),
    );
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect(unhandled).toEqual([]);
    process.off("unhandledRejection", onUnhandled);
    errors.mockRestore();
    server.closeAllConnections();
    server.close();
  });
});
