import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DocumentGoneError } from "../errors";
import type { IngestStartInput } from "../flow";
import type { ParsedStore } from "../pgParsed";
import type { StepGuard } from "../stepEffect";
import { finalizeEffect } from "./finalize";

const ref = (): IngestStartInput => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  documentId: randomUUID(),
});
const run = <T extends { execute: (r: IngestStartInput, c: never) => Promise<unknown> }>(
  effect: T,
) => effect.execute(ref(), {} as never);
const recorder = () => {
  const calls: string[] = [];
  const guard: StepGuard = { begin: async (_r, step) => void calls.push(step) };
  return { calls, guard };
};
const store = (count: () => Promise<number>) => ({
  replace: async () => 0,
  count,
  read: async () => [],
  sectionsOf: async () => [],
});

const parsedStore = (present = true) => {
  const state = { present, drops: 0 };
  const parsed: ParsedStore = {
    put: async () => {},
    take: async () => undefined,
    has: async () => state.present,
    drop: async () => {
      state.drops++;
      state.present = false;
    },
  };
  return { parsed, state };
};

describe("finalize", () => {
  it("drops the parsed row and reports the chunk count; a re-run is a no-op", async () => {
    const { guard } = recorder();
    const { parsed, state } = parsedStore();
    const effect = finalizeEffect({ guard, chunks: store(async () => 2), parsed });
    expect(await run(effect)).toEqual({ outcome: "done", count: 2 });
    expect(await parsed.has(ref())).toBe(false);
    expect(await run(effect)).toEqual({ outcome: "done", count: 2 });
    expect(state.drops).toBe(2);
  });

  it("checks the document and reports the chunk count; `ready` is the model's reading of its completion", async () => {
    const { calls, guard } = recorder();
    const chunks = store(async () => 7);
    expect(await run(finalizeEffect({ guard, chunks, parsed: parsedStore().parsed }))).toEqual({
      outcome: "done",
      count: 7,
    });
    expect(calls).toEqual(["finalize"]);
  });

  it("reports ready with count 0 for a document with no chunks (an empty document is not a failure)", async () => {
    const { guard } = recorder();
    expect(
      await run(
        finalizeEffect({ guard, chunks: store(async () => 0), parsed: parsedStore().parsed }),
      ),
    ).toEqual({
      outcome: "done",
      count: 0,
    });
  });

  it("stops as document_gone when the guard says the document is gone, without counting", async () => {
    let counted = false;
    const guard: StepGuard = {
      begin: async () => {
        throw new DocumentGoneError();
      },
    };
    const chunks = store(async () => {
      counted = true;
      return 1;
    });
    expect(await run(finalizeEffect({ guard, chunks, parsed: parsedStore().parsed }))).toEqual({
      outcome: "document_gone",
    });
    expect(counted).toBe(false);
  });

  it("stops as document_gone when the parsed drop finds the document gone", async () => {
    const { guard } = recorder();
    const { parsed } = parsedStore();
    parsed.drop = async () => {
      throw new DocumentGoneError();
    };
    expect(await run(finalizeEffect({ guard, chunks: store(async () => 1), parsed }))).toEqual({
      outcome: "document_gone",
    });
  });

  it("stops as document_gone when the count finds the document gone", async () => {
    const { guard } = recorder();
    const chunks = store(async () => {
      throw new DocumentGoneError();
    });
    expect(await run(finalizeEffect({ guard, chunks, parsed: parsedStore().parsed }))).toEqual({
      outcome: "document_gone",
    });
  });
});
