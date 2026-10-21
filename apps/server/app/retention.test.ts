import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatConversationId } from "./chats/ids";
import { compactionExempt } from "./config";
import { executionIdFor } from "./subject";

const USER = "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10";
const DOC = "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11";
const CHAT = "c1c2c3c4-d5d6-4e7f-8a9b-0c1d2e3f4a5b";

describe("compaction (M5 carry d: the Loom residual stays unreachable)", () => {
  it("exempts every execution family that can be suspended or that the read models fold from its first event", () => {
    expect(compactionExempt(executionIdFor(USER, `ingest-${DOC}`))).toBe(true);
    expect(compactionExempt(`${executionIdFor(USER, `ingest-${DOC}`)}.2`)).toBe(true);
    expect(compactionExempt(chatConversationId(USER, CHAT))).toBe(true); // parked on its inbox: suspendable
  });

  it("leaves only the one-step, always-terminal chat-title flow compactable, and nothing unknown is exempt by accident", () => {
    expect(compactionExempt(executionIdFor(USER, `chat-title-${CHAT}`))).toBe(false);
    expect(compactionExempt("__loom_erasure__")).toBe(false);
  });

  it("no application code compacts a log: nothing in app/ calls LogLifecycle.compact", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          path.endsWith(".ts") &&
          !path.endsWith(".test.ts") &&
          /\.compact\(/.test(readFileSync(path, "utf8"))
        )
          hits.push(path);
      }
    };
    walk(__dirname);
    expect(hits).toEqual([]);
  });
});
