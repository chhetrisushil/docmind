import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../../compose";
import { loadBlobRoot, loadLimits } from "../../documents/limits";
import { SECRET_VARIABLES } from "../../secrets";
import { StartupConfigError } from "../../startupError";
import { createIngestWiring } from "../ingest-document/limits";
import { loadPlannerDecisionKey, plannerModelOf } from "./planner";

const VAR = "DOCMIND_PLANNER_DECISION_KEY";
const b64 = (n: number) => randomBytes(n).toString("base64");

describe("loadPlannerDecisionKey (R19)", () => {
  it("decodes base64 of 32 or more bytes to bytes", () => {
    const raw = randomBytes(48);
    const key = loadPlannerDecisionKey({ [VAR]: raw.toString("base64") }, true);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(key as Uint8Array).equals(raw)).toBe(true);
    expect(loadPlannerDecisionKey({ [VAR]: `  ${b64(32)}\n` }, true)?.length).toBe(32);
  });

  it("with the role on, a missing, non-base64 or short key is a config error naming the variable (never its value)", () => {
    const cases: Record<string, string | undefined> = {
      missing: undefined,
      blank: "   ",
      "not base64": "this is *not* base64!!",
      "unpadded length": `${b64(32)}A`,
      "31 bytes": b64(31),
    };
    for (const [name, value] of Object.entries(cases)) {
      const env = value === undefined ? {} : { [VAR]: value };
      let thrown: unknown;
      try {
        loadPlannerDecisionKey(env, true);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, name).toBeInstanceOf(StartupConfigError);
      expect((thrown as Error).message, name).toContain(VAR);
      if (value?.trim()) expect((thrown as Error).message, name).not.toContain(value.trim());
    }
  });

  it("with the role off, the key is not required (a bad one is not read either)", () => {
    expect(loadPlannerDecisionKey({}, false)).toBeUndefined();
    expect(loadPlannerDecisionKey({ [VAR]: "  " }, false)).toBeUndefined();
    for (const bad of ["not*base64!", b64(8)])
      expect(() => loadPlannerDecisionKey({ [VAR]: bad }, false)).not.toThrow();
    expect(loadPlannerDecisionKey({ [VAR]: b64(8) }, false)).toBeUndefined();
  });

  it("can be mounted as a file like the other secrets", () => {
    expect(SECRET_VARIABLES).toContain(VAR);
  });
});

describe("plannerModelOf", () => {
  it("calls the provider directly, with the system prompt, at temperature 0 and the caller's signal, and returns content and usage", async () => {
    const seen: LlmRequest[] = [];
    const llm: LlmProvider = {
      complete: async (r) => {
        seen.push(r);
        return {
          content: "{}",
          stopReason: "end_turn",
          usage: { inputTokens: 3, outputTokens: 4 },
        };
      },
    };
    const abort = new AbortController();
    const out = await plannerModelOf(llm).complete(
      { system: "SYS", messages: [{ role: "user", content: "hello" }] },
      { signal: abort.signal },
    );
    expect(out).toEqual({ content: "{}", usage: { inputTokens: 3, outputTokens: 4 } });
    expect(seen[0]).toMatchObject({ system: "SYS", temperature: 0, signal: abort.signal });
    expect(seen[0]?.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("plannerModelOf concurrency", () => {
  it("holds at most two planner calls in flight process-wide: a third waits until one finishes, across models", async () => {
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const providerFor = (name: string): LlmProvider => ({
      complete: async () => {
        started.push(name);
        await new Promise<void>((resolve) => gates.set(name, resolve));
        return { content: name, stopReason: "end_turn" };
      },
    });
    const ask = (name: string, signal?: AbortSignal) =>
      plannerModelOf(providerFor(name)).complete(
        { messages: [{ role: "user", content: "x" }] },
        signal ? { signal } : undefined,
      );
    const a = ask("a");
    const b = ask("b");
    const c = ask("c");
    await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual(["a", "b"]); // c is queued
    gates.get("a")?.();
    expect((await a).content).toBe("a");
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
    gates.get("b")?.();
    gates.get("c")?.();
    expect((await Promise.all([b, c])).map((r) => r.content)).toEqual(["b", "c"]);
  });
  it("lets an aborted waiter leave the queue without taking a slot, and frees the slot when a call throws", async () => {
    const gates: (() => void)[] = [];
    const slow: LlmProvider = {
      complete: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return { content: "slow", stopReason: "end_turn" };
      },
    };
    const boom: LlmProvider = {
      complete: async () => {
        throw new Error("model down");
      },
    };
    const msg = { messages: [{ role: "user" as const, content: "x" }] };
    const a = plannerModelOf(slow).complete(msg);
    const b = plannerModelOf(slow).complete(msg);
    const abort = new AbortController();
    const waiter = plannerModelOf(slow).complete(msg, { signal: abort.signal });
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    abort.abort(new Error("stopped"));
    await expect(waiter).rejects.toThrow("stopped");
    gates[0]?.();
    gates[1]?.();
    await Promise.all([a, b]);
    await expect(plannerModelOf(boom).complete(msg)).rejects.toThrow("model down");
    const after = plannerModelOf(slow).complete(msg); // both slots are free again
    await vi.waitFor(() => expect(gates).toHaveLength(3));
    gates[2]?.();
    expect((await after).content).toBe("slow");
  });
});

describe("composing the server", () => {
  const compose = (env: NodeJS.ProcessEnv, plannerDecisionKey?: Uint8Array) => {
    const root = mkdtempSync(join(tmpdir(), "dm-planner-key-"));
    try {
      return buildServer({
        pool: {} as Pool,
        keys: new InMemoryKeyStore(),
        storage: { kind: "custom", eventStore: new InMemoryAsyncEventStore() },
        limits: loadLimits({}),
        blobRoot: loadBlobRoot({ DOCMIND_BLOB_DIR: root }),
        secureCookies: false,
        trustProxy: false,
        ingest: createIngestWiring(env),
        status: {} as never,
        ...(plannerDecisionKey && { plannerDecisionKey }),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const ON = { DOCMIND_VISUALS_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test-not-real" };

  it("refuses the visuals role without the decision key", () => {
    expect(() => compose(ON)).toThrow(StartupConfigError);
    expect(() => compose(ON)).toThrow(VAR);
  });
});
