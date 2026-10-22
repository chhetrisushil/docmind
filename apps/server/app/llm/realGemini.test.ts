import { LlmUnavailableError } from "@docmind/llm-anthropic";
import type { LlmProvider } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { VisionReader } from "../flows/ingest-document/vision";
import { createRoleProvider } from "./factory";
import { loadLlmRoles } from "./roles";
import { PROBE_TOKEN, probePdf } from "./testing/realFixtures";

// Opt-in: DOCMIND_REAL_GEMINI=1 plus GEMINI_API_KEY exported in the shell. The key is read only to hand
// to the provider: it is never printed, never in a test name or an assertion message. Not part of the gate.
const ON = process.env.DOCMIND_REAL_GEMINI === "1" && !!process.env.GEMINI_API_KEY?.trim();
const SECOND = 1000;
const ATTEMPTS = 3;

function provider(maxTokens: number): LlmProvider {
  const env: NodeJS.ProcessEnv = {
    DOCMIND_LLM_PROVIDER: "off",
    DOCMIND_VISION_PDF_PROVIDER: "gemini",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ...(process.env.DOCMIND_REAL_GEMINI_MODEL && {
      DOCMIND_VISION_PDF_MODEL: process.env.DOCMIND_REAL_GEMINI_MODEL,
    }),
    DOCMIND_GEMINI_THINKING_BUDGET: "0",
  };
  const p = createRoleProvider("visionPdf", loadLlmRoles(env), env, {
    maxTokens,
    timeoutMs: 120 * SECOND,
  });
  if (!p) throw new Error("role is off");
  return p;
}

/** A fresh call per attempt (no sleep); null after ATTEMPTS transient failures (G3, G4: 429 / 503). */
async function withRetries<T>(call: () => Promise<T>): Promise<T | null> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (!(e instanceof LlmUnavailableError)) throw e;
    }
  }
  return null;
}

describe.skipIf(!ON)("real Gemini", () => {
  it(
    "reads page 1 of a one-page PDF through VisionReader",
    { timeout: 400 * SECOND },
    async (ctx) => {
      const reader = new VisionReader({ pdf: provider(2000), pdfMaxBytes: 1024 * 1024 });
      const pages = await withRetries(() => reader.readPdfPages(probePdf(), [1]));
      if (pages === null) return ctx.skip();
      expect(pages.has(1)).toBe(true);
      expect(pages.get(1)?.includes(PROBE_TOKEN)).toBe(true);
    },
  );

  it(
    "a thinking budget of 0 with maxTokens 200 ends end_turn",
    { timeout: 400 * SECOND },
    async (ctx) => {
      const p = provider(200);
      const res = await withRetries(() =>
        p.complete({
          messages: [{ role: "user", content: "Reply with the single word: ready." }],
          maxTokens: 200,
          temperature: 0,
        }),
      );
      if (res === null) return ctx.skip();
      expect({ stop: res.stopReason, nonEmpty: res.content.trim().length > 0 }).toEqual({
        stop: "end_turn",
        nonEmpty: true,
      });
    },
  );
});
