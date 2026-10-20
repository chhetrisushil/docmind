import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const progressSpy = vi.hoisted(() => ({ hook: undefined as (() => void) | undefined }));
vi.mock("../stepEffect", async (orig) => {
  const real = await orig<typeof import("../stepEffect")>();
  return {
    ...real,
    stepEffect: ((step, guard, work, options) =>
      real.stepEffect(
        step,
        guard,
        (r, signal, progress) =>
          work(r, signal, () => {
            progressSpy.hook?.();
            progress?.();
          }),
        options,
      )) as typeof real.stepEffect,
  };
});
import { DocumentGoneError } from "../errors";
import type { IngestStartInput } from "../flow";
import { LINK_STEP_TIMEOUT_MS, SIMILAR_MIN, SIMILAR_PER_CHUNK } from "../links";
import type { Link } from "../pgLinks";
import type { StepGuard } from "../stepEffect";
import { type LinkDeps, linkEffect } from "./link";

const ref = (): IngestStartInput => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  documentId: randomUUID(),
});
const run = (effect: ReturnType<typeof linkEffect>, r = ref()) => effect.execute(r, {} as never);

function harness(n: number, over: Partial<LinkDeps> = {}) {
  const log = {
    neighbours: [] as { ids: string[]; perChunk: number; min: number }[],
    reads: [] as string[][],
    stored: [] as Link[][],
  };
  const ids = Array.from({ length: n }, (_, i) => `c${i}`);
  const deps: LinkDeps = {
    guard: { begin: async () => {} },
    chunks: {
      replace: async () => 0,
      count: async () => n,
      read: async (_r, got) => {
        log.reads.push(got);
        return got.map((id) => ({
          id,
          text: id === "c1" ? "see the master services agreement" : "x",
        }));
      },
      sectionsOf: async () => ids.map((id) => ({ id, sectionOrdinal: 0 })),
    },
    vectors: {
      neighbours: async (_s: unknown, _d: string, got: string[], perChunk: number, min: number) => {
        log.neighbours.push({ ids: got, perChunk, min });
        return [];
      },
    } as never,
    entities: { replaceForDocument: async () => 0, sharedWith: async () => [] },
    links: {
      replaceForDocument: async (_r, l) => {
        log.stored.push(l);
        return l.length;
      },
      countForDocument: async () => 0,
    },
    titles: {
      others: async () => [
        { documentId: "d", title: "Master Services Agreement", firstChunkId: "t1" },
      ],
    },
    ...over,
  };
  return { deps, log };
}

describe("link step", () => {
  it("batches neighbours by 64 and reads by 256, and stores the built links", async () => {
    const { deps, log } = harness(300);
    const res = await run(linkEffect(deps));
    expect(log.neighbours.map((b) => b.ids.length)).toEqual([64, 64, 64, 64, 44]);
    expect(
      log.neighbours.every((b) => b.perChunk === SIMILAR_PER_CHUNK && b.min === SIMILAR_MIN),
    ).toBe(true);
    expect(log.reads.map((b) => b.length)).toEqual([256, 44]);
    const stored = log.stored[0] ?? [];
    expect(res).toEqual({ outcome: "done", count: stored.length });
    expect(stored.some((l) => l.kind === "reference" && l.dst === "t1" && l.src === "c1")).toBe(
      true,
    );
    expect(stored.some((l) => l.kind === "structure")).toBe(true);
  });

  it("stores nothing for a document with no chunks", async () => {
    const { deps, log } = harness(0);
    expect(await run(linkEffect(deps))).toEqual({ outcome: "done", count: 0 });
    expect(log.neighbours).toEqual([]);
    expect(log.stored).toEqual([[]]);
  });

  it("stops as document_gone when the guard says so", async () => {
    const guard: StepGuard = {
      begin: async () => {
        throw new DocumentGoneError();
      },
    };
    const { deps, log } = harness(3, { guard });
    expect(await run(linkEffect(deps))).toEqual({ outcome: "document_gone" });
    expect(log.stored).toEqual([]);
  });

  it("reports progress once per neighbour batch, after the batch's neighbours were read", async () => {
    const { deps, log } = harness(130);
    const marks: number[] = [];
    progressSpy.hook = () => marks.push(log.neighbours.length);
    try {
      await run(linkEffect(deps));
    } finally {
      progressSpy.hook = undefined;
    }
    expect(marks).toEqual([1, 2, 3]);
  });

  it("uses its own timeout default", () => {
    expect(LINK_STEP_TIMEOUT_MS).toBe(600_000);
  });
});
