import { afterEach, describe, expect, it } from "vitest";
import { startFakeGemini, startFakeOpenAiCompat } from "./index";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("FakeOpenAiCompat", () => {
  it("answers a JSON completion with content, reasoning and usage, and records the request", async () => {
    const f = await startFakeOpenAiCompat();
    closers.push(f.close);
    f.reply(() => ({
      kind: "text",
      text: "hello",
      reasoning: "thought",
      usage: { prompt: 3, completion: 2 },
    }));
    const res = await post(`${f.url}/v1/chat/completions`, { model: "m", messages: [] });
    const body = (await res.json()) as {
      choices: { message: { content: string; reasoning: string }; finish_reason: string }[];
      usage: { prompt_tokens: number };
    };
    expect(body.choices[0]).toMatchObject({
      message: { content: "hello", reasoning: "thought" },
      finish_reason: "stop",
    });
    expect(body.usage.prompt_tokens).toBe(3);
    expect(f.requests[0]).toMatchObject({ path: "/v1/chat/completions", body: { model: "m" } });
  });
  it("streams reasoning, text and usage as SSE and ends with [DONE]", async () => {
    const f = await startFakeOpenAiCompat();
    closers.push(f.close);
    f.reply(() => ({ kind: "text", text: "ab", reasoning: "xy" }));
    const text = await (
      await post(`${f.url}/v1/chat/completions`, {
        stream: true,
        stream_options: { include_usage: true },
        messages: [],
      })
    ).text();
    expect(text).toContain('"reasoning":"xy"');
    expect(text).toContain('"content":"ab"');
    expect(text).toContain('"usage"');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });
  it("answers tool calls whole, and a scripted error status", async () => {
    const f = await startFakeOpenAiCompat();
    closers.push(f.close);
    f.reply((n) =>
      n === 0
        ? { kind: "tools", calls: [{ name: "search_docs", input: { query: "q" } }] }
        : { kind: "error", status: 503 },
    );
    const first = (await (await post(`${f.url}/v1/chat/completions`, { messages: [] })).json()) as {
      choices: {
        message: { tool_calls: { function: { name: string; arguments: string } }[] };
        finish_reason: string;
      }[];
    };
    expect(first.choices[0]?.finish_reason).toBe("tool_calls");
    expect(first.choices[0]?.message.tool_calls[0]?.function).toEqual({
      name: "search_docs",
      arguments: '{"query":"q"}',
    });
    expect((await post(`${f.url}/v1/chat/completions`, { messages: [] })).status).toBe(503);
  });
  it("records the authorization header it saw", async () => {
    const f = await startFakeOpenAiCompat();
    closers.push(f.close);
    f.reply(() => ({ kind: "text", text: "x" }));
    await fetch(`${f.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer " },
      body: "{}",
    });
    expect(f.requests[0]?.authorization).toBe("Bearer");
  });
});

describe("fakes survive hostile input", () => {
  const raw = (url: string, body: string) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  it("coerces a null, array or scalar JSON body to {} and answers", async () => {
    const f = await startFakeOpenAiCompat();
    closers.push(f.close);
    const g = await startFakeGemini();
    closers.push(g.close);
    for (const b of ["null", "[1,2]", "7", '"s"', "{oops"]) {
      expect((await raw(`${f.url}/v1/chat/completions`, b)).status).toBe(200);
      expect((await raw(`${g.url}/v1beta/models/m:generateContent`, b)).status).toBe(200);
    }
    expect(f.requests.every((r) => Object.keys(r.body).length === 0)).toBe(true);
    expect(g.requests.every((r) => Object.keys(r.body).length === 0)).toBe(true);
  });
  it("answers 500 when the reply callback throws, and keeps serving", async () => {
    const f = await startFakeOpenAiCompat();
    closers.push(f.close);
    const g = await startFakeGemini();
    closers.push(g.close);
    f.reply(() => {
      throw new Error("boom");
    });
    g.reply(() => {
      throw new Error("boom");
    });
    expect((await post(`${f.url}/v1/chat/completions`, {})).status).toBe(500);
    expect((await post(`${g.url}/v1beta/models/m:generateContent`, {})).status).toBe(500);
    f.reply(() => ({ kind: "text", text: "ok" }));
    expect((await post(`${f.url}/v1/chat/completions`, {})).status).toBe(200);
  });
  it("carries id, object, created and model on completions and chunks", async () => {
    const f = await startFakeOpenAiCompat();
    closers.push(f.close);
    const json = (await (
      await post(`${f.url}/v1/chat/completions`, { model: "m-1" })
    ).json()) as Record<string, unknown>;
    expect(json).toMatchObject({ object: "chat.completion", model: "m-1" });
    expect(typeof json.id).toBe("string");
    expect(typeof json.created).toBe("number");
    const sseText = await (
      await post(`${f.url}/v1/chat/completions`, { model: "m-1", stream: true })
    ).text();
    expect(sseText).toContain('"object":"chat.completion.chunk"');
    expect(sseText).toContain('"model":"m-1"');
  });
});

describe("FakeGemini", () => {
  it("answers generateContent and records the key header and the body", async () => {
    const f = await startFakeGemini();
    closers.push(f.close);
    f.reply(() => ({ text: "page one" }));
    const res = await fetch(`${f.url}/v1beta/models/gemini-x:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": "test-key-not-real" },
      body: JSON.stringify({ contents: [] }),
    });
    const body = (await res.json()) as {
      candidates: { content: { parts: { text: string }[] }; finishReason: string }[];
    };
    expect(body.candidates[0]).toMatchObject({
      content: { parts: [{ text: "page one" }] },
      finishReason: "STOP",
    });
    expect(f.requests[0]).toMatchObject({
      path: "/v1beta/models/gemini-x:generateContent",
      keyHeader: "test-key-not-real",
    });
  });
  it("answers a scripted status", async () => {
    const f = await startFakeGemini();
    closers.push(f.close);
    f.reply(() => ({ status: 429 }));
    expect((await post(`${f.url}/v1beta/models/m:generateContent`, {})).status).toBe(429);
  });
});

describe("FakeOpenAiCompat forward", () => {
  it("proxies paths outside /v1/ to the forward target and keeps /v1 local", async () => {
    const other = await startFakeOpenAiCompat();
    closers.push(other.close);
    const f = await startFakeOpenAiCompat({ forward: other.url });
    closers.push(f.close);
    f.reply(() => ({ kind: "text", text: "local" }));
    other.reply(() => ({ kind: "text", text: "remote" }));
    const emb = await post(`${f.url}/api/embed`, { input: ["a"] });
    expect(emb.status).toBe(200);
    expect(other.requests.map((r) => r.path)).toEqual(["/api/embed"]);
    expect(f.requests).toHaveLength(0);
    await post(`${f.url}/v1/chat/completions`, { messages: [] });
    expect(f.requests.map((r) => r.path)).toEqual(["/v1/chat/completions"]);
    expect(other.requests).toHaveLength(1);
  });
});
