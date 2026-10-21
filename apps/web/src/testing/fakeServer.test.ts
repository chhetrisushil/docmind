import {
  ChatMessageDto,
  ListDocumentsResponse,
  ListMessagesResponse,
  MeResponse,
} from "@docmind/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeServer } from "./fakeServer";

const post = (s: FakeServer, path: string, body?: unknown, method = "POST") =>
  s.fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const frames = (s: FakeServer, path: string) => {
  const seen: { event: string; data: Record<string, unknown> }[] = [];
  const decoder = new TextDecoder();
  void (async () => {
    const res = await s.fetch(path, {});
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value);
      for (const block of buffer.split("\n\n").slice(0, -1)) {
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) seen.push({ event, data: JSON.parse(data) });
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
    }
  })();
  return seen;
};
async function signedIn() {
  const s = new FakeServer();
  expect(
    (
      await post(s, "/api/auth/sign-up", {
        email: "ada@example.com",
        password: "correct horse battery",
      })
    ).status,
  ).toBe(202);
  const res = await post(s, "/api/auth/login", {
    email: "ada@example.com",
    password: "correct horse battery",
  });
  expect(MeResponse.safeParse(await res.json()).success).toBe(true);
  return s;
}

describe("FakeServer: auth", () => {
  it("refuses every call that needs a session, and a wrong password, and records the calls", async () => {
    const s = new FakeServer();
    expect((await s.fetch("/api/me", {})).status).toBe(401);
    expect(
      ((await (await s.fetch("/api/documents", {})).json()) as { error: { code: string } }).error
        .code,
    ).toBe("unauthorized");
    await post(s, "/api/auth/sign-up", {
      email: "ada@example.com",
      password: "correct horse battery",
    });
    expect(
      (await post(s, "/api/auth/login", { email: "ada@example.com", password: "wrong" })).status,
    ).toBe(401);
    expect(s.calls).toContain("GET /api/me");
  });
  it("erases an account behind the right password and answers the receipt route pending, then done", async () => {
    const s = await signedIn();
    expect((await post(s, "/api/me", { password: "nope" }, "DELETE")).status).toBe(401);
    const res = await post(s, "/api/me", { password: "correct horse battery" }, "DELETE");
    expect(res.status).toBe(202);
    const { receipt } = (await res.json()) as { receipt: string };
    expect(s.loggedIn).toBe(false);
    expect(await (await s.fetch(`/api/erasure/${receipt}`, {})).json()).toEqual({
      state: "pending",
    });
    expect(await (await s.fetch(`/api/erasure/${receipt}`, {})).json()).toEqual({ state: "done" });
    expect((await s.fetch("/api/erasure/unknown", {})).status).toBe(404);
  });
});

