import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
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
