import { LlmRequestError, LlmUnavailableError } from "@docmind/llm-anthropic";
import { afterEach, describe, expect, it } from "vitest";
import { StartupConfigError } from "../startupError";
import { createRoleProvider } from "./factory";
import { loadLlmRoles } from "./roles";
import { startFakeGemini, startFakeOpenAiCompat } from "./testing";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});
type Opts = Parameters<typeof createRoleProvider>[3];
const make = (
  role: Parameters<typeof createRoleProvider>[0],
  env: NodeJS.ProcessEnv,
  extra: Partial<Opts> = {},
) =>
  createRoleProvider(role, loadLlmRoles(env), env, { maxTokens: 111, timeoutMs: 5_000, ...extra });
const ASK = { messages: [{ role: "user" as const, content: "sentinel-question" }] };

/** Puts values in process.env (what Loom's providers read when handed no key) for the duration of `f`. */
async function withProcessEnv(vars: Record<string, string>, f: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    await f();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}
const SENTINELS = {
  OPENAI_API_KEY: "sentinel-openai-key",
  GOOGLE_API_KEY: "sentinel-google-key",
  GEMINI_API_KEY: "sentinel-process-gemini-key",
  ANTHROPIC_API_KEY: "sentinel-process-anthropic-key",
};

describe("createRoleProvider", () => {
  it("is undefined for a role that is off", () => {
    expect(make("title", { DOCMIND_TITLE_PROVIDER: "off" })).toBeUndefined();
  });

  describe("ollama", () => {
    it("completes against DOCMIND_OLLAMA_URL with the role's model, maxTokens and an empty bearer, never another provider's key", async () => {
      const fake = await startFakeOpenAiCompat();
      closers.push(fake.close);
      fake.reply(() => ({ kind: "text", text: "a title" }));
      await withProcessEnv(SENTINELS, async () => {
        const p = make("title", { DOCMIND_OLLAMA_URL: fake.url });
        expect((await p?.complete(ASK))?.content).toBe("a title");
      });
      expect(fake.requests[0]).toMatchObject({
        path: "/v1/chat/completions",
        authorization: "Bearer",
        body: { model: "gemma4:31b-cloud", max_tokens: 111, stream: false },
      });
      expect(fake.requests[0]?.body).not.toHaveProperty("reasoning_effort");
    });
    it("a trailing slash on the URL never yields //v1", async () => {
      const fake = await startFakeOpenAiCompat();
      closers.push(fake.close);
      const p = make("title", { DOCMIND_OLLAMA_URL: `${fake.url}///` });
      await p?.complete(ASK);
      expect(fake.requests[0]?.path).toBe("/v1/chat/completions");
    });
    it("an uppercase scheme works", async () => {
      const fake = await startFakeOpenAiCompat();
      closers.push(fake.close);
      const p = make("title", { DOCMIND_OLLAMA_URL: fake.url.replace("http", "HTTP") });
      await p?.complete(ASK);
      expect(fake.requests).toHaveLength(1);
    });
    it("the chat role streams, declares reasoning, and maps effort to reasoning_effort (max becomes high)", async () => {
      const fake = await startFakeOpenAiCompat();
      closers.push(fake.close);
      fake.reply(() => ({ kind: "text", text: "answer", reasoning: "thought" }));
      const p = make(
        "chat",
        { DOCMIND_OLLAMA_URL: fake.url },
        { chat: { effort: "max", observer: () => undefined } },
      );
      expect(p?.capabilities?.reasoning).toBe(true);
      const chunks = [];
      for await (const c of p?.stream?.(ASK) ?? []) chunks.push(c);
      expect(chunks.some((c) => c.reasoningDelta === "thought")).toBe(true);
      expect(chunks.at(-1)).toMatchObject({ done: true, stopReason: "end_turn" });
      expect(fake.requests[0]?.body.reasoning_effort).toBe("high");
    });
    it("the image role accepts png, jpeg and webp", () => {
      const p = make("vision", {});
      expect(p?.capabilities?.image).toEqual(["image/png", "image/jpeg", "image/webp"]);
      expect(p?.capabilities?.file).toBeUndefined();
    });
    it("maps a 503 to a transient error with only the status, and a 404 to a permanent one", async () => {
      const fake = await startFakeOpenAiCompat();
      closers.push(fake.close);
      const p = make("summary", { DOCMIND_OLLAMA_URL: fake.url });
      fake.reply(() => ({ kind: "error", status: 503 }));
      await expect(p?.complete(ASK)).rejects.toMatchObject({
        name: "LlmUnavailableError",
        status: 503,
      });
      fake.reply(() => ({ kind: "error", status: 404 }));
      const err = await p?.complete(ASK).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmRequestError);
      expect(String((err as Error).message)).not.toContain("sentinel");
    });
    it("a refused connection is transient", async () => {
      const fake = await startFakeOpenAiCompat();
      const url = fake.url;
      await fake.close();
      await expect(
        make("title", { DOCMIND_OLLAMA_URL: url })?.complete(ASK),
      ).rejects.toBeInstanceOf(LlmUnavailableError);
    });
  });

  describe("gemini", () => {
    const geminiEnv = (url: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
      GEMINI_API_KEY: "test-key-not-real",
      GEMINI_BASE_URL: url,
      ...extra,
    });
    const pdf = {
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "file" as const,
              mediaType: "application/pdf",
              source: { kind: "data" as const, data: "JVBERi0=" },
            },
            { type: "text" as const, text: "pages" },
          ],
        },
      ],
    };
    it("reads a PDF with the explicit key header (never a process-env key), the role's model and thinking disabled", async () => {
      const fake = await startFakeGemini();
      closers.push(fake.close);
      fake.reply(() => ({ text: '[{"page":1,"text":"x"}]' }));
      await withProcessEnv(SENTINELS, async () => {
        const p = make("visionPdf", geminiEnv(fake.url));
        const res = await p?.complete(pdf);
        expect(res?.content).toBe('[{"page":1,"text":"x"}]');
      });
      expect(fake.requests[0]).toMatchObject({
        path: "/v1beta/models/gemini-3.5-flash:generateContent",
        keyHeader: "test-key-not-real",
      });
      expect(fake.requests[0]?.body.generationConfig).toMatchObject({
        maxOutputTokens: 111,
        thinkingConfig: { thinkingBudget: 0 },
      });
    });
    it("a trailing slash on GEMINI_BASE_URL never yields //v1beta", async () => {
      const fake = await startFakeGemini();
      closers.push(fake.close);
      await make("visionPdf", geminiEnv(`${fake.url}/`))?.complete(ASK);
      expect(fake.requests[0]?.path).toBe("/v1beta/models/gemini-3.5-flash:generateContent");
    });
    it("sends a zero thinking budget only to gemini-3.5-flash; another model gets none unless one is configured", async () => {
      const fake = await startFakeGemini();
      closers.push(fake.close);
      const other = geminiEnv(fake.url, { DOCMIND_VISION_PDF_MODEL: "gemini-3.5-pro" });
      await make("visionPdf", other)?.complete(ASK);
      const cfg = fake.requests[0]?.body.generationConfig as Record<string, unknown>;
      expect(JSON.stringify(cfg)).not.toContain("thinkingBudget");
      await make("visionPdf", { ...other, DOCMIND_GEMINI_THINKING_BUDGET: "512" })?.complete(ASK);
      expect(fake.requests[1]?.body.generationConfig).toMatchObject({
        thinkingConfig: { thinkingBudget: 512 },
      });
      await make("visionPdf", { ...other, DOCMIND_GEMINI_THINKING_BUDGET: "0" })?.complete(ASK);
      expect(fake.requests[2]?.body.generationConfig).toMatchObject({
        thinkingConfig: { thinkingBudget: 0 },
      });
    });
    it("a 429 is transient with only the status", async () => {
      const fake = await startFakeGemini();
      closers.push(fake.close);
      fake.reply(() => ({ status: 429 }));
      await expect(make("visionPdf", geminiEnv(fake.url))?.complete(ASK)).rejects.toMatchObject({
        name: "LlmUnavailableError",
        status: 429,
      });
    });
    it("refuses a key that is not header-safe, naming the variable", () => {
      expect(() => make("visionPdf", { GEMINI_API_KEY: "bad key\n" })).toThrow(
        /^GEMINI_API_KEY must be a plain ASCII header value$/,
      );
    });
  });

  describe("anthropic", () => {
    it("builds the Claude provider with the role's model, as before", () => {
      const p = make("summary", {
        DOCMIND_SUMMARY_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "test-key-not-real",
      });
      expect((p as { model?: string }).model).toBe("claude-haiku-5-5");
    });
    it("surfaces a 401 as a permanent LlmConfigError and caps maxTokens at the role's", async () => {
      const fake = await startFakeOpenAiCompat();
      closers.push(fake.close);
      const { startFakeAnthropic } = await import("@docmind/llm-anthropic/testing");
      const a = await startFakeAnthropic();
      closers.push(a.close);
      const p = make("summary", {
        DOCMIND_SUMMARY_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "test-key-not-real",
        ANTHROPIC_BASE_URL: a.url,
      });
      await p?.complete({ ...ASK, maxTokens: 5_000 });
      expect(a.requests.at(-1)?.body.max_tokens).toBe(111);
      a.failNext(401);
      await expect(p?.complete(ASK)).rejects.toMatchObject({ name: "LlmConfigError", status: 401 });
    });
    it("names the variable for a bad base URL or key", () => {
      expect(() =>
        make("summary", {
          DOCMIND_SUMMARY_PROVIDER: "anthropic",
          ANTHROPIC_API_KEY: "test-key-not-real",
          ANTHROPIC_BASE_URL: "ftp://x",
        }),
      ).toThrow(/^ANTHROPIC_BASE_URL must be an http/);
      expect(() =>
        make("summary", { DOCMIND_SUMMARY_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "bad key\n" }),
      ).toThrow(/^ANTHROPIC_API_KEY must be a header-safe string$/);
    });
  });

  it("normalises all three base URLs the same way (href, no trailing slash)", async () => {
    const o = await startFakeOpenAiCompat();
    closers.push(o.close);
    const g = await startFakeGemini();
    closers.push(g.close);
    const { startFakeAnthropic } = await import("@docmind/llm-anthropic/testing");
    const a = await startFakeAnthropic();
    closers.push(a.close);
    const env = {
      DOCMIND_OLLAMA_URL: `${o.url.replace("http", "HTTP")}//`,
      GEMINI_API_KEY: "test-key-not-real",
      GEMINI_BASE_URL: `${g.url.replace("http", "HTTP")}/`,
      ANTHROPIC_API_KEY: "test-key-not-real",
      ANTHROPIC_BASE_URL: `${a.url.replace("http", "HTTP")}/`,
    };
    await make("title", env)?.complete(ASK);
    await make("visionPdf", env)?.complete(ASK);
    await make("summary", { ...env, DOCMIND_SUMMARY_PROVIDER: "anthropic" })?.complete(ASK);
    expect(o.requests[0]?.path).toBe("/v1/chat/completions");
    expect(g.requests[0]?.path).toBe("/v1beta/models/gemini-3.5-flash:generateContent");
    expect(a.requests).toHaveLength(1);
  });
  it("rejects an Ollama URL with credentials, naming the variable only", () => {
    const s = loadLlmRoles({});
    const bad = { ...s, ollamaUrl: "http://user:pw-sentinel@host:1" };
    try {
      createRoleProvider("title", bad, {}, { maxTokens: 1, timeoutMs: 1 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StartupConfigError);
      expect(String((e as Error).message)).toMatch(/^DOCMIND_OLLAMA_URL/);
      expect(String((e as Error).message)).not.toContain("sentinel");
    }
  });

  describe("a bounded timeout is a timeout, a caller abort is an abort", () => {
    async function hangingServer() {
      const { createServer } = await import("node:http");
      const server = createServer(() => undefined); // never answers
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      closers.push(
        () =>
          new Promise<void>((ok) => {
            server.closeAllConnections();
            server.close(() => ok());
          }),
      );
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    }
    const drain = async (it: AsyncIterable<unknown> | undefined) => {
      for await (const _ of it ?? []) {
        /* drain */
      }
    };
    const cases = (url: string) =>
      [
        [
          "anthropic",
          make(
            "summary",
            {
              DOCMIND_SUMMARY_PROVIDER: "anthropic",
              ANTHROPIC_API_KEY: "test-key-not-real",
              ANTHROPIC_BASE_URL: url,
            },
            { timeoutMs: 150 },
          ),
        ],
        ["ollama", make("summary", { DOCMIND_OLLAMA_URL: url }, { timeoutMs: 150 })],
      ] as const;
    for (const which of ["anthropic", "ollama"] as const) {
      const pick = (url: string) => cases(url).find((c) => c[0] === which)?.[1];
      it(`${which}: complete times out as LlmUnavailableError, caller abort stays LlmAbortedError`, async () => {
        const url = await hangingServer();
        await expect(pick(url)?.complete(ASK)).rejects.toMatchObject({
          name: "LlmUnavailableError",
        });
        const ac = new AbortController();
        const pending = pick(url)?.complete({ ...ASK, signal: ac.signal });
        setTimeout(() => ac.abort(), 30);
        await expect(pending).rejects.toMatchObject({ name: "LlmAbortedError" });
      });
      it(`${which}: stream times out as LlmStreamError, caller abort stays LlmAbortedError`, async () => {
        const url = await hangingServer();
        await expect(drain(pick(url)?.stream?.(ASK))).rejects.toMatchObject({
          name: "LlmStreamError",
        });
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 30);
        await expect(
          drain(pick(url)?.stream?.({ ...ASK, signal: ac.signal })),
        ).rejects.toMatchObject({ name: "LlmAbortedError" });
      });
    }
  });
});

describe("the wrapped provider keeps its model id", () => {
  it.each([
    ["ollama", {}, "gemma4:31b-cloud"],
    [
      "gemini",
      { DOCMIND_SUMMARY_PROVIDER: "gemini", GEMINI_API_KEY: "test-key-not-real" },
      "gemini-3.5-flash",
    ],
    [
      "anthropic",
      { DOCMIND_SUMMARY_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k-test" },
      "claude-haiku-5-5",
    ],
  ])("%s", (_kind, env, model) => {
    const p = make("summary", env as NodeJS.ProcessEnv) as { model?: string } | undefined;
    expect(p?.model).toBe(model);
  });
});
