import { randomUUID } from "node:crypto";

/** A thin client for the routes the scenarios call. Writes carry a matching Origin, which the server's guard checks. */
export class Api {
  readonly origin: string;

  constructor(readonly baseUrl: string) {
    this.origin = new URL(baseUrl).origin;
  }

  headers(cookie?: string, extra: Record<string, string> = {}): Record<string, string> {
    return { origin: this.origin, ...(cookie !== undefined && { cookie }), ...extra };
  }

  async json<T>(path: string, cookie: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(cookie), ...(init.headers as Record<string, string>) },
    });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Sign-up is throttled per client address (5 free). The server reads the last X-Forwarded-For entry only
   * with DOCMIND_TRUST_PROXY=true, so each user gets a made-up address.
   */
  async signUp(email: string, password: string, ip: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/auth/sign-up`, {
      method: "POST",
      headers: this.headers(undefined, {
        "content-type": "application/json",
        "x-forwarded-for": ip,
      }),
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 429)
      throw new Error("sign-up throttled: start the server with DOCMIND_TRUST_PROXY=true");
    if (res.status !== 202) throw new Error(`sign-up -> ${res.status}`);
  }

  async logIn(email: string, password: string, ip: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: this.headers(undefined, {
        "content-type": "application/json",
        "x-forwarded-for": ip,
      }),
      body: JSON.stringify({ email, password }),
    });
    if (res.status !== 200) throw new Error(`login -> ${res.status}`);
    const cookie = res.headers.getSetCookie()[0]?.split(";")[0];
    if (!cookie) throw new Error("login set no session cookie");
    return cookie;
  }

  /** The raw response, so a caller can tell 201 from 429. */
  upload(
    cookie: string,
    filename: string,
    mime: string,
    content: string | Uint8Array,
  ): Promise<Response> {
    const form = new FormData();
    form.append("file", new Blob([content], { type: mime }), filename);
    return fetch(`${this.baseUrl}/api/documents`, {
      method: "POST",
      headers: this.headers(cookie),
      body: form,
    });
  }

  async documentStatus(cookie: string, id: string): Promise<{ status: string; error: unknown }> {
    return this.json(`/api/documents/${id}`, cookie);
  }

  async createChat(cookie: string): Promise<string> {
    const chat = await this.json<{ id: string }>("/api/chats", cookie, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "all" }),
    });
    return chat.id;
  }
}

export const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function pool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, i: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i] as T, i);
      }
    }),
  );
}

/** Unique, readable markdown: `seed` makes a different text per call, so no upload is a duplicate. */
export function makeDocument(label: string, paragraphs = 12): string {
  const topics = [
    "invoices",
    "contracts",
    "travel",
    "budgets",
    "research",
    "hiring",
    "security",
    "roadmaps",
  ];
  const out = [`# ${label}`, ""];
  for (let p = 0; p < paragraphs; p++) {
    const topic = topics[(p + label.length) % topics.length];
    out.push(
      `## Section ${p + 1}: ${topic}`,
      "",
      `Notes on ${topic} for ${label}, reference ${randomUUID()}. The team reviewed the ${topic} figures, agreed the next steps and recorded who owns each one. Open questions about ${topic} are listed below with their due dates.`,
      "",
    );
  }
  return out.join("\n");
}
