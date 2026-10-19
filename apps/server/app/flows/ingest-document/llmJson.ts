import { LlmOutputError } from "@docmind/llm-anthropic";
import type { z } from "zod";

/** The model's reply as JSON: tolerates one ```json fence; anything else is LlmOutputError. */
export function jsonAnswer<T>(content: string, schema: z.ZodType<T>): T {
  const raw = content
    .trim()
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new LlmOutputError();
  }
  const parsed = schema.safeParse(value); // never surface the ZodError: its issues quote the content
  if (!parsed.success) throw new LlmOutputError();
  return parsed.data;
}
