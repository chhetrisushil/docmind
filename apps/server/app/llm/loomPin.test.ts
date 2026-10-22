import { GeminiProvider, LlmHttpError, OpenAiProvider } from "@loom/llm";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

const ask = { messages: [{ role: "user" as const, content: "sentinel-question" }] };
const stub = (response: object) => {
  const fn = vi.fn(async () => response as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
};

describe("the Loom pin carries the generic additions the provider factory needs", () => {
  it("has LlmHttpError, status only, body never read (201b)", async () => {
    const text = vi.fn(async () => "sentinel-body");
    stub({ ok: false, status: 429, text, body: { cancel: async () => undefined } });
    const err = await new OpenAiProvider({ apiKey: "" }).complete(ask).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "LlmHttpError", status: 429 });
    expect((err as Error).message).not.toContain("sentinel");
    expect(text).not.toHaveBeenCalled();
    expect(new LlmHttpError("gemini", 503).status).toBe(503);
  });
  it("marks LlmHttpError kind auth for 401/403 and a Gemini API_KEY_INVALID 400 (#698)", async () => {
    stub({ ok: false, status: 401, text: async () => "", body: { cancel: async () => undefined } });
    const a = await new OpenAiProvider({ apiKey: "" }).complete(ask).catch((e: unknown) => e);
    expect(a).toMatchObject({ name: "LlmHttpError", status: 401, kind: "auth" });
    expect(new LlmHttpError("gemini", 403).kind).toBe("auth");
    expect(new LlmHttpError("gemini", 400).kind).toBeUndefined();
    const body = JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "API_KEY_INVALID",
            domain: "googleapis.com",
          },
        ],
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 400 })),
    );
    const g = await new GeminiProvider({ apiKey: "k" }).complete(ask).catch((e: unknown) => e);
    expect(g).toMatchObject({ name: "LlmHttpError", status: 400, kind: "auth" });
  });
  it("reads `reasoning` and sends reasoning_effort (201a)", async () => {
    const fn = stub({
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: "a", reasoning: "sentinel-thought" }, finish_reason: "stop" },
        ],
      }),
    });
    const res = await new OpenAiProvider({ apiKey: "", reasoningEffort: "medium" }).complete(ask);
    expect(res.reasoning?.[0]?.text).toBe("sentinel-thought");
    expect(
      JSON.parse((fn.mock.calls[0] as unknown as [string, { body: string }])[1].body)
        .reasoning_effort,
    ).toBe("medium");
  });
  it("sends thinkingBudget (201c)", async () => {
    const fn = stub({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "a" }] }, finishReason: "STOP" }],
      }),
    });
    await new GeminiProvider({ apiKey: "k", thinkingBudget: 0 }).complete(ask);
    expect(
      JSON.parse((fn.mock.calls[0] as unknown as [string, { body: string }])[1].body)
        .generationConfig.thinkingConfig,
    ).toEqual({ thinkingBudget: 0 });
  });
  it("OpenAiProvider sends request.system as the first system message", async () => {
    const fn = stub({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "a" }, finish_reason: "stop" }],
      }),
    });
    await new OpenAiProvider({ apiKey: "" }).complete({ ...ask, system: "sentinel-system" });
    const body = JSON.parse((fn.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.messages[0]).toEqual({ role: "system", content: "sentinel-system" });
  });
});
