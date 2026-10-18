import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UploadTooLargeError, receiveFile } from "./multipart";

const MAX = 100;
let seen: { filename: string; bytes: string }[] = [];

const start = async (max: number) => {
  const server = createServer((req, res) => {
    receiveFile(req, { maxFileBytes: max }, async (file) => {
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
beforeAll(async () => {
  small = await start(MAX);
});
afterAll(async () => {
  await stop(small.server);
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

  it("rejects the request when the handler fails for any other reason", async () => {
    expect((await post(file("boom.txt", "x"))).status).toBe(500);
  });

  it("maps UploadTooLargeError thrown by the handler to 413", async () => {
    expect((await post(file("toolarge.txt", "x"))).status).toBe(413);
  });
});
