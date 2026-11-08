import type { ProviderSpec } from "@loom-ui/core";

export const LIST_CAP = 200;
export const CHAT_LIST_CAP = 50;
export const CONTENT_STEP = 20;
export const CONTENT_CAP = 200;

/** What one connections read returns at most: related documents, shared entities, and documents named per entity. */
export const CONNECTIONS_CAPS = { related: 8, entities: 12, entityDocuments: 5 } as const;

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
  "document.source": "docmind:document.source@1",
  "chats.list": "docmind:chats.list@1",
  "visual.facts": "docmind:visual.facts@1",
  "turn.facts": "docmind:turn.facts@1",
  "host.published": "docmind:host.published@1",
} as const;
export type Target = keyof typeof PINS;

/**
 * The identity of the fact format visuals are planned over: the pins of the two fact tools, as one short canonical string.
 * A visualize run that ends `done` is stamped with it (visual_runs.format); a stored plan whose stamp differs was made over an
 * older format and is re-planned by the boot sweep. Pure, no content.
 */
export function factFormatFingerprint(): string {
  return `${PINS["visual.facts"]}+${PINS["turn.facts"]}`;
}

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

/**
 * How many of a content read's items a view keeps: the first `upto`, or everything up to a cited passage that lies past
 * them (186c M3), never more than CONTENT_CAP. The one rule, used by the server's reader and the invoker's clip.
 */
export function citedWindow(
  items: readonly { passageId: string }[],
  upto: number,
  cited: string | undefined,
): number {
  const at =
    cited === undefined || cited === "" ? -1 : items.findIndex((p) => p.passageId === cited);
  return Math.min(CONTENT_CAP, Math.max(upto, at + 1));
}
