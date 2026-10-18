import { type Server, createServer, request } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ReceiveResult, UploadTooLargeError, receiveFile } from "./multipart";

const MAX = 100;
const BIG = 8 * 1024 * 1024;
let seen: { filename: string; bytes: string }[] = [];

const start = async (max: number) => {
  const server = createServer((req, res) => {
    receiveFile(req, { maxFileBytes: max }, async (file) => {
      if (file.filename === "ignored.bin") return { filename: file.filename, bytes: "" };
      if (file.filename === "rejected.bin") throw new UploadTooLargeError();
      const chunks: Buffer[] = [];
      for await (const c of file.body) chunks.push(Buffer.from(c));
      const got = { filename: file.filename, bytes: Buffer.concat(chunks).toString() };
      seen.push(got);
      if (got.filename === "boom.txt") throw new Error("handler exploded");
      if (got.filename === "toolarge.txt") throw new UploadTooLargeError();
      return got;
    }).then(
      (result) => {
        res.setHeader("connection", "close");
        res.writeHead(result.ok ? 200 : result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.ok ? result.value : { code: result.code }));
      },
      () => {
        res.setHeader("connection", "close");
        res.writeHead(500);
        res.end();
      },
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};
const stop = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

let small: { server: Server; base: string };
let big: { server: Server; base: string };
beforeAll(async () => {
  small = await start(MAX);
  big = await start(BIG);
});
afterAll(async () => {
  await stop(small.server);
  await stop(big.server);
});

const post = (form: FormData, base = small.base) =>
  fetch(`${base}/`, { method: "POST", body: form });
const file = (name: string, content: string, field = "file") => {
  const form = new FormData();
  form.append(field, new Blob([content]), name);
  return form;
};

describe("receiveFile", () => {
  it("streams the single file part to the handler", async () => {
    seen = [];
    const res = await post(file("notes.txt", "hello"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ filename: "notes.txt", bytes: "hello" });
  });

  it("keeps a unicode filename intact and strips any directory part", async () => {
    seen = [];
    await post(file("café/../résumé.txt", "x"));
    expect(seen[0]?.filename).toBe("résumé.txt");
  });

  it("accepts a file of exactly the limit and rejects one byte more with 413", async () => {
    expect((await post(file("a.txt", "x".repeat(MAX)))).status).toBe(200);
    const res = await post(file("a.txt", "x".repeat(MAX + 1)));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: "payload_too_large" });
  });

  it("answers 413 up front when the declared length is far over the limit", async () => {
    expect((await post(file("a.txt", "x".repeat(200_000)))).status).toBe(413);
  });

  it("answers 415 for a body that is not multipart", async () => {
    const res = await fetch(`${small.base}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  it("answers 400 for no file or a wrongly named file part, and never calls the handler for them", async () => {
    seen = [];
    expect((await post(new FormData())).status).toBe(400);
    expect((await post(file("a.txt", "x", "upload"))).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("ignores text fields and any later parts: only the first file part is used", async () => {
    seen = [];
    const form = new FormData();
    form.append("note", "hello");
    form.append("file", new Blob(["first"]), "a.txt");
    form.append("file", new Blob(["second"]), "b.txt");
    expect((await post(form)).status).toBe(200);
    expect(seen).toEqual([{ filename: "a.txt", bytes: "first" }]);
  });

  it("answers 400 for a malformed multipart body", async () => {
    const res = await fetch(`${small.base}/`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=zzz" },
      body: "garbage with no boundary at all",
    });
    expect(res.status).toBe(400);
  });

  it("answers 400, not 500, for a truncated multipart body", async () => {
    const res = await fetch(`${small.base}/`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=zzz" },
      body: '--zzz\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\ntruncated',
    });
    expect(res.status).toBe(400);
  });

  it("rejects the request when the handler fails for any other reason", async () => {
    expect((await post(file("boom.txt", "x"))).status).toBe(500);
  });

  it("maps UploadTooLargeError thrown by the handler to 413", async () => {
    expect((await post(file("toolarge.txt", "x"))).status).toBe(413);
  });

  it("drains a >1 MiB file the handler never read, so an early answer does not stall", async () => {
    const body = "x".repeat(2 * 1024 * 1024);
    const ignored = await post(file("ignored.bin", body), big.base);
    expect(ignored.status).toBe(200);
    const rejected = await post(file("rejected.bin", body), big.base);
    expect(rejected.status).toBe(413);
  });

  const head = (boundary: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\n`;

  it("settles with a 400-class result and fails the body when the client aborts mid-file", async () => {
    let bodyError: unknown;
    let result: Promise<ReceiveResult<string>> | undefined;
    let started!: () => void;
    const handlerStarted = new Promise<void>((r) => {
      started = r;
    });
    const server = createServer((req) => {
      result = receiveFile(req, { maxFileBytes: 1000 }, async (f) => {
        started();
        try {
          for await (const _ of f.body) {
            // consume until the abort surfaces
          }
        } catch (e) {
          bodyError = e;
          throw e;
        }
        return "done";
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
    socket.write(
      `POST / HTTP/1.1\r\nhost: x\r\ncontent-type: multipart/form-data; boundary=b\r\ncontent-length: 1000\r\n\r\n${head("b")}abc`,
    );
    await handlerStarted;
    socket.destroy();
    const settled = await result;
    expect(settled).toMatchObject({ ok: false, status: 400 });
    expect(bodyError).toBeInstanceOf(Error);
    await stop(server);
  });

  it("maps a synchronous throw from the handler like a rejection", async () => {
    let result: Promise<ReceiveResult<string>> | undefined;
    const server = createServer((req) => {
      result = receiveFile(req, { maxFileBytes: 100 }, () => {
        throw new UploadTooLargeError();
      });
      result.then(
        (r) => {
          req.resume();
          return r;
        },
        () => {},
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const form = file("a.txt", "x");
    fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: form }).catch(() => {});
    await vi.waitFor(() => expect(result).toBeDefined());
    expect(await result).toMatchObject({ ok: false, status: 413 });
    await stop(server);
  });

  it("answers 413 for a chunked body past the cap without waiting for the client to finish", async () => {
    const res = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        big.base.replace(/:\d+$/, `:${(small.server.address() as AddressInfo).port}`),
        { method: "POST", headers: { "content-type": "multipart/form-data; boundary=b" } },
        (r) => {
          r.resume();
          resolve(r.statusCode);
          req.destroy();
        },
      );
      req.on("error", (e) => {});
      req.write(head("b"));
      // Well past the cap, then stop: the body is never ended, so only the cap can end the request.
      req.write(Buffer.alloc(256 * 1024, 120));
    });
    expect(res).toBe(413);
  });
});