describe("FakeServer: documents", () => {
  it("takes an upload, tells the progress stream parsing, embedding and ready, and then serves summary and content", async () => {
    const s = await signedIn();
    const seen = frames(s, "/api/documents/events");
    await vi.waitFor(() => expect(s.calls).toContain("GET /api/documents/events"));
    const xhr = s.xhr() as unknown as {
      open(m: string, u: string): void;
      send(f: FormData): void;
      onload?: () => void;
      status: number;
      responseText: string;
      upload: { onprogress?: (e: unknown) => void };
    };
    xhr.open("POST", "/api/documents");
    const form = new FormData();
    form.append("file", new File(["hello"], "contract.pdf"));
    const done = new Promise<void>((r) => {
      xhr.onload = () => r();
    });
    xhr.send(form);
    await done;
    expect(xhr.status).toBe(200);
    const created = JSON.parse(xhr.responseText) as {
      document: { id: string; status: string };
      duplicate: boolean;
    };
    expect(created.document.status).toBe("uploaded");
    await vi.waitFor(() =>
      expect(seen.map((f) => (f.data as { status?: string }).status)).toEqual([
        "parsing",
        "embedding",
        "ready",
      ]),
    );
    const list = ListDocumentsResponse.parse(await (await s.fetch("/api/documents", {})).json());
    expect(list.items[0]).toMatchObject({
      id: created.document.id,
      status: "ready",
      filename: "contract.pdf",
    });
    expect(list.items[0]?.summary?.tldr).toBeTruthy();
    const content = (await (
      await s.fetch(`/api/documents/${created.document.id}/content`, {})
    ).json()) as { items: { text: string }[] };
    expect(content.items.length).toBe(1);
    expect(
      (await s.fetch(`/api/documents/${created.document.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      ListDocumentsResponse.parse(await (await s.fetch("/api/documents", {})).json()).items,
    ).toEqual([]);
  });
});

describe("FakeServer: the UI plane", () => {
  it("serves the real compiled views and hydrates them from its own state; an anonymous caller gets 401", async () => {
    const anon = new FakeServer();
    expect((await anon.fetch("/api/ui/views/library", {})).status).toBe(401);
    const s = await signedIn();
    const view = (await (await s.fetch("/api/ui/views/library", {})).json()) as {
      experienceId: string;
      versionHash: string;
      inventory: { handles: { handle: string }[] };
    };
    expect(view.inventory.handles.map((h) => h.handle).sort()).toEqual([
      "doc-ready",
      "doc-total",
      "documents",
      "ingest",
    ]);
    expect((await s.fetch("/api/ui/views/nope", {})).status).toBe(404);
    const load = async () => {
      const res = await post(s, "/api/ui/hydrate", {
        view: "library",
        requests: [
          {
            experienceId: view.experienceId,
            versionHash: view.versionHash,
            handle: "doc-total",
            params: {},
          },
        ],
      });
      return ((await res.json()) as { results: { state: string; value: { value: number } }[] })
        .results[0];
    };
    expect((await load())?.value.value).toBe(0);
    const xhr = s.xhr() as unknown as {
      open(m: string, u: string): void;
      send(f: FormData): void;
      onload?: () => void;
    };
    xhr.open("POST", "/api/documents");
    const form = new FormData();
    form.append("file", new File(["hello"], "contract.pdf"));
    const up = new Promise<void>((r) => {
      xhr.onload = () => r();
    });
    xhr.send(form);
    await up;
    expect((await load())?.value.value).toBe(1);
  });
});

describe("FakeServer: chat", () => {
  it("runs a turn on send: the user's message, reasoning, a tool step, answer deltas, then the cited reply", async () => {
    const s = await signedIn();
    const xhr = s.xhr() as unknown as {
      open(m: string, u: string): void;
      send(f: FormData): void;
      onload?: () => void;
    };
    xhr.open("POST", "/api/documents");
    const form = new FormData();
    form.append("file", new File(["hello"], "contract.pdf"));
    const up = new Promise<void>((r) => {
      xhr.onload = () => r();
    });
    xhr.send(form);
    await up;
    const chat = (await (await post(s, "/api/chats", { scope: "all" })).json()) as { id: string };
    const seen = frames(s, `/api/chats/${chat.id}/stream`);
    await vi.waitFor(() => expect(seen.map((f) => f.event)).toContain("status"));
    expect(
      (await post(s, `/api/chats/${chat.id}/messages`, { text: "When is payment due?" })).status,
    ).toBe(202);
    await vi.waitFor(() =>
      expect(seen.some((f) => f.event === "message" && f.data.role === "assistant")).toBe(true),
    );
    expect(seen.map((f) => f.event)).toEqual(
      expect.arrayContaining(["message", "reasoning-partial", "tool", "answer"]),
    );
    const history = ListMessagesResponse.parse(
      await (await s.fetch(`/api/chats/${chat.id}/messages`, {})).json(),
    );
    expect(history.items.map((m) => m.role)).toEqual(["user", "assistant"]);
    const reply = ChatMessageDto.parse(history.items[1]);
    expect(reply.citations.length).toBe(1);
    expect(reply.text).toContain(`[[${reply.citations[0]?.passageId}]]`);
    expect(reply.steps.length).toBe(1);
    expect(reply.reasoning?.text).toBeTruthy();
  });
});
