import type { ProviderSpec } from "@loom-ui/core";

export const LIST_CAP = 200;
export const CHAT_LIST_CAP = 50;
export const CONTENT_STEP = 20;
export const CONTENT_CAP = 200;

/** The step kind DocMind registers with hydration (Task 186c). */
export const KIND = "docmind";

/**
 * The contract pin of each provider target: bump the number when a target's raw output changes shape. A step carries
 * its pin; the data provider refuses a different one (`schemaDrift`), which is how a stale view is noticed.
 */
export const PINS = {
  "documents.list": "docmind:documents.list@1",
  "document.get": "docmind:document.get@1",
  "document.content": "docmind:document.content@1",
  "chats.list": "docmind:chats.list@1",
  "host.published": "docmind:host.published@1",
} as const;
export type Target = keyof typeof PINS;

export function provider(
  handle: string,
  o: { target: Target; args: Record<string, unknown>; overridable?: string[]; reshaper: string },
): ProviderSpec {
  return {
    handle,
    executionGraph: [
      {
        stepId: "read",
        kind: KIND,
        toolName: o.target,
        toolVersion: "1.0.0",
        toolSchemaHash: PINS[o.target],
        arguments: o.args,
        dependsOn: [],
        idempotent: true,
        overridable: o.overridable ?? [],
      },
    ],
    reshaping: { engine: "Named", scriptRef: o.reshaper },
    outputShapeHash: "",
    outputCheck: "contract",
    cachePolicy: { ttlSeconds: 0, scope: "principal" },
  };
}
