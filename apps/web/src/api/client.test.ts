import { describe, expect, it, vi } from "vitest";
import { createApi } from "./client";
import { ApiError, createHttp } from "./http";

const ME = {
  userId: "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10",
  tenantId: "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11",
  email: "a@example.com",
};
const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function apiWith(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method as string,
      ...(init.body ? { body: JSON.parse(init.body as string) } : {}),
    });
    return handler(url, init);
  }) as never;
  return { api: createApi(createHttp({ fetch })), calls };
}

describe("createApi", () => {
  it("logs in with the credentials as JSON and parses the identity", async () => {
    const { api, calls } = apiWith(() => ok(ME));
    expect(await api.login({ email: "a@example.com", password: "pw" })).toEqual(ME);
    expect(calls).toEqual([
      { url: "/api/auth/login", method: "POST", body: { email: "a@example.com", password: "pw" } },
    ]);
  });

  it("encodes the cursor of an older page of messages, and leaves it out when absent", async () => {
    const { api, calls } = apiWith(() => ok({ items: [], nextCursor: null }));
    await api.listMessages("c1", "1.5");
    await api.listMessages("c1");
    await api.listMessages("c1", "x=y&z");
    expect(calls.map((c) => c.url)).toEqual([
      "/api/chats/c1/messages?cursor=1.5",
      "/api/chats/c1/messages",
      "/api/chats/c1/messages?cursor=x%3Dy%26z",
    ]);
  });

  it("sends, stops, patches and deletes on the documented routes", async () => {
    const chat = {
      id: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
      title: null,
      scope: "all",
      createdAt: "2026-10-21T10:00:00.000Z",
      lastMessageAt: null,
      messageCount: 0,
    };
    const { api, calls } = apiWith((url, init) =>
      init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : url.endsWith("/stop")
          ? ok({ stopped: true }, 202)
          : url.endsWith("/messages")
            ? ok({ messageId: "m1" }, 202)
            : ok(chat),
    );
    await api.sendMessage("c1", {
      text: "hi",
      messageId: "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10",
      editOf: 3,
    });
    expect(await api.stopChat("c1")).toEqual({ stopped: true });
    await api.patchChat("c1", { title: "Renamed" });
    await api.deleteChat("c1");
    await api.deleteDocument("d1");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/chats/c1/messages",
      "POST /api/chats/c1/stop",
      "PATCH /api/chats/c1",
      "DELETE /api/chats/c1",
      "DELETE /api/documents/d1",
    ]);
    expect(calls[0]?.body).toEqual({
      text: "hi",
      messageId: "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10",
      editOf: 3,
    });
  });

  it("encodes an id it builds into a path", async () => {
    const { api, calls } = apiWith(() => new Response(null, { status: 204 }));
    await api.deleteChat("../x?y");
    expect(calls[0]?.url).toBe("/api/chats/..%2Fx%3Fy");
  });
});

class FakeXhr {
  static last: FakeXhr;
  upload: {
    onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void;
  } = {};
  status = 0;
  responseText = "";
  withCredentials = false;
  responseType = "";
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  ontimeout?: () => void;
  sent?: FormData;
  method?: string;
  url?: string;
  aborted = false;
  open(m: string, u: string) {
    this.method = m;
    this.url = u;
    FakeXhr.last = this;
  }
  setRequestHeader() {}
  getResponseHeader(name: string) {
    return name === "retry-after" ? "3" : null;
  }
  send(body: FormData) {
    this.sent = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}
const DOC = {
  id: "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11",
  title: "T",
  filename: "f.txt",
  mime: "text/plain",
  sizeBytes: 3,
  status: "uploaded",
  error: null,
  stats: null,
  summary: null,
  createdAt: "2026-10-21T10:00:00.000Z",
  updatedAt: "2026-10-21T10:00:00.000Z",
};

describe("uploadDocument", () => {
  const make = (onUnauthorized = vi.fn()) =>
    createApi(createHttp({ fetch: (async () => ok({})) as never }), {
      xhr: () => new FakeXhr() as never,
      onUnauthorized,
    });

  it("posts the file as the multipart field 'file' and reports whole-percent progress", async () => {
    const percents: number[] = [];
    const done = make().uploadDocument(new File(["abc"], "f.txt"), {
      onProgress: (p) => percents.push(p),
    });
    const x = FakeXhr.last;
    expect([x.method, x.url]).toEqual(["POST", "/api/documents"]);
    expect((x.sent as FormData).get("file")).toBeInstanceOf(File);
    x.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 3 });
    x.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 3 });
    x.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });
    x.status = 200;
    x.responseText = JSON.stringify({ document: DOC, duplicate: false });
    x.onload?.();
    expect((await done).document.id).toBe(DOC.id);
    expect(percents).toEqual([33, 100]);
  });

  it("maps a refusal to an ApiError and a dead connection to 'network'", async () => {
    const refused = make().uploadDocument(new File(["a"], "f.exe"));
    FakeXhr.last.status = 415;
    FakeXhr.last.responseText = JSON.stringify({
      error: { code: "unsupported_type", message: "sentinel-title-0123456789" },
    });
    FakeXhr.last.onload?.();
    const err = await refused.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 415, code: "unsupported_type", retryAfter: 3 });
    const lost = make().uploadDocument(new File(["a"], "f.txt"));
    FakeXhr.last.onerror?.();
    await expect(lost).rejects.toMatchObject({ status: 0, code: "network" });
  });

  it("aborts through the signal, and signs out on an expired session", async () => {
    const ctl = new AbortController();
    const aborted = make().uploadDocument(new File(["a"], "f.txt"), { signal: ctl.signal });
    ctl.abort();
    expect(FakeXhr.last.aborted).toBe(true);
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    const onUnauthorized = vi.fn();
    const expired = make(onUnauthorized).uploadDocument(new File(["a"], "f.txt"));
    FakeXhr.last.status = 401;
    FakeXhr.last.responseText = JSON.stringify({ error: { code: "unauthorized", message: "m" } });
    FakeXhr.last.onload?.();
    await expect(expired).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
