import { EmbeddingAbortedError, EmbeddingUnavailableError } from "@docmind/embeddings";
import { InMemoryChunkVectors, type VectorScope } from "@docmind/vector-pg";
import type { EmbeddingProvider } from "@loom/memory";
import { describe, expect, it } from "vitest";
import type { LinkKind } from "../../flows/ingest-document/pgLinks";
import type { LinkHop } from "./links";
import type { Passage } from "./passages";
import { Retriever, SearchUnavailableError } from "./retriever";

const SCOPE: VectorScope = { tenantId: "t1", ownerId: "u1" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [x1, x2, y1, z1, h1, h2] = [1, 2, 3, 4, 5, 6].map(uuid) as [
  string,
  string,
  string,
  string,
  string,
  string,
];
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
// Query = axis 0. Chunk similarity to it is the first component of the unit vector.
const VEC: Record<string, number[]> = {
  [x1]: unit([1, 0, 0, 0]), // sim 1.0
  [x2]: unit([0.9, 0.436, 0, 0]), // ~0.9
  [y1]: unit([0.6, 0, 0.8, 0]), // 0.6
  [z1]: unit([0.1, 0, 0, 0.995]), // ~0.1: below the 0.2 floor, never a candidate
  [h1]: unit([0.18, 0, 0, 0.984]), // ~0.18: also below the floor
  [h2]: unit([0.05, 0.9987, 0, 0]), // ~0.05
};
const DOC: Record<string, string> = {
  [x1]: "X",
  [x2]: "X",
  [y1]: "Y",
  [z1]: "Z",
  [h1]: "Z",
  [h2]: "Z",
};
const EDGES: LinkHop[] = [
  { src: x1, dst: z1, kind: "entity", weight: 0.9, entity: "Acme" },
  { src: x2, dst: h1, kind: "similar", weight: 1 },
  { src: h1, dst: h2, kind: "reference", weight: 1 },
  { src: x1, dst: x2, kind: "structure", weight: 0.5 },
  { src: x1, dst: x2, kind: "similar", weight: 0.8 },
];

function build(
  over: {
    hops?: 0 | 1 | 2;
    embed?: EmbeddingProvider["embed"];
    missing?: string[];
    linksFail?: boolean;
  } = {},
) {
  const registry = new Map<string, string[]>();
  for (const [id, d] of Object.entries(DOC)) registry.set(d, [...(registry.get(d) ?? []), id]);
  const vectors = new InMemoryChunkVectors({
    modelId: "m",
    dimensions: 4,
    chunkIds: async (_s, d) => registry.get(d) ?? [],
  });
  const calls = {
    embed: [] as { texts: readonly string[]; signal?: AbortSignal }[],
    search: 0,
    links: [] as { ids: readonly string[]; opts: Record<string, unknown> }[],
    read: [] as VectorScope[],
  };
  const embedder: EmbeddingProvider = {
    modelId: "m",
    dimensions: 4,
    embed:
      over.embed ??
      (async (texts, opts) => {
        calls.embed.push({ texts, ...(opts?.signal && { signal: opts.signal }) });
        return texts.map(() => [1, 0, 0, 0]);
      }),
  };
  const counting = Object.create(vectors) as InMemoryChunkVectors;
  counting.search = (...a: Parameters<InMemoryChunkVectors["search"]>) => {
    calls.search += 1;
    return vectors.search(...a);
  };
  const passages = {
    read: async (scope: VectorScope, ids: readonly string[]) => {
      calls.read.push(scope);
      return new Map(
        ids
          .filter((id) => id in DOC && !over.missing?.includes(id))
          .map((id): [string, Passage] => [
            id,
            {
              passageId: id,
              documentId: DOC[id] as string,
              docTitle: `Doc ${DOC[id]}`,
              locator: { kind: "section", index: 0 },
              headingPath: [],
              text: `text of ${id}`,
            },
          ]),
      );
    },
  };
  const links = {
    from: async (
      _scope: VectorScope,
      ids: readonly string[],
      opts: { perChunk: number; kinds?: readonly LinkKind[]; documentIds?: readonly string[] },
    ) => {
      calls.links.push({ ids, opts: { ...opts } });
      if (over.linksFail) throw new Error("links failed");
      return ids.flatMap((src) =>
        EDGES.filter(
          (e) =>
            e.src === src &&
            (!opts.kinds || opts.kinds.includes(e.kind)) &&
            (!opts.documentIds || opts.documentIds.includes(DOC[e.dst] as string)),
        )
          .sort((a, b) => b.weight - a.weight)
          .slice(0, opts.perChunk),
      );
    },
  };
  const retriever = new Retriever({
    embedder,
    vectors: counting,
    passages,
    links,
    hops: over.hops ?? 1,
  });
  const seeded = (async () => {
    for (const [d, ids] of registry) {
      await vectors.upsert(
        SCOPE,
        d,
        ids.map((chunkId) => ({ chunkId, vector: VEC[chunkId] as number[] })),
      );
    }
  })();
  return { retriever, calls, ready: seeded };
}
const ids = (ps: Passage[]) => ps.map((p) => p.passageId);

describe("Retriever.search", () => {
  it("with no hops returns the seeds, best first, diversified by MMR", async () => {
    const { retriever, ready, calls } = build({ hops: 0 });
    await ready;
    const out = await retriever.search(SCOPE, "all", "notice period", 8);
    expect(ids(out)).toEqual([x1, x2, y1]);
    expect(out.every((p) => p.via === undefined)).toBe(true);
    expect(out[0]).toMatchObject({ docTitle: "Doc X", text: `text of ${x1}` });
    expect(calls.links).toEqual([]);
  });

  it("embeds the query as it is, with no prefix, and passes the abort signal on", async () => {
    const { retriever, ready, calls } = build();
    await ready;
    const ac = new AbortController();
    await retriever.search(SCOPE, "all", "what is the notice period?", 8, ac.signal);
    expect(calls.embed).toEqual([{ texts: ["what is the notice period?"], signal: ac.signal }]);
  });

  it("follows one hop to a passage the embedding alone would miss, and says why", async () => {
    const { retriever, ready, calls } = build({ hops: 1 });
    await ready;
    const out = await retriever.search(SCOPE, "all", "q", 8);
    expect(ids(out).sort()).toEqual([h1, x1, x2, y1, z1].sort()); // z1 and h1 sit below the floor: only a link finds them
    expect(out.find((p) => p.passageId === z1)?.via).toEqual({
      kind: "entity",
      from: x1,
      entity: "Acme",
    });
    expect(out.find((p) => p.passageId === x2)?.via).toBeUndefined(); // a seed keeps its own score
    expect(calls.links).toHaveLength(1);
    expect(calls.links[0]).toEqual({ ids: [x1, x2, y1], opts: { perChunk: 4 } });
  });

  it("follows a second hop only from hop-1 passages that scored well", async () => {
    const { retriever, ready, calls } = build({ hops: 2 });
    await ready;
    const out = await retriever.search(SCOPE, "all", "q", 12);
    // h1: 0.5 x (0.9 x 1 x 0.85) + 0.5 x 0.18 = 0.4725 (>= 0.45); z1: 0.5 x (1 x 0.9 x 0.85) + 0.5 x 0.1 = 0.4325
    expect(calls.links.map((c) => c.ids)).toEqual([[x1, x2, y1], [h1]]);
    expect(out.find((p) => p.passageId === h2)?.via).toEqual({ kind: "reference", from: h1 });
  });

  it("limits the seeds and every hop target to the chat's documents", async () => {
    const { retriever, ready, calls } = build({ hops: 2 });
    await ready;
    const out = await retriever.search(SCOPE, { documentIds: ["X"] }, "q", 12);
    expect(ids(out).sort()).toEqual([x1, x2]);
    expect(calls.links.every((c) => JSON.stringify(c.opts.documentIds) === '["X"]')).toBe(true);
  });

  it("clamps k to 1..12 and reads passages with the caller's scope", async () => {
    const { retriever, ready, calls } = build({ hops: 1 });
    await ready;
    expect(await retriever.search(SCOPE, "all", "q", 1)).toHaveLength(1);
    expect(await retriever.search(SCOPE, "all", "q", 0)).toHaveLength(1);
    expect((await retriever.search(SCOPE, "all", "q", 50)).length).toBeLessThanOrEqual(12);
    expect((await retriever.search(SCOPE, "all", "q", Number.NaN)).length).toBeGreaterThan(0);
    expect(calls.read.every((s) => s === SCOPE)).toBe(true);
  });

  it("drops a passage that disappeared between the search and the read", async () => {
    const { retriever, ready } = build({ hops: 0, missing: [x2] });
    await ready;
    expect(ids(await retriever.search(SCOPE, "all", "q", 8))).toEqual([x1, y1]);
  });

  it("answers [] without following links when nothing clears the similarity floor", async () => {
    const { retriever, ready, calls } = build({
      hops: 2,
      embed: async (t) => t.map(() => [0, 0, 0, -1]),
    });
    await ready;
    expect(await retriever.search(SCOPE, "all", "q", 8)).toEqual([]);
    expect(calls.links).toEqual([]);
  });

  it("maps an unavailable embedder to SearchUnavailableError, and searches nothing", async () => {
    const { retriever, ready, calls } = build({
      embed: async () => {
        throw new EmbeddingUnavailableError();
      },
    });
    await ready;
    const err = await retriever.search(SCOPE, "all", "q", 8).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchUnavailableError);
    expect((err as Error).message).toBe("search is unavailable");
    expect(calls.search).toBe(0);
  });

  it("lets an abort pass through as the embedder's own error, and any other failure as it is", async () => {
    const aborted = build({
      embed: async () => {
        throw new EmbeddingAbortedError();
      },
    });
    await aborted.ready;
    const err = await aborted.retriever.search(SCOPE, "all", "q", 8).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingAbortedError);
    expect(err).not.toBeInstanceOf(SearchUnavailableError);
    const boom = new TypeError("boom");
    const other = build({ embed: async () => Promise.reject(boom) });
    await other.ready;
    await expect(other.retriever.search(SCOPE, "all", "q", 8)).rejects.toBe(boom);
  });
});

