import {
  type ChatMessageDto,
  type ChatSessionDto,
  ChatStreamEvent,
  type DocumentDto,
  type DocumentPassage,
  DocumentProgressEvent,
  UiHydrateRequest,
  ViewName,
} from "@docmind/contracts";
import type { UiReaders } from "@docmind/experiences";
import { fakeUi } from "./fakeUi";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, code: string) => json(status, { error: { code, message: "m" } });
const stamp = () => new Date().toISOString();
const frame = (event: string, data: unknown, id?: string) =>
  `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const tick = async (n = 3) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

interface Account {
  email: string;
  password: string;
  userId: string;
  tenantId: string;
}

/** The fake's answer: markdown with a citation marker, raw HTML and an unsafe link in it (see `reply`). */
export const answerMarkdown = (marker: string): string =>
  [
    `Payment is due in **30 days**.${marker}`,
    "",
    "- Net terms apply to every invoice.",
    "- <b>Late</b> fees accrue monthly.",
    "",
    "Read the [terms](https://example.com/terms) or [click](javascript:alert(1)).",
  ].join("\n");

export class FakeServer {
  loggedIn = false;
  docs: DocumentDto[] = [];
  chats: ChatSessionDto[] = [];
  messages = new Map<string, ChatMessageDto[]>();
  calls: string[] = [];
  readonly receipt = "R".repeat(43);
  private account: Account | undefined;
  private passages = new Map<string, DocumentPassage[]>();
  private streams: { path: string; send(chunk: string): void }[] = [];
  // Frames pushed while no stream was open on their path wait here, and go out when one opens: a live frame is never dropped.
  private buffered = new Map<string, string[]>();
  private waiters = new Map<string, (() => void)[]>();
  private holds = new Map<string, Promise<void>>();
  /** When set, a turn ends with a `closed` frame (the chat is over). */
  closeAfterTurn = false;
  private checks = 0;
  private ord = 0;
  // The real compiled views and the real `hydrate` (shared with the component tests), over this fake's own state.
  private readonly ui = fakeUi(this.readers());

  private identity() {
    const a = this.account as Account;
    return { userId: a.userId, tenantId: a.tenantId, email: a.email };
  }

  /** A frame to every open stream on `path`, or held until one opens. Every frame must be valid on the wire contract. */
  push(path: string, event: string, data: unknown, id?: string): void {
    if (path === "/api/documents/events") DocumentProgressEvent.parse(data);
    else if (path.endsWith("/stream"))
      ChatStreamEvent.parse({ ...(data as Record<string, unknown>), kind: event });
    const open = this.streams.filter((s) => s.path === path);
    const chunk = frame(event, data, id);
    if (open.length === 0) this.buffered.set(path, [...(this.buffered.get(path) ?? []), chunk]);
    for (const s of open) s.send(chunk);
  }
  /** How many streams are open on `path` right now. */
  openStreams(path: string): number {
    return this.streams.filter((s) => s.path === path).length;
  }
  private streamOpen(path: string): Promise<void> {
    if (this.openStreams(path) > 0) return Promise.resolve();
    return new Promise((resolve) =>
      this.waiters.set(path, [...(this.waiters.get(path) ?? []), resolve]),
    );
  }
  /** Pauses the scripted work at `point` ("ready": before a document finishes; "message": before the durable reply) until the returned function is called. */
  hold(point: "ready" | "message"): () => void {
    let release = () => {};
    this.holds.set(
      point,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  }
  private async held(point: string): Promise<void> {
    await this.holds.get(point);
  }
  /** The id of the first passage the fake served for a document. */
  passageIdOf(documentId: string): string | undefined {
    return this.passages.get(documentId)?.[0]?.passageId;
  }
  private open(path: string, first?: string): Response {
    const enc = new TextEncoder();
    let entry: { path: string; send(chunk: string): void } | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        entry = {
          path,
          send: (chunk) => {
            try {
              c.enqueue(enc.encode(chunk));
            } catch {
              /* closed */
            }
          },
        };
        this.streams.push(entry);
        entry.send("retry: 3000\n\n");
        if (first) entry.send(first);
        for (const chunk of this.buffered.get(path) ?? []) entry.send(chunk);
        this.buffered.delete(path);
        for (const wake of this.waiters.get(path) ?? []) wake();
        this.waiters.delete(path);
      },
      cancel: () => {
        this.streams = this.streams.filter((s) => s !== entry);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  readonly fetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), "http://fake.test");
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname;
    this.calls.push(`${method} ${path}`);
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    let m: RegExpExecArray | null = null;

    if (method === "POST" && path === "/api/auth/sign-up") {
      this.account = {
        email: String(body.email),
        password: String(body.password),
        userId: crypto.randomUUID(),
        tenantId: crypto.randomUUID(),
      };
      return json(202, { status: "accepted" });
    }
    if (method === "POST" && path === "/api/auth/login") {
      if (
        !this.account ||
        body.email !== this.account.email ||
        body.password !== this.account.password
      )
        return fail(401, "invalid_credentials");
      this.loggedIn = true;
      return json(200, this.identity());
    }
    if (method === "POST" && path === "/api/auth/logout") {
      this.loggedIn = false;
      return new Response(null, { status: 204 });
    }
    m = /^\/api\/erasure\/([^/]+)$/.exec(path);
    if (m && method === "GET")
      return m[1] === this.receipt
        ? json(200, { state: ++this.checks <= 1 ? "pending" : "done" })
        : fail(404, "not_found");
    if (!this.loggedIn || !this.account) return fail(401, "unauthorized");

    if (path === "/api/me" && method === "GET") return json(200, this.identity());
    if (path === "/api/me" && method === "DELETE") {
      if (body.password !== this.account.password) return fail(401, "invalid_credentials");
      this.loggedIn = false;
      this.checks = 0;
      return json(202, { erasure: "accepted", receipt: this.receipt });
    }

    m = /^\/api\/ui\/views\/([^/]+)$/.exec(path);
    if (m && method === "GET") {
      const name = ViewName.safeParse(m[1]);
      return name.success ? json(200, await this.ui.api.uiView(name.data)) : fail(404, "not_found");
    }
    if (path === "/api/ui/hydrate" && method === "POST") {
      const req = UiHydrateRequest.safeParse(body);
      if (!req.success) return fail(400, "invalid_request");
      return json(200, { results: await this.ui.api.uiHydrate(req.data.view, req.data.requests) });
    }
    if (path === "/api/documents/events" && method === "GET") return this.open(path);
    if (path === "/api/documents" && method === "GET")
      return json(200, { items: [...this.docs], nextCursor: null });
    m = /^\/api\/documents\/([^/]+)$/.exec(path);
    if (m) {
      const doc = this.docs.find((d) => d.id === m?.[1]);
      if (!doc) return fail(404, "not_found");
      if (method === "GET") return json(200, doc);
      if (method === "DELETE") {
        this.docs = this.docs.filter((d) => d !== doc);
        return new Response(null, { status: 204 });
      }
    }
    m = /^\/api\/documents\/([^/]+)\/content$/.exec(path);
    if (m && method === "GET")
      return this.docs.some((d) => d.id === m?.[1])
        ? json(200, { items: this.passages.get(m[1] as string) ?? [], nextCursor: null })
        : fail(404, "not_found");

    if (path === "/api/chats" && method === "GET")
      return json(200, { items: [...this.chats].reverse(), nextCursor: null });
    if (path === "/api/chats" && method === "POST") {
      const chat: ChatSessionDto = {
        id: crypto.randomUUID(),
        title: null,
        scope: (body.scope as ChatSessionDto["scope"]) ?? "all",
        createdAt: stamp(),
        lastMessageAt: null,
        messageCount: 0,
      };
      this.chats.push(chat);
      this.messages.set(chat.id, []);
      return json(200, chat);
    }
    m = /^\/api\/chats\/([^/]+)(\/messages|\/stream|\/stop)?$/.exec(path);
    if (m) {
      const chat = this.chats.find((c) => c.id === m?.[1]);
      if (!chat) return fail(404, "not_found");
      const sub = m[2];
      if (!sub && method === "GET") return json(200, chat);
      if (!sub && method === "PATCH") {
        Object.assign(chat, body);
        return json(200, chat);
      }
      if (!sub && method === "DELETE") {
        this.chats = this.chats.filter((c) => c !== chat);
        return new Response(null, { status: 204 });
      }
      if (sub === "/messages" && method === "GET")
        return json(200, { items: [...(this.messages.get(chat.id) ?? [])], nextCursor: null });
      if (sub === "/stop" && method === "POST") return json(202, { stopped: false });
      if (sub === "/stream" && method === "GET")
        return this.open(
          path,
          frame("status", {
            state: "open",
            running: false,
            turns: (this.messages.get(chat.id) ?? []).filter((x) => x.role === "user").length,
          }),
        );
      if (sub === "/messages" && method === "POST") {
        const text = String(body.text);
        const user = this.record(chat, "user", text);
        this.push(`/api/chats/${chat.id}/stream`, "message", { ...user }, user.cursor);
        void this.runTurn(chat, user.turn);
        return json(202, { messageId: String(body.messageId ?? "m") });
      }
    }
    return fail(404, "not_found");
  }) as typeof fetch;

  /** The readers the server's UI plane would be given, over this fake's state. */
  private readers(): UiReaders {
    const ready = new Set(["uploaded", "parsing", "embedding"]);
    return {
      documents: async ({ limit, status }) => ({
        items: this.docs
          .filter(
            (d) =>
              status === "all" ||
              (status === "processing" ? ready.has(d.status) : d.status === status),
          )
          .slice(0, limit),
        truncated: false,
      }),
      document: async ({ id }) => this.docs.find((d) => d.id === id) ?? null,
      content: async ({ id, upto, passage }) => {
        if (!this.docs.some((d) => d.id === id)) return null;
        const all = this.passages.get(id) ?? [];
        const keep = Math.max(
          upto,
          passage === undefined ? 0 : all.findIndex((p) => p.passageId === passage) + 1,
        );
        return { items: all.slice(0, keep), more: all.length > keep };
      },
      chats: async ({ q }) =>
        [...this.chats]
          .reverse()
          .filter((c) => (c.title ?? "New chat").toLowerCase().includes(q.toLowerCase())),
    };
  }

  private record(
    chat: ChatSessionDto,
    role: "user" | "assistant",
    text: string,
    over: Partial<ChatMessageDto> = {},
  ): ChatMessageDto {
    const list = this.messages.get(chat.id) as ChatMessageDto[];
    const turn =
      role === "user"
        ? list.filter((x) => x.role === "user").length + 1
        : list.filter((x) => x.role === "user").length;
    const ord = ++this.ord;
    const message: ChatMessageDto = {
      id: String(ord),
      turn,
      role,
      text,
      status: "complete",
      citations: [],
      cursor: `1.${ord * 10}`,
      reasoning: null,
      steps: [],
      outcome: null,
      createdAt: stamp(),
      ...over,
    };
    list.push(message);
    chat.messageCount = list.length;
    chat.lastMessageAt = message.createdAt;
    return message;
  }

  /** The scripted answer to a question: thinking, one search step, a streamed answer, then the cited reply. */
  private async runTurn(chat: ChatSessionDto, turn: number): Promise<void> {
    const stream = `/api/chats/${chat.id}/stream`;
    const doc = this.docs[0];
    const passage = doc ? this.passages.get(doc.id)?.[0] : undefined;
    await this.streamOpen(stream);
    await tick();
    this.push(stream, "reasoning-partial", { turn, text: "Looking through the documents" });
    await tick();
    const step = {
      name: "search_docs" as const,
      label: "Searched documents",
      count: passage ? 1 : 0,
    };
    this.push(stream, "tool", { turnKey: turn, step });
    await tick();
    const marker = passage ? ` [[${passage.passageId}]]` : "";
    // The answer is markdown on purpose, and hostile on purpose: emphasis split across two deltas, a list, raw HTML, a safe link and a
    // `javascript:` link. loom-ui must draw the first three as elements and leave the last two inert (Task 199b).
    const body = answerMarkdown(marker);
    this.push(stream, "answer", { turn, text: body.slice(0, 21) });
    this.push(stream, "answer", { turn, text: body.slice(21) });
    await tick();
    await this.held("message");
    const citations =
      doc && passage
        ? [
            {
              passageId: passage.passageId,
              documentId: doc.id,
              docTitle: doc.title,
              locator: passage.locator,
              snippet: passage.text,
            },
          ]
        : [];
    const reply = this.record(chat, "assistant", body, {
      citations,
      steps: [step],
      reasoning: { text: "Looking through the documents", kind: "summary" },
    });
    this.push(stream, "message", { ...reply }, reply.cursor);
    if (this.closeAfterTurn) this.push(stream, "closed", {});
  }

  /** A fake XMLHttpRequest for `uploadDocument`: stores the file as a document and walks it to ready on the progress stream. */
  xhr(): XMLHttpRequest {
    const server = this;
    const x = {
      status: 0,
      responseText: "",
      withCredentials: false,
      responseType: "",
      upload: {} as { onprogress?: (e: unknown) => void },
      onload: undefined as (() => void) | undefined,
      onerror: undefined as (() => void) | undefined,
      ontimeout: undefined as (() => void) | undefined,
      onabort: undefined as (() => void) | undefined,
      open() {},
      setRequestHeader() {},
      getResponseHeader: () => null,
      abort() {
        x.onabort?.();
      },
      send(form: FormData) {
        void (async () => {
          await tick();
          server.calls.push("POST /api/documents");
          if (!server.loggedIn) {
            x.status = 401;
            x.responseText = JSON.stringify({ error: { code: "unauthorized", message: "m" } });
            return x.onload?.();
          }
          const file = form.get("file") as File;
          x.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
          const doc = server.addDocument(file.name, file.size);
          x.status = 200;
          x.responseText = JSON.stringify({ document: doc, duplicate: false });
          x.onload?.();
          void server.process(doc.id);
        })();
      },
    };
    return x as unknown as XMLHttpRequest;
  }
  private addDocument(filename: string, size: number): DocumentDto {
    const doc: DocumentDto = {
      id: crypto.randomUUID(),
      title: filename.replace(/\.[^.]+$/, ""),
      filename,
      mime: "application/pdf",
      sizeBytes: size,
      status: "uploaded",
      error: null,
      stats: null,
      summary: null,
      createdAt: stamp(),
      updatedAt: stamp(),
    };
    this.docs.unshift(doc);
    return doc;
  }
  private async process(id: string): Promise<void> {
    const at = () => this.docs.find((d) => d.id === id);
    await this.streamOpen("/api/documents/events");
    for (const [status, step] of [
      ["parsing", "parse"],
      ["embedding", "embed"],
    ] as const) {
      await tick();
      const d = at();
      if (!d) return;
      d.status = status;
      this.push("/api/documents/events", "progress", { documentId: id, step, status });
    }
    await tick();
    await this.held("ready");
    const d = at();
    if (!d) return;
    this.passages.set(id, [
      {
        passageId: crypto.randomUUID(),
        ordinal: 0,
        locator: { kind: "page", page: 1 },
        headingPath: ["Payment terms"],
        text: "Payment is due within 30 days of the invoice date.",
      },
    ]);
    Object.assign(d, {
      status: "ready",
      stats: {
        wordCount: 420,
        pageCount: 2,
        readingTimeMinutes: 2,
        language: "en",
        outline: ["Payment terms"],
        dates: [],
        numbers: ["30 days"],
      },
      summary: {
        tldr: "Payment is due in 30 days.",
        keyPoints: ["Net 30"],
        entities: [],
        topics: ["Payments"],
        suggestedQuestions: ["When is payment due?"],
      },
    });
    this.push("/api/documents/events", "progress", {
      documentId: id,
      step: "finalize",
      status: "ready",
    });
  }
}