describe("Retriever.search hop failure", () => {
  it("degrades to the seeds when the link read fails, and does not fail the search", async () => {
    const { retriever, ready } = build({ hops: 1, linksFail: true });
    await ready;
    expect(ids(await retriever.search(SCOPE, "all", "q", 8))).toEqual([x1, x2, y1]);
  });
});

describe("Retriever.related", () => {
  it("returns the passage's strongest links, one per target, with the link that led there", async () => {
    const { retriever, ready, calls } = build();
    await ready;
    const out = await retriever.related(SCOPE, "all", x1);
    expect(ids(out)).toEqual([z1, x2]); // by weight: 0.9, then x2's best of 0.8 (not the 0.5 structure link)
    expect(out[0]?.via).toEqual({ kind: "entity", from: x1, entity: "Acme" });
    expect(out[1]?.via).toEqual({ kind: "similar", from: x1 });
    expect(calls.links[0]?.opts).toEqual({ perChunk: 8 });
  });

  it("passes kinds and the chat's documents to the link read", async () => {
    const { retriever, ready, calls } = build();
    await ready;
    expect(
      ids(await retriever.related(SCOPE, { documentIds: ["X", "Z"] }, x1, ["structure"])),
    ).toEqual([x2]);
    expect(calls.links[0]?.opts).toEqual({
      perChunk: 8,
      kinds: ["structure"],
      documentIds: ["X", "Z"],
    });
  });

  it("answers [] for a passage outside the chat's scope, an unknown one and a malformed id, reading no links", async () => {
    const { retriever, ready, calls } = build();
    await ready;
    expect(await retriever.related(SCOPE, { documentIds: ["Y"] }, x1)).toEqual([]);
    expect(await retriever.related(SCOPE, "all", "nope")).toEqual([]);
    expect(await retriever.related(SCOPE, "all", uuid(99))).toEqual([]);
    expect(calls.links).toEqual([]);
  });
});
