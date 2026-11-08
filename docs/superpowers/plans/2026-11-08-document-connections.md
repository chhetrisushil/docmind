# Document Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, on a document's Visuals tab, which other documents in the owner's library are related to it and which people, organisations and products they share, as live data the planner binds once.

**Architecture:** A new provider `doc.connections` (pin `docmind:doc.connections@1`) is read at hydrate time by one owner-scoped Postgres query over `chunk_links`, `chunk_entities`, `entities`, `chunks` and `documents`; its args come only from the server-held view. Two new catalogue entries, `RelatedDocuments` (Table with an "Open" row action) and `ConnectionMap` (Diagram, network layout), are bound by the document planner to an always-offered `connections` capability, so another document's ingest or deletion needs no re-plan. Existing visualized documents are re-planned once at the next boot (NULL fact-format counts as stale for this release, through a new migration 0032 that replaces the stale-format definer).

**Tech Stack:** TypeScript, Node, Postgres (RLS, `withTenant`, SECURITY DEFINER functions), Vitest, loom-ui (pinned 9bcf82b: `@loom-ui/core` Diagram and Table contracts, `@loom-ui/renderer-lit/diagram`), Lit web app, pnpm + turbo, Biome.

**Spec:** `docs/specs/2026-11-08-document-connections-design.md` (binding). Background: `docs/specs/2026-11-08-document-visuals-design.md`, `docs/superpowers/plans/2026-11-08-document-visuals.md`.

## Global Constraints

Copied from the spec; every task's requirements include them.

- Connections only; comparing figures across documents is out of scope (K1). Chat-turn visuals do not offer connections (K7).
- Live binding (K2): the planner binds provider `doc.connections` once; another document's ingest or deletion needs no re-run, no model call and no change signal.
- Built from existing data only: `chunk_links`, `chunk_entities`, `entities`, `chunks`, `documents`. No extraction, no new stored data (K3).
- Tool `doc.connections`, pin `docmind:doc.connections@1`. Args `{ documentId }`, from the server-held view, never from a pin or the client. Served under the owner's `sensitive` clearance (R27).
- One owner-scoped query (tenant via `withTenant`, `documents.owner_id = <caller>`), counting only ready, non-deleted documents.
- `related`: up to 8 other documents with chunk links to this one, grouped per document as `{ documentId, title, kinds: { entity, reference, similar } counts, strength }`, strength = the maximum link weight, ordered by strength, then link count, then document id.
- `entities`: up to 12 entities this document shares with other documents, rarest first, as `{ entityId, name, kind, documents: [{ documentId, title }] }` with up to 5 documents per entity, by title.
- Titles and entity names are decrypted with the owner's key (`fields.forUser`). An entity whose name does not open is dropped; a document gone since the query is absent.
- Performance: uses `chunks.document_id`, `chunk_entities.entity_id` and the `chunk_links` source index; verified with `EXPLAIN` on a seeded library of about 500 documents.
- Two catalogue entries: `RelatedDocuments` (Table) and `ConnectionMap` (Diagram, network layout). The planner chooses table, map, both or neither (K4).
- `RelatedDocuments` columns: Document, Why, Strength. "Why" is built from the kinds and the top shared entity names (e.g. "shares Acme Corp, Jane Doe", "similar content", "referenced"). Each row carries a row key and an "Open" row action (`TABLE_ROW_ACTION`); the web answers it by navigating to `/documents/<id>`, owner-checked by the existing routes. Empty: caption "No connected documents yet".
- `ConnectionMap` nodes: this document (`group: "self"`), related documents (`group: "document"`), shared entities (`group: "entity"`, `kind`: the entity kind). Edges: document -> entity for each shared entity, and self -> document for a reference or similar link, labelled with the kind. At most 21 nodes. Ids prefixed `doc:` / `ent:`, unique, and the value passes loom-ui's `diagramProblems`. Empty: a single self node.
- Both values carry no fact refs (they cite no passages). The reshapers never throw on empty data.
- The web registers `@loom-ui/renderer-lit/diagram`, covered by the element-registration test.
- The capability is always offered and the widgets show an empty state (K5). `visualize-document` always adds the connections capability (handle `connections`, one per document) next to the fact capabilities.
- `VISUALS_INTENT` gains one sentence: connections are live and may grow; include a compact Connections section when the document has, or is likely to gain, related material.
- `factFormatFingerprint()` includes the connections pin. For this release, the boot stale pass treats done runs with a NULL format as stale (K6): each visualized document is re-planned once over its stored facts (no extraction), one planner call each, at most 2 at a time, then stamped so it runs once.
- Errors: a failed connections query gives that widget its own error state; the other widgets render.
- Privacy: owner-scoped query and routes; names are decrypted only into rendered values, never logs or the event log; no new stored data.

Repo-wide: never edit a merged migration (0030 is merged; new SQL goes in 0032). No emojis. Use real names from the code. Conventional commits (`feat(visuals): ...`). Every commit ends with the two trailer lines shown in each commit step.

**Verification commands** (from the worktree root `/Users/such/workspace/docmind/.worktrees/connections`): `pnpm typecheck`, `pnpm typecheck:tests`, `pnpm lint` (`pnpm lint:fix` repairs formatting), `pnpm build`, and per-package suites. Postgres tests need the env: `set -a; . ./.env; set +a` first. A skipped pg test is not a pass: the output must show the tests ran. `@docmind/experiences` and `@docmind/contracts` are consumed from `dist` by the server and web, so run `pnpm --filter @docmind/experiences build` (and `@docmind/contracts` when changed) before their suites.

## Plan decisions (read first)

These are the places where the code forced a choice the spec leaves open. Each is repeated at the task that applies it.

1. **Task order differs from the suggested one.** The web diagram registration (Task 3) lands before the catalogue entries (Task 4) because `apps/web/src/ui/elements.test.ts` iterates `mergedCatalog()` and fails the moment a `Diagram` kind exists without a registered `lu-diagram` and a known tag. The Open row action (Task 6) lands after the catalogue because it reads the served `connections-table` value. Provider, reader and clearance (Task 2) land before the catalogue so hydration is testable end to end in Task 4.
2. **"Ready" is read from the status read model, not `documents.status`.** The `documents.status` column is vestigial (no code updates it; the DTO status comes from `read_model_state` through `IngestStatus`). The query therefore joins `read_model_state` with the same `execution_id` rule as migration 0028 (`status = 'ready'` for the document's current generation). The app role may `SELECT` it under the `tenant_read` policy, so this needs no definer.
3. **`RawConnections` carries `documentId`** (the server's own id) so the map can build the self node id `doc:<documentId>` without a title. Not a decrypted value.
4. **Documents without a readable title are dropped** (as entities whose names do not open): the spec only names entities, but a row cannot be labelled without a title.
5. **"Up to 5 documents per entity, by title"**: titles are sealed, so SQL cannot sort by them. SQL keeps the 5 newest documents per entity (`created_at DESC, id`), and the reader lists those 5 by decrypted title.
6. **Empty Table state is one placeholder row**, `["No connected documents yet", "", ""]`, with no `rowKeys`/`rowActions`. loom-ui's Table value has no caption field (its `<caption>` is screen-reader-only and comes from the node title), so a zero-row table would show nothing visible. This refines the spec's "zero rows with the caption".
7. **Entities with no listed related document still appear on the map**, attached to self: self -> entity edges exist for every shared entity, and document -> entity edges only to documents that are nodes.
8. **`VISUALS_INTENT`'s last sentence is rewritten, not just extended**: the existing "Every widget binds one fact." would contradict connections widgets, so the one new sentence reads "Every widget binds one fact, except RelatedDocuments and ConnectionMap, which bind the live connections capability: ...".
9. **Migration 0032 is required** (spec K3 says "no migration" about data; K6's NULL-stale rule changes the `docmind_visual_stale_format_documents` definer from migration 0030). 0032 is `CREATE OR REPLACE FUNCTION` with the identical signature, changing `r.format IS NOT NULL AND r.format <> p_format` to `r.format IS DISTINCT FROM p_format`. It stays in place after this release; a later release reverts the rule with a 0033.
10. **`intentOf("detail")` gains a `TABLE_ROW_ACTION` branch** (action `open` only, row key matched against the served `connections-table` row keys). Today the detail view refuses row actions and a contracts test asserts that, so the test changes.
11. **Handles on the document page are `connections-table` and `connections-map`**, one provider per entry, generated by `detailWithVisuals` from the planner's `connections` binding (as `fact-<n>` providers are), with `overridable: []`.

## File Structure

Create:
- `apps/server/app/ui/connections.ts`: the owner-scoped query and decryption (`readConnections`).
- `apps/server/app/ui/connections.pg.test.ts`: Postgres tests plus the 500-document `EXPLAIN` check.
- `packages/experiences/src/connections.ts`: the connections contract (handle, entries, capability, provider, pin check, clip).
- `packages/experiences/src/connections.test.ts`: contract and invoker tests.
- `packages/experiences/src/connectionShapes.ts`: the two reshapers.
- `packages/experiences/src/connectionShapes.test.ts`: reshaper tests.
- `packages/experiences/src/connectionsView.test.ts`: adoption, compile and hydrate tests.
- `infra/migrations/0032_stale_format_null.sql`: the stale-format definer replacement.

Modify:
- `packages/experiences/src/{providers,invoker,visuals,views,reshapers,index}.ts`, `packages/experiences/src/{visuals,providers,hydrate}.test.ts`.
- `apps/server/app/ui/readers.ts`, `readers.test.ts`, `visuals.e2e.test.ts`.
- `apps/server/app/flows/visualize-document/{plan,start,runs}.ts`, `plan.test.ts`, `runs.pg.test.ts`.
- `apps/server/app/documents/visuals.e2e.pg.test.ts`.
- `packages/contracts/src/{intents,intents.test}.ts`.
- `apps/web/src/ui/{session,elements.test}.ts`, `apps/web/src/components/dm-doc-detail.ts`, `dm-doc-detail.test.ts`, `apps/web/src/testing/fakeUi.ts` and any test that builds a full `UiReaders`.
- `docs/architecture.md`, `docs/codebase-guide.md`, `docs/operations/cloud-deploy.md`.

---

### Task 1: The connections query (server, owner-scoped)

**Files:**
- Modify: `packages/experiences/src/providers.ts` (add `CONNECTIONS_CAPS`)
- Modify: `packages/experiences/src/invoker.ts` (add the `RawConnections` types only)
- Modify: `packages/experiences/src/index.ts` (export the types)
- Create: `apps/server/app/ui/connections.ts`
- Test: `apps/server/app/ui/connections.pg.test.ts`

**Interfaces:**
- Consumes: `withTenant(pool, tenantId, fn)` (`apps/server/app/db/tenant.ts`); `FieldCrypto.forUser(userId).openText(bind, envelope)`; `titleBind(id)` (`documents/repo.ts`); `entityNameBind(entityId)` (`flows/ingest-document/pgEntities.ts`); `Uuid` (`@docmind/contracts`).
- Produces:
  - `export const CONNECTIONS_CAPS = { related: 8, entities: 12, entityDocuments: 5 } as const` (`@docmind/experiences`, `providers.ts`).
  - `export interface ConnectionDocument { documentId: string; title: string }` and `export interface RawConnections { documentId: string; related: { documentId: string; title: string; kinds: { entity: number; reference: number; similar: number }; strength: number }[]; entities: { entityId: string; name: string; kind: string; documents: ConnectionDocument[] }[] }` (`@docmind/experiences`, `invoker.ts`).
  - `export interface ConnectionsDeps { pool: Pool; fields: FieldCrypto }`.
  - `export async function readConnections(deps: ConnectionsDeps, who: { tenantId: string; userId: string }, documentId: string): Promise<RawConnections | null>` (null: malformed id, or not the caller's document).
  - `export const SELF_SQL`, `RELATED_SQL`, `ENTITIES_SQL` (strings, used by the EXPLAIN test).

- [ ] **Step 1: Add the caps and the raw types**

In `packages/experiences/src/providers.ts`, after `export const CONTENT_CAP = 200;` add:

```ts
/** What one connections read returns at most: related documents, shared entities, and documents named per entity. */
export const CONNECTIONS_CAPS = { related: 8, entities: 12, entityDocuments: 5 } as const;
```

In `packages/experiences/src/invoker.ts`, after the `RawContent` interface add:

```ts
export interface ConnectionDocument {
  documentId: string;
  title: string;
}
/**
 * What `doc.connections` reads for one document of the caller's library (live: no stored copy). Titles and entity names are
 * decrypted for the owner and are content: they reach only a rendered value, never a log. `documentId` is the document asked about.
 */
export interface RawConnections {
  documentId: string;
  related: {
    documentId: string;
    title: string;
    kinds: { entity: number; reference: number; similar: number };
    /** The maximum link weight between this document's passages and that one's (0..1). */
    strength: number;
  }[];
  entities: {
    entityId: string;
    name: string;
    kind: string;
    documents: ConnectionDocument[];
  }[];
}
```

In `packages/experiences/src/index.ts` replace
`export type { RawContent, RawDocuments, SourceResult, UiReaders } from "./invoker";`
with
`export type {\n  ConnectionDocument,\n  RawConnections,\n  RawContent,\n  RawDocuments,\n  SourceResult,\n  UiReaders,\n} from "./invoker";`

- [ ] **Step 2: Write the failing Postgres tests**

Create `apps/server/app/ui/connections.pg.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { ingestExecutionId } from "../documents/ingest";
import { insertDocument, titleBind } from "../documents/repo";
import { T1, T2, U1, U1B, U2, newDocument, seedRow } from "../documents/testHarness";
import { chunkIdFor } from "../flows/ingest-document/chunker";
import { entityNameBind } from "../flows/ingest-document/pgEntities";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import type { LinkKind } from "../flows/ingest-document/pgLinks";
import { ENTITIES_SQL, RELATED_SQL, SELF_SQL, readConnections } from "./connections";

const READY = '{"status":"ready","step":"finalize","code":null}';
const A1 = { tenantId: T1, userId: U1 };

describe.skipIf(!PG_URL)("readConnections (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  const ids = new Map<string, string>();
  const id = (name: string) => ids.get(name) as string;
  const ch = (name: string, ordinal: number) => chunkIdFor(id(name), ordinal);
  const read = (name: string, who = A1) =>
    readConnections({ pool: fx.app, fields: fx.fields }, who, id(name));

  /** A document of `who` with `chunks` chunks; ready unless `ready: false`. The title is the name unless given. */
  async function seed(
    name: string,
    opts: {
      who?: { tenantId: string; userId: string };
      chunks?: number;
      ready?: boolean;
      title?: string;
      titleKey?: string;
    } = {},
  ) {
    const who = opts.who ?? A1;
    const d = await newDocument(
      fx.fields,
      who.tenantId,
      who.userId,
      (ids.size + 1).toString(16).padStart(64, "0"),
    );
    const titleEnc = await fx.fields
      .forUser(opts.titleKey ?? who.userId)
      .seal(titleBind(d.id), opts.title ?? name);
    await withTenant(fx.app, who.tenantId, (tx) => insertDocument(tx, { ...d, titleEnc }));
    ids.set(name, d.id);
    for (let i = 0; i < (opts.chunks ?? 2); i++) {
      await fx.db.owner.query(
        `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
         VALUES ($1, $2, $3, $4, 0, '{"x":1}', '{"kind":"section","index":0}', 1)`,
        [chunkIdFor(d.id, i), who.tenantId, d.id, i],
      );
    }
    if (opts.ready !== false)
      await seedRow(
        fx.db.owner,
        ingestExecutionId(who.userId, d.id, 2),
        d.id,
        who.userId,
        READY,
      );
  }
  /** Both directions, as the link store writes them. */
  const link = async (a: string, b: string, weight: number, kind: LinkKind = "similar") => {
    for (const [s, d] of [
      [a, b],
      [b, a],
    ] as const)
      await fx.db.owner.query(
        "INSERT INTO chunk_links (tenant_id, src_chunk_id, dst_chunk_id, kind, weight) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
        [T1, s, d, kind, weight],
      );
  };
  const entity = async (
    name: string,
    chunks: string[],
    opts: { user?: string; sealedBy?: string; kind?: string } = {},
  ) => {
    const entityId = randomUUID();
    const owner = opts.user ?? U1;
    await fx.db.owner.query(
      "INSERT INTO entities (id, tenant_id, owner_id, kind, name_enc, name_key) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
      [
        entityId,
        T1,
        owner,
        opts.kind ?? "organization",
        JSON.stringify(
          await fx.fields.forUser(opts.sealedBy ?? owner).seal(entityNameBind(entityId), name),
        ),
        randomUUID().replaceAll("-", "").repeat(2),
      ],
    );
    for (const c of chunks)
      await fx.db.owner.query(
        "INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id) VALUES ($1, $2, $3)",
        [T1, c, entityId],
      );
    return entityId;
  };

  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });
  beforeEach(async () => {
    await fx.db.owner.query("DELETE FROM documents"); // chunks, links and chunk_entities cascade
    await fx.db.owner.query("DELETE FROM entities");
    await fx.db.owner.query("DELETE FROM read_model_state");
    ids.clear();
  });

  it("groups links per related document with kind counts and the strongest weight, ordered by strength, link count, id", async () => {
    for (const n of ["a", "b", "c", "d", "e"]) await seed(n, { chunks: 3 });
    await link(ch("a", 0), ch("b", 0), 0.5, "similar");
    await link(ch("a", 1), ch("b", 1), 0.9, "reference");
    await link(ch("a", 2), ch("b", 2), 0.5, "similar");
    await link(ch("a", 0), ch("c", 0), 0.7, "similar");
    await link(ch("a", 0), ch("d", 0), 0.7, "entity");
    await link(ch("a", 1), ch("d", 1), 0.7, "entity");
    await link(ch("a", 0), ch("e", 0), 0.99, "structure"); // never a connection
    const got = await read("a");
    expect(got?.documentId).toBe(id("a"));
    expect(got?.related.map((r) => r.documentId)).toEqual([id("b"), id("d"), id("c")]);
    expect(got?.related[0]).toMatchObject({
      title: "b",
      kinds: { entity: 0, reference: 1, similar: 2 },
    });
    expect(got?.related[0]?.strength).toBeCloseTo(0.9, 5);
    expect(got?.related[1]?.kinds).toEqual({ entity: 2, reference: 0, similar: 0 });
    expect(got?.entities).toEqual([]);
  });

  it("breaks a tie of strength and link count by document id", async () => {
    for (const n of ["a", "b", "c"]) await seed(n);
    await link(ch("a", 0), ch("b", 0), 0.6);
    await link(ch("a", 1), ch("c", 0), 0.6);
    const got = await read("a");
    expect(got?.related.map((r) => r.documentId)).toEqual([id("b"), id("c")].sort());
  });

  it("counts only the caller's ready, live documents, and never the document itself", async () => {
    await seed("a");
    await seed("b");
    await seed("notReady", { ready: false });
    await seed("theirs", { who: { tenantId: T1, userId: U1B } });
    await link(ch("a", 0), ch("a", 1), 0.9); // within the document
    await link(ch("a", 0), ch("notReady", 0), 0.9);
    await link(ch("a", 0), ch("theirs", 0), 0.9); // another user of the same tenant
    await link(ch("a", 1), ch("b", 0), 0.1);
    expect((await read("a"))?.related.map((r) => r.documentId)).toEqual([id("b")]);
    await fx.db.owner.query("DELETE FROM documents WHERE id = $1", [id("b")]);
    expect((await read("a"))?.related).toEqual([]);
  });

  it("returns at most 8 related documents, the strongest", async () => {
    await seed("a", { chunks: 1 });
    for (let i = 0; i < 10; i++) {
      await seed(`r${i}`, { chunks: 1 });
      await link(ch("a", 0), ch(`r${i}`, 0), (i + 1) / 20);
    }
    const got = await read("a");
    expect(got?.related).toHaveLength(8);
    expect(got?.related.map((r) => r.title)).toEqual(
      ["r9", "r8", "r7", "r6", "r5", "r4", "r3", "r2"],
    );
  });

  it("lists the entities this document shares, rarest first, with their documents by title", async () => {
    for (const n of ["a", "b", "c", "d", "e"]) await seed(n);
    const acme = await entity("Acme Corp", [ch("a", 0), ch("b", 0)], { kind: "organization" });
    const jane = await entity("Jane Doe", [ch("a", 1), ch("e", 1), ch("c", 1), ch("d", 1)], {
      kind: "person",
    });
    await entity("Solo", [ch("a", 0)]); // not shared with any other document
    await entity("Elsewhere", [ch("b", 1), ch("c", 0)]); // not in this document
    const got = await read("a");
    expect(got?.entities).toEqual([
      {
        entityId: acme,
        name: "Acme Corp",
        kind: "organization",
        documents: [{ documentId: id("b"), title: "b" }],
      },
      {
        entityId: jane,
        name: "Jane Doe",
        kind: "person",
        documents: [
          { documentId: id("c"), title: "c" },
          { documentId: id("d"), title: "d" },
          { documentId: id("e"), title: "e" },
        ],
      },
    ]);
  });

  it("caps entities at 12 and the documents named per entity at 5, and skips not-ready and foreign documents", async () => {
    await seed("a", { chunks: 1 });
    await seed("b", { chunks: 1 });
    for (let i = 0; i < 14; i++) await entity(`E${i}`, [ch("a", 0), ch("b", 0)]);
    const many = await entity("Many", [ch("a", 0)]);
    for (let i = 0; i < 7; i++) {
      await seed(`m${i}`, { chunks: 1 });
      await fx.db.owner.query(
        "INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id) VALUES ($1, $2, $3)",
        [T1, ch(`m${i}`, 0), many],
      );
    }
    await seed("notReady", { chunks: 1, ready: false });
    await seed("theirs", { chunks: 1, who: { tenantId: T1, userId: U1B } });
    const spread = await entity("Spread", [ch("a", 0), ch("notReady", 0), ch("theirs", 0)]);
    const got = await read("a");
    expect(got?.entities).toHaveLength(12);
    expect(got?.entities.some((e) => e.entityId === spread)).toBe(false); // no ready document of the owner shares it
    // the 14 two-document entities are rarer than "Many"; with 12 slots "Many" does not appear
    expect(got?.entities.every((e) => e.documents.length === 1)).toBe(true);
    await fx.db.owner.query("DELETE FROM entities WHERE id <> $1", [many]);
    const only = await read("a");
    expect(only?.entities).toHaveLength(1);
    expect(only?.entities[0]?.documents).toHaveLength(5);
    const titles = only?.entities[0]?.documents.map((d) => d.title) ?? [];
    expect(titles).toEqual([...titles].sort());
  });

  it("drops an entity whose name does not open, and a document whose title does not open", async () => {
    await seed("a");
    await seed("b");
    await seed("sealedElsewhere", { titleKey: U1B });
    const good = await entity("Acme Corp", [ch("a", 0), ch("b", 0)]);
    await entity("Unreadable", [ch("a", 1), ch("b", 1)], { sealedBy: U1B }); // owned by U1, sealed under another key
    await link(ch("a", 0), ch("sealedElsewhere", 0), 0.9);
    await link(ch("a", 1), ch("b", 0), 0.2);
    const got = await read("a");
    expect(got?.entities.map((e) => e.entityId)).toEqual([good]);
    expect(got?.related.map((r) => r.documentId)).toEqual([id("b")]);
  });

  it("is owner-scoped: another user, another tenant, a malformed id and an unknown id read nothing", async () => {
    await seed("a");
    const deps = { pool: fx.app, fields: fx.fields };
    expect(await read("a", { tenantId: T1, userId: U1B })).toBeNull();
    expect(await read("a", { tenantId: T2, userId: U2 })).toBeNull();
    expect(await readConnections(deps, A1, "not-a-uuid")).toBeNull();
    expect(await readConnections(deps, A1, randomUUID())).toBeNull();
    expect(await read("a")).toEqual({ documentId: id("a"), related: [], entities: [] });
    expect(await readConnections(deps, A1, id("a").toUpperCase())).toMatchObject({
      documentId: id("a"),
    });
  });

  it("never reads an entity of another user, even one linked to this owner's chunks", async () => {
    await seed("a");
    await seed("b");
    await entity("Theirs", [ch("a", 0), ch("b", 0)], { user: U1B });
    expect((await read("a"))?.entities).toEqual([]);
  });
});

describe.skipIf(!PG_URL)("the connections queries on about 500 documents (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let selfId: string;

  beforeAll(async () => {
    fx = await startPgFixture();
    const c = await fx.db.owner.connect();
    try {
      await c.query(
        `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint)
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, '{"x":1}'::jsonb, '{"x":1}'::jsonb, 'text/plain', 1,
                'hmac-sha256:' || lpad(to_hex(g), 64, '0'), lpad(to_hex(g), 64, '0')
           FROM generate_series(1, 500) g`,
        [T1, U1],
      );
      await c.query(
        `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
         SELECT gen_random_uuid(), d.tenant_id, d.id, o, 0, '{"x":1}'::jsonb, '{"kind":"section","index":0}'::jsonb, 1
           FROM documents d CROSS JOIN generate_series(0, 3) o`,
      );
      await c.query(
        `INSERT INTO entities (id, tenant_id, owner_id, kind, name_enc, name_key)
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'organization', '{"x":1}'::jsonb, lpad(to_hex(g), 64, '0')
           FROM generate_series(1, 200) g`,
        [T1, U1],
      );
      await c.query(`CREATE TEMP TABLE seed_chunks AS
        SELECT tenant_id, id, row_number() OVER (ORDER BY id) AS rn FROM chunks`);
      await c.query(`CREATE TEMP TABLE seed_entities AS
        SELECT id, row_number() OVER (ORDER BY id) AS rn FROM entities`);
      await c.query(`INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id)
        SELECT c.tenant_id, c.id, e.id FROM seed_chunks c JOIN seed_entities e ON e.rn = (c.rn % 200) + 1`);
      await c.query(`INSERT INTO chunk_links (tenant_id, src_chunk_id, dst_chunk_id, kind, weight)
        SELECT a.tenant_id, a.id, b.id, 'similar', 0.5
          FROM seed_chunks a CROSS JOIN generate_series(1, 6) AS k(n)
          JOIN seed_chunks b ON b.rn = ((a.rn * 7 + k.n * 131) % 2000) + 1 AND b.id <> a.id
        ON CONFLICT DO NOTHING`);
      await c.query(
        `INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state)
         SELECT 'ingest-status', 'u_' || d.owner_id::text || ':ingest-' || d.id::text || '.' || d.ingest_generation::text,
                d.id::text, d.owner_id::text, 0, '{"status":"ready"}'::jsonb
           FROM documents d`,
      );
      await c.query("ANALYZE");
    } finally {
      c.release();
    }
    selfId = (await fx.db.owner.query("SELECT id FROM documents ORDER BY id LIMIT 1")).rows[0].id;
  }, 120_000);
  afterAll(async () => {
    await fx?.close();
  });

  type PlanNode = { "Node Type": string; "Relation Name"?: string; Plans?: PlanNode[] };
  const walk = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(walk)];
  /** Plans (and runs) `sql` as the app role with sequential scans off: a Seq Scan left in the plan has no index to use. */
  async function explain(sql: string, params: unknown[]) {
    return withTenant(fx.app, T1, async (tx) => {
      await tx.query("SET LOCAL enable_seqscan = off");
      // Literals, so the planner sees the values; every parameter is a uuid or a small integer.
      const inline = sql.replace(/\$(\d+)/g, (_m, n) => `'${params[Number(n) - 1]}'`);
      const res = await tx.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${inline}`);
      const top = res.rows[0]["QUERY PLAN"][0];
      return { nodes: walk(top.Plan as PlanNode), ms: Number(top["Execution Time"]) };
    });
  }
  const BIG = ["chunks", "chunk_links", "chunk_entities", "documents", "entities"];

  it.each([
    ["related", RELATED_SQL, [U1, 8]],
    ["entities", ENTITIES_SQL, [U1, 12, 5]],
  ] as const)("the %s query reaches every large table through an index, in well under a second", async (_n, sql, rest) => {
    const params = [rest[0], selfId, ...rest.slice(1)];
    const { nodes, ms } = await explain(sql, params);
    const seq = nodes
      .filter((n) => n["Node Type"] === "Seq Scan")
      .map((n) => n["Relation Name"]);
    expect(seq.filter((r) => r !== undefined && BIG.includes(r))).toEqual([]);
    expect(ms).toBeLessThan(2000);
  });

  it("the self check is a primary-key lookup", async () => {
    const { nodes } = await explain(SELF_SQL, [U1, selfId]);
    expect(nodes.some((n) => n["Node Type"] === "Seq Scan")).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (worktree root): `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/ui/connections.pg.test.ts`
Expected: FAIL, `Failed to resolve import "./connections"` (the module does not exist). Confirm the suite is not reported as skipped.

- [ ] **Step 4: Write the query module**

Create `apps/server/app/ui/connections.ts`:

```ts
import { Uuid } from "@docmind/contracts";
import { CONNECTIONS_CAPS, type ConnectionDocument, type RawConnections } from "@docmind/experiences";
import type { Pool } from "pg";
import type { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { titleBind } from "../documents/repo";
import { entityNameBind } from "../flows/ingest-document/pgEntities";

export interface ConnectionsDeps {
  pool: Pool;
  fields: FieldCrypto;
}

/**
 * "Ready" is what the status read model says (`documents.status` is not maintained): the same rule as `docmind_ready_documents`
 * (migration 0028), through the app role's tenant-scoped `SELECT` on `read_model_state`.
 */
const readyOf = (d: string): string => `EXISTS (
    SELECT 1 FROM read_model_state s
     WHERE s.model_id = 'ingest-status' AND NOT s.erased AND s.state ->> 'status' = 'ready'
       AND s.execution_id = 'u_' || ${d}.owner_id::text || ':ingest-' || ${d}.id::text
           || CASE WHEN ${d}.ingest_generation = 1 THEN '' ELSE '.' || ${d}.ingest_generation::text END)`;

/** $1 owner, $2 document. */
export const SELF_SQL = "SELECT 1 FROM documents WHERE id = $2 AND owner_id = $1";

/**
 * $1 owner, $2 document, $3 limit. Related documents: links out of THIS document's chunks (the `chunk_links` primary key
 * leads with the source chunk), to chunks of other ready documents of the same owner, grouped per document.
 * `structure` links stay inside a document and are never a connection.
 */
export const RELATED_SQL = `SELECT dd.id AS document_id, dd.title_enc,
       (count(*) FILTER (WHERE l.kind = 'entity'))::int AS entity,
       (count(*) FILTER (WHERE l.kind = 'reference'))::int AS reference,
       (count(*) FILTER (WHERE l.kind = 'similar'))::int AS similar,
       max(l.weight) AS strength
  FROM documents me
  JOIN chunks mc ON mc.tenant_id = me.tenant_id AND mc.document_id = me.id
  JOIN chunk_links l ON l.tenant_id = mc.tenant_id AND l.src_chunk_id = mc.id
                    AND l.kind IN ('entity', 'reference', 'similar')
  JOIN chunks dc ON dc.tenant_id = l.tenant_id AND dc.id = l.dst_chunk_id AND dc.document_id <> me.id
  JOIN documents dd ON dd.tenant_id = dc.tenant_id AND dd.id = dc.document_id AND dd.owner_id = $1
 WHERE me.id = $2 AND me.owner_id = $1
   AND ${readyOf("dd")}
 GROUP BY dd.id
 ORDER BY max(l.weight) DESC, count(*) DESC, dd.id
 LIMIT $3`;

/**
 * $1 owner, $2 document, $3 entity limit, $4 documents per entity. The entities of this document's chunks
 * (`chunks_document_ordinal_key`, then the `chunk_entities` primary key) that also occur in chunks of other ready documents
 * (`chunk_entities_entity_idx`); the rarest (fewest other documents) first. Titles are sealed, so SQL keeps the newest
 * documents per entity and the reader orders them by title.
 */
export const ENTITIES_SQL = `WITH mine AS (
  SELECT DISTINCT ce.entity_id
    FROM documents me
    JOIN chunks mc ON mc.tenant_id = me.tenant_id AND mc.document_id = me.id
    JOIN chunk_entities ce ON ce.tenant_id = mc.tenant_id AND ce.chunk_id = mc.id
   WHERE me.id = $2 AND me.owner_id = $1),
shared AS (
  SELECT m.entity_id, dd.id AS document_id, dd.title_enc, dd.created_at
    FROM mine m
    JOIN entities en ON en.id = m.entity_id AND en.owner_id = $1
    JOIN chunk_entities oe ON oe.tenant_id = en.tenant_id AND oe.entity_id = en.id
    JOIN chunks oc ON oc.tenant_id = oe.tenant_id AND oc.id = oe.chunk_id AND oc.document_id <> $2
    JOIN documents dd ON dd.tenant_id = oc.tenant_id AND dd.id = oc.document_id AND dd.owner_id = $1
   WHERE ${readyOf("dd")}
   GROUP BY m.entity_id, dd.id),
rarest AS (
  SELECT entity_id, count(*) AS n FROM shared GROUP BY entity_id ORDER BY count(*), entity_id LIMIT $3),
picked AS (
  SELECT s.entity_id, s.document_id, s.title_enc, r.n,
         row_number() OVER (PARTITION BY s.entity_id ORDER BY s.created_at DESC, s.document_id) AS rank
    FROM shared s JOIN rarest r ON r.entity_id = s.entity_id)
SELECT p.entity_id, p.document_id, p.title_enc, en.kind, en.name_enc
  FROM picked p JOIN entities en ON en.id = p.entity_id
 WHERE p.rank <= $4
 ORDER BY p.n, p.entity_id, p.rank`;

interface RelatedRow {
  document_id: string;
  title_enc: unknown;
  entity: number;
  reference: number;
  similar: number;
  strength: number;
}
interface EntityRow {
  entity_id: string;
  document_id: string;
  title_enc: unknown;
  kind: string;
  name_enc: unknown;
}

const byTitle = (a: ConnectionDocument, b: ConnectionDocument): number =>
  a.title < b.title ? -1 : a.title > b.title ? 1 : a.documentId < b.documentId ? -1 : 1;

/**
 * The owner's connections for one document: related documents and shared entities, both read in one tenant transaction (one
 * snapshot), counting only the owner's ready, live documents. Null when `documentId` is malformed or not the caller's document
 * (the route answers both alike). Decryption failures drop the entity or document (never logged: a name is content).
 */
export async function readConnections(
  deps: ConnectionsDeps,
  who: { tenantId: string; userId: string },
  documentId: string,
): Promise<RawConnections | null> {
  const parsed = Uuid.safeParse(documentId);
  if (!parsed.success) return null;
  const id = parsed.data.toLowerCase();
  const read = await withTenant(deps.pool, who.tenantId, async (tx) => {
    if ((await tx.query(SELF_SQL, [who.userId, id])).rowCount === 0) return null;
    const related = await tx.query<RelatedRow>(RELATED_SQL, [
      who.userId,
      id,
      CONNECTIONS_CAPS.related,
    ]);
    const entities = await tx.query<EntityRow>(ENTITIES_SQL, [
      who.userId,
      id,
      CONNECTIONS_CAPS.entities,
      CONNECTIONS_CAPS.entityDocuments,
    ]);
    return { related: related.rows, entities: entities.rows };
  });
  if (read === null) return null;

  const cipher = deps.fields.forUser(who.userId);
  const open = async (bind: string, enc: unknown): Promise<string | null> => {
    try {
      return await cipher.openText(bind, enc);
    } catch {
      return null; // not logged: the failure names nothing, and what it guards is content
    }
  };
  const titles = new Map<string, Promise<string | null>>();
  const titleOf = (docId: string, enc: unknown): Promise<string | null> => {
    let t = titles.get(docId);
    if (t === undefined) {
      t = open(titleBind(docId), enc);
      titles.set(docId, t);
    }
    return t;
  };

  const related: RawConnections["related"] = [];
  for (const r of read.related) {
    const title = await titleOf(r.document_id, r.title_enc);
    if (title === null) continue;
    related.push({
      documentId: r.document_id,
      title,
      kinds: { entity: r.entity, reference: r.reference, similar: r.similar },
      strength: Number(r.strength),
    });
  }

  const groups = new Map<string, { kind: string; nameEnc: unknown; docs: { id: string; enc: unknown }[] }>();
  for (const r of read.entities) {
    const g = groups.get(r.entity_id) ?? { kind: r.kind, nameEnc: r.name_enc, docs: [] };
    g.docs.push({ id: r.document_id, enc: r.title_enc });
    groups.set(r.entity_id, g);
  }
  const entities: RawConnections["entities"] = [];
  for (const [entityId, g] of groups) {
    const name = await open(entityNameBind(entityId), g.nameEnc);
    if (name === null || name.trim() === "") continue;
    const docs = (
      await Promise.all(
        g.docs.map(async (d) => {
          const title = await titleOf(d.id, d.enc);
          return title === null ? null : { documentId: d.id, title };
        }),
      )
    )
      .filter((d): d is ConnectionDocument => d !== null)
      .sort(byTitle);
    if (docs.length === 0) continue;
    entities.push({ entityId, name, kind: g.kind, documents: docs });
  }
  return { documentId: id, related, entities };
}
```

- [ ] **Step 5: Build the experiences package and run the tests**

Run: `pnpm --filter @docmind/experiences build && set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/ui/connections.pg.test.ts`
Expected: PASS (all tests ran, none skipped). If an `EXPLAIN` assertion names a relation, that finding is real: change the query (join order or the missing predicate), never the assertion.

- [ ] **Step 6: Typecheck, lint and commit**

Run: `pnpm typecheck && pnpm typecheck:tests && pnpm lint` (use `pnpm lint:fix` for formatting, then re-run `pnpm lint`).

```bash
git add packages/experiences/src/providers.ts packages/experiences/src/invoker.ts packages/experiences/src/index.ts apps/server/app/ui/connections.ts apps/server/app/ui/connections.pg.test.ts
git commit -m "feat(visuals): owner-scoped connections query (related documents and shared entities)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uGukQihQRMMZgAPLXQiX6"
```

---

### Task 2: Provider, reader and owner clearance

**Files:**
- Create: `packages/experiences/src/connections.ts`
- Modify: `packages/experiences/src/providers.ts` (pin), `invoker.ts` (reader, args, case), `visuals.ts` (`OWNER_READ`, `visualCapabilities`), `index.ts`
- Modify: `apps/server/app/ui/readers.ts` (the `connections` reader)
- Modify (tests): `packages/experiences/src/hydrate.test.ts` (the `readers()` fake), `apps/server/app/ui/readers.test.ts`, `apps/server/app/ui/visuals.e2e.test.ts`, `apps/web/src/testing/fakeUi.ts` and the other full-`UiReaders` fakes
- Test: `packages/experiences/src/connections.test.ts`

**Interfaces:**
- Consumes: Task 1's `RawConnections`, `CONNECTIONS_CAPS`, `readConnections`.
- Produces (`@docmind/experiences`):
  - `PINS["doc.connections"] === "docmind:doc.connections@1"`; `Target` therefore includes `"doc.connections"`.
  - `UiReaders.connections(a: { documentId: string }): Promise<RawConnections | null>`.
  - `export const CONNECTIONS_HANDLE = "connections"`.
  - `export const CONNECTION_ENTRIES = ["RelatedDocuments", "ConnectionMap"] as const`; `export type ConnectionEntry`; `export const isConnectionEntry = (t: string): t is ConnectionEntry`.
  - `export const CONNECTION_HANDLE: Record<ConnectionEntry, string>` = `{ RelatedDocuments: "connections-table", ConnectionMap: "connections-map" }` (also the reshaper names).
  - `export function connectionsCapability(): CapabilityRef`.
  - `export const connectionsProvider = (documentId: string, entry: ConnectionEntry): ProviderSpec`.
  - `export function bindsConnections(visuals: Experience, handle: string): boolean`.
  - `export const clipConnections = (raw: RawConnections): RawConnections`.
  - `export const visualCapabilities = (facts: readonly VisualFactRaw[]): CapabilityRef[]` (`visuals.ts`).
  - `OWNER_READ.declaredToolClasses` gains `"docmind:doc.connections": "sensitive"`; `TURN_READ` unchanged.
- Server: `readersFor(deps, identity).connections({ documentId })` calls `readConnections(deps, identity, documentId)`.

- [ ] **Step 1: Write the failing contract and invoker tests**

Create `packages/experiences/src/connections.test.ts`:

```ts
import { genesis, replay } from "@loom-ui/core";
import type { Operation, ProviderSpec } from "@loom-ui/core";
import { declaredToolClassesFrom } from "@loom-ui/planner";
import { describe, expect, it, vi } from "vitest";
import {
  CONNECTIONS_HANDLE,
  CONNECTION_ENTRIES,
  CONNECTION_HANDLE,
  bindsConnections,
  clipConnections,
  connectionsCapability,
  connectionsProvider,
  isConnectionEntry,
} from "./connections";
import { INVOKE_ID, type RawConnections, type UiReaders, createInvoker } from "./invoker";
import { CONNECTIONS_CAPS, PINS, provider } from "./providers";
import {
  OWNER_READ,
  TURN_READ,
  type VisualFactRaw,
  capabilitiesOf,
  factCapabilities,
  visualCapabilities,
} from "./visuals";

const DOC = "00000000-0000-4000-8000-0000000000d1";
const FIGURE: VisualFactRaw = {
  kind: "figure",
  label: "Revenue",
  value: 1,
  chunkIds: [],
  ordinal: 0,
};
const raw = (related: number, entities = 0): RawConnections => ({
  documentId: DOC,
  related: Array.from({ length: related }, (_, i) => ({
    documentId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    title: `Doc ${i}`,
    kinds: { entity: 1, reference: 0, similar: 0 },
    strength: 0.5,
  })),
  entities: Array.from({ length: entities }, (_, i) => ({
    entityId: `00000000-0000-4000-8000-${String(i + 500).padStart(12, "0")}`,
    name: `Entity ${i}`,
    kind: "organization",
    documents: Array.from({ length: 9 }, (_, j) => ({
      documentId: `00000000-0000-4000-8000-${String(j + 1).padStart(12, "0")}`,
      title: `Doc ${j}`,
    })),
  })),
});
const call = (readers: Partial<UiReaders>, args: unknown) =>
  createInvoker(readers as UiReaders).invokeTransient(INVOKE_ID, {
    target: "doc.connections",
    args,
  });

describe("the connections contract", () => {
  it("pins the tool and names its two entries and handles", () => {
    expect(PINS["doc.connections"]).toBe("docmind:doc.connections@1");
    expect(CONNECTIONS_HANDLE).toBe("connections");
    expect(CONNECTION_ENTRIES).toEqual(["RelatedDocuments", "ConnectionMap"]);
    expect(CONNECTION_HANDLE).toEqual({
      RelatedDocuments: "connections-table",
      ConnectionMap: "connections-map",
    });
    expect(isConnectionEntry("ConnectionMap")).toBe(true);
    expect(isConnectionEntry("KeyFigure")).toBe(false);
    expect(isConnectionEntry("__proto__")).toBe(false);
  });

  it("offers one bindable, sensitive capability with the pin and a content-free sample", () => {
    const c = connectionsCapability();
    expect(c).toMatchObject({
      handle: "connections",
      kind: "docmind",
      toolName: "doc.connections",
      toolVersion: "1.0.0",
      toolSchemaHash: "docmind:doc.connections@1",
      sensitivity: "sensitive",
    });
    expect(c.sampleOutput).toBeDefined();
    expect(JSON.stringify(c.sampleOutput)).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("is offered with the facts for a document, and never for a chat turn", () => {
    expect(visualCapabilities([FIGURE]).map((c) => c.handle)).toEqual(["fact-0", "connections"]);
    expect(visualCapabilities([]).map((c) => c.handle)).toEqual(["connections"]);
    expect(capabilitiesOf([FIGURE]).map((c) => c.handle)).toEqual(["fact-0"]);
    expect(
      factCapabilities([{ fact: FIGURE, origin: { kind: "turn" } }]).some(
        (c) => c.toolName === "doc.connections",
      ),
    ).toBe(false);
  });

  it("is classified sensitive for the owner's read, and equals what the capabilities declare", () => {
    expect(OWNER_READ.declaredToolClasses["docmind:doc.connections"]).toBe("sensitive");
    expect(declaredToolClassesFrom(visualCapabilities([FIGURE]))).toEqual(
      OWNER_READ.declaredToolClasses,
    );
    expect(Object.keys(TURN_READ.declaredToolClasses)).not.toContain("docmind:doc.connections");
  });

  it("builds a provider whose only argument is the server's document id, with nothing overridable", () => {
    const p = connectionsProvider(DOC, "RelatedDocuments");
    expect(p.handle).toBe("connections-table");
    expect(p.reshaping).toMatchObject({ scriptRef: "connections-table" });
    expect(p.executionGraph[0]).toMatchObject({
      toolName: "doc.connections",
      toolSchemaHash: PINS["doc.connections"],
      arguments: { documentId: DOC },
      overridable: [],
    });
    expect(connectionsProvider(DOC, "ConnectionMap").handle).toBe("connections-map");
  });

  it("recognises a planner binding to connections by direct handle or by the provider's pin, and no other", () => {
    const g = genesis({
      experienceId: "docmind.visuals",
      intent: { objective: "v", source: "user" },
      meta: { author: "planner", createdAt: "2026-11-08T00:00:00Z", sourceKind: "code" },
    });
    const pinned = (handle: string, target: "doc.connections" | "visual.facts") =>
      ({ ...provider(handle, { target, args: {}, reshaper: "x" }), handle }) as ProviderSpec;
    const ops: Operation[] = [
      { type: "remapProvider", handle: "p-conn", spec: pinned("p-conn", "doc.connections") },
      { type: "remapProvider", handle: "p-fact", spec: pinned("p-fact", "visual.facts") },
    ];
    const r = replay(g, ops);
    if (!r.ok) throw new Error("fixture does not replay");
    expect(bindsConnections(r.value, "connections")).toBe(true);
    expect(bindsConnections(r.value, "p-conn")).toBe(true);
    expect(bindsConnections(r.value, "p-fact")).toBe(false);
    expect(bindsConnections(r.value, "nope")).toBe(false);
    expect(bindsConnections(r.value, "__proto__")).toBe(false);
  });

  it("clips a reader's answer to the caps and drops fields it does not know", () => {
    const clipped = clipConnections({ ...raw(20, 20), extra: "x" } as never);
    expect(clipped.related).toHaveLength(CONNECTIONS_CAPS.related);
    expect(clipped.entities).toHaveLength(CONNECTIONS_CAPS.entities);
    expect(clipped.entities[0]?.documents).toHaveLength(CONNECTIONS_CAPS.entityDocuments);
    expect(Object.keys(clipped).sort()).toEqual(["documentId", "entities", "related"]);
  });
});

describe("the doc.connections read through the invoker", () => {
  it("parses the document id (any case), calls the reader once for identical calls and clips an over-long answer", async () => {
    const connections = vi.fn(async () => raw(20, 20));
    const readers = { connections };
    const inv = createInvoker(readers as unknown as UiReaders);
    const ask = (documentId: string) =>
      inv.invokeTransient<unknown, RawConnections>(INVOKE_ID, {
        target: "doc.connections",
        args: { documentId },
      });
    const [a, b] = await Promise.all([ask(DOC.toUpperCase()), ask(DOC)]);
    expect(connections).toHaveBeenCalledTimes(1);
    expect(connections).toHaveBeenCalledWith({ documentId: DOC });
    expect(a.related).toHaveLength(8);
    expect(b.entities).toHaveLength(12);
  });

  it("refuses bad arguments (a wrong type, a missing id, an extra key) before any reader runs", async () => {
    const connections = vi.fn(async () => raw(0));
    for (const args of [{ documentId: "x" }, {}, { documentId: DOC, extra: 1 }, undefined])
      await expect(call({ connections }, args)).rejects.toMatchObject({ channel: "invalidArgs" });
    expect(connections).not.toHaveBeenCalled();
  });

  it("answers notFound for a document the reader does not know", async () => {
    await expect(call({ connections: async () => null }, { documentId: DOC })).rejects.toMatchObject(
      { channel: "notFound" },
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/experiences exec vitest run src/connections.test.ts`
Expected: FAIL (`Failed to resolve import "./connections"`).

- [ ] **Step 3: Add the pin, the reader and the clearance**

In `packages/experiences/src/providers.ts`, in `PINS` add after `"turn.facts": "docmind:turn.facts@1",`:

```ts
  "doc.connections": "docmind:doc.connections@1",
```

In `packages/experiences/src/invoker.ts`:

1. Add the import `import { clipConnections } from "./connections";` after the `import { z } from "zod";` line.
2. In `UiReaders`, after the `turnFacts` line add:

```ts
  /** The connections of one of the caller's documents (live); null when it is not the caller's. */
  connections(a: { documentId: string }): Promise<RawConnections | null>;
```

3. In `ARGS`, after `"visual.facts": z.object({ id: Id }).strict(),` add:

```ts
  "doc.connections": z.object({ documentId: Id }).strict(),
```

4. In the `switch`, before `default:` add:

```ts
      case "doc.connections": {
        const a = ARGS["doc.connections"].safeParse(args);
        if (!a.success) return fail("invalidArgs");
        return {
          key: [target, a.data],
          exec: async () =>
            clipConnections(
              (await readers.connections({ documentId: a.data.documentId })) ?? fail("notFound"),
            ),
        };
      }
```

Create `packages/experiences/src/connections.ts`:

```ts
import type { Experience, ProviderSpec } from "@loom-ui/core";
import type { CapabilityRef } from "@loom-ui/planner";
import type { RawConnections } from "./invoker";
import { CONNECTIONS_CAPS, KIND, PINS, provider } from "./providers";

/** The planner's handle for the connections capability: one per document. */
export const CONNECTIONS_HANDLE = "connections";

export const CONNECTION_ENTRIES = ["RelatedDocuments", "ConnectionMap"] as const;
export type ConnectionEntry = (typeof CONNECTION_ENTRIES)[number];
export const isConnectionEntry = (t: string): t is ConnectionEntry =>
  (CONNECTION_ENTRIES as readonly string[]).includes(t);

/** The provider handle a served entry reads, which is also the name of its reshaper. */
export const CONNECTION_HANDLE: Record<ConnectionEntry, string> = {
  RelatedDocuments: "connections-table",
  ConnectionMap: "connections-map",
};

/**
 * The capability the document planner is always offered (K5). Its sample is a made-up, content-free shape of one read: the
 * prompt names no document of the owner's. Sensitive, so the owner's clearance serves it (R27).
 */
export function connectionsCapability(): CapabilityRef {
  const sample: RawConnections = {
    documentId: "",
    related: [
      {
        documentId: "",
        title: "A related document",
        kinds: { entity: 1, reference: 0, similar: 0 },
        strength: 0.5,
      },
    ],
    entities: [
      {
        entityId: "",
        name: "A shared name",
        kind: "organization",
        documents: [{ documentId: "", title: "A related document" }],
      },
    ],
  };
  return {
    handle: CONNECTIONS_HANDLE,
    kind: KIND,
    toolName: "doc.connections",
    toolVersion: "1.0.0",
    toolSchemaHash: PINS["doc.connections"],
    description:
      "the other documents in this library that are related to this one, and the people, organisations and products they share (live: it changes as the library does)",
    sampleOutput: sample,
    sensitivity: "sensitive",
  };
}

/**
 * The provider a connections node is served from: generated here from the entry and the server's own document id, never from the
 * planner's spec. Its only argument is that id and nothing is overridable, so a client cannot point it at another document.
 */
export const connectionsProvider = (documentId: string, entry: ConnectionEntry): ProviderSpec =>
  provider(CONNECTION_HANDLE[entry], {
    target: "doc.connections",
    args: { documentId },
    reshaper: CONNECTION_HANDLE[entry],
  });

/** A planner node binds connections when its handle is `connections`, or names a provider whose step carries the connections pin. */
export function bindsConnections(visuals: Experience, handle: string): boolean {
  if (handle === CONNECTIONS_HANDLE) return true;
  const step = Object.hasOwn(visuals.providers, handle)
    ? visuals.providers[handle]?.executionGraph[0]
    : undefined;
  return (
    step !== undefined &&
    step.toolName === "doc.connections" &&
    step.toolSchemaHash === PINS["doc.connections"]
  );
}

/** A reader's answer cut to the caps, rebuilt field by field so nothing it adds survives. */
export const clipConnections = (raw: RawConnections): RawConnections => ({
  documentId: raw.documentId,
  related: raw.related.slice(0, CONNECTIONS_CAPS.related),
  entities: raw.entities.slice(0, CONNECTIONS_CAPS.entities).map((e) => ({
    ...e,
    documents: e.documents.slice(0, CONNECTIONS_CAPS.entityDocuments),
  })),
});
```

In `packages/experiences/src/visuals.ts`:

1. After `import { DOCMIND_CATALOG, SURFACES } from "./catalog";` add `import { connectionsCapability } from "./connections";`.
2. Replace `  declaredToolClasses: { "docmind:visual.facts": "sensitive" },` (inside `OWNER_READ`) with:

```ts
  declaredToolClasses: {
    "docmind:visual.facts": "sensitive",
    "docmind:doc.connections": "sensitive",
  },
```

3. After the `capabilitiesOf` function add:

```ts
/** What the document planner is offered: one capability per stored fact, then the live connections (always, even with no facts). */
export const visualCapabilities = (facts: readonly VisualFactRaw[]): CapabilityRef[] => [
  ...capabilitiesOf(facts),
  connectionsCapability(),
];
```

In `packages/experiences/src/index.ts` replace `  capabilitiesOf,\n  factCapabilities,\n  factProvider,` with `  capabilitiesOf,\n  factCapabilities,\n  factProvider,\n  visualCapabilities,` and add a new line after the `export * from "./providers";` line: `export {\n  CONNECTIONS_HANDLE,\n  CONNECTION_ENTRIES,\n  CONNECTION_HANDLE,\n  connectionsCapability,\n  connectionsProvider,\n} from "./connections";\nexport type { ConnectionEntry } from "./connections";`

- [ ] **Step 4: The server reader, and the existing fakes**

In `apps/server/app/ui/readers.ts` add the import `import { readConnections } from "./connections";` before the `./factCites` import line, and before `async turnFacts({ chatId, ord }) {` add:

```ts
    connections: ({ documentId }) => readConnections(deps, identity, documentId),

```

Append to `apps/server/app/ui/readers.test.ts` (shell: `cat >> apps/server/app/ui/readers.test.ts <<'EOF' ... EOF`):

```ts

describe("the connections reader", () => {
  it("reads the connections of the caller's document with the caller's identity", async () => {
    vi.resetModules();
    const readConnections = vi.fn(async () => null);
    vi.doMock("./connections", () => ({ readConnections }));
    const { readersFor } = await import("./readers");
    const deps = { pool: {}, fields: {} } as never;
    const identity = { userId: "u", tenantId: "t" } as never;
    const r = readersFor(deps, identity);
    await expect(r.connections({ documentId: "d" })).resolves.toBeNull();
    expect(readConnections).toHaveBeenLastCalledWith(deps, identity, "d");
    vi.doUnmock("./connections");
  });
});
```

Complete every full `UiReaders` fake so `pnpm typecheck:tests` passes:

```bash
perl -0pi -e 's/^(\s*)turnFacts: async \(\) => null,\n/$&$1connections: async () => null,\n/mg' \
  apps/web/src/testing/fakeUi.ts apps/web/src/testing/fakeServer.ts apps/web/src/ui/session.test.ts \
  apps/web/src/components/dm-app.test.ts apps/web/src/components/dm-doc-detail.test.ts \
  apps/web/src/components/dm-sessions.test.ts apps/web/src/components/dm-documents-page.test.ts
perl -0pi -e 's/^(\s*)turnFacts: vi\.fn\(async \(\) => null\),\n/$&$1connections: vi.fn(async () => null),\n/mg' packages/experiences/src/hydrate.test.ts
git diff --stat
```

The OWNER_READ equality in `apps/server/app/ui/visuals.e2e.test.ts` must now use the document capabilities: replace the imports `capabilitiesOf,` with `visualCapabilities,` (in the import list from `@docmind/experiences`; keep the other names) and replace `declaredToolClassesFrom(capabilitiesOf(facts as never))` with `declaredToolClassesFrom(visualCapabilities(facts as never))`.

- [ ] **Step 5: Build and run**

Run: `pnpm --filter @docmind/experiences build && pnpm --filter @docmind/experiences test && pnpm --filter @docmind/server exec vitest run app/ui/readers.test.ts app/ui/visuals.e2e.test.ts && pnpm typecheck && pnpm typecheck:tests`
Expected: PASS. If `pnpm typecheck:tests` still names a file that builds a full `UiReaders` and was not in the perl list, add `connections: async () => null,` beside its `turnFacts`.

- [ ] **Step 6: Lint and commit**

Run: `pnpm lint` (`pnpm lint:fix` first if it reports formatting).

```bash
git add packages/experiences apps/server/app/ui apps/web/src
git commit -m "feat(visuals): doc.connections provider, reader and owner clearance

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uGukQihQRMMZgAPLXQiX6"
```

---

### Task 3: Web registers the opt-in Diagram widget

Plan decision: this lands before the catalogue entries, because `apps/web/src/ui/elements.test.ts` checks a tag and a defined element for every kind in `mergedCatalog()`.

**Files:**
- Modify: `apps/web/src/ui/session.ts`
- Test: `apps/web/src/ui/elements.test.ts`

**Interfaces:**
- Consumes: `registerDiagramWidgets(registry: DomRegistry, opts?: LitRegistryOptions): DomRegistry` from `@loom-ui/renderer-lit/diagram`; `createChatLitRegistry(opts)` from `@loom-ui/renderer-lit/chat`.
- Produces: `export function createViewRegistry(opts?: Parameters<typeof createChatLitRegistry>[0]): ReturnType<typeof createChatLitRegistry>` in `apps/web/src/ui/session.ts`: the registry every `ViewSession.mount` draws with (chat kinds over loom-ui's defaults, plus Diagram).

- [ ] **Step 1: Write the failing test**

In `apps/web/src/ui/elements.test.ts`:

1. Replace `import { createChatLitRegistry } from "@loom-ui/renderer-lit/chat";` with nothing (delete it), and replace `import "./session";` with `import { createViewRegistry } from "./session";`.
2. In `TAG`, after `Chat: "lu-chat",` add `Diagram: "lu-diagram",`.
3. Replace the lines
```ts
// The chat registry defines the chat and input elements when it is built (session.ts builds it on mount).
createChatLitRegistry();
```
with
```ts
// The view registry defines the chat and input elements and the opt-in diagram element when it is built (session.ts builds it on mount).
createViewRegistry();
```
4. Append inside the file (shell `cat >>`):

```ts

describe("the opt-in diagram widget", () => {
  it("is defined by the registry every view is drawn with (the connections map)", () => {
    expect(customElements.get("lu-diagram")).toBeDefined();
    expect(createViewRegistry()).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/web exec vitest run src/ui/elements.test.ts`
Expected: FAIL (`createViewRegistry` is not exported).

- [ ] **Step 3: Implement**

In `apps/web/src/ui/session.ts`, add after the `createChatLitRegistry` import line:

```ts
import { registerDiagramWidgets } from "@loom-ui/renderer-lit/diagram";
```

Add above `export class ViewSession` (after `fetchPayload`):

```ts
/** The registry every view is drawn with: loom-ui's chat kinds over its defaults, plus the opt-in Diagram widget (the connections map). */
export function createViewRegistry(opts: Parameters<typeof createChatLitRegistry>[0] = {}) {
  return registerDiagramWidgets(createChatLitRegistry(opts), {});
}
```

Replace in `mount`:

```ts
      registry: createChatLitRegistry({
        ...(o.chatAccessories && { chatAccessories: o.chatAccessories }),
      }),
```
with
```ts
      registry: createViewRegistry({
        ...(o.chatAccessories && { chatAccessories: o.chatAccessories }),
      }),
```

- [ ] **Step 4: Run the web suite and checks**

Run: `pnpm --filter @docmind/web exec vitest run src/ui && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: PASS. Then `pnpm build` (the web bundle must resolve `@loom-ui/renderer-lit/diagram`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/session.ts apps/web/src/ui/elements.test.ts
git commit -m "feat(web): register loom-ui's opt-in Diagram widget for connection maps

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uGukQihQRMMZgAPLXQiX6"
```

---

### Task 4: Catalogue entries, reshapers, adoption and hydration

**Files:**
- Create: `packages/experiences/src/connectionShapes.ts`
- Modify: `packages/experiences/src/visuals.ts` (catalogue), `reshapers.ts`, `views.ts`
- Modify (tests): `packages/experiences/src/visuals.test.ts`
- Test: `packages/experiences/src/connectionShapes.test.ts`, `packages/experiences/src/connectionsView.test.ts`

**Interfaces:**
- Consumes (Task 2): `RawConnections`, `CONNECTIONS_CAPS`, `CONNECTION_HANDLE`, `CONNECTION_ENTRIES`, `ConnectionEntry`, `isConnectionEntry`, `connectionsProvider`, `bindsConnections`, `OWNER_READ`.
- Produces:
  - `VISUALS_CATALOG` gains entries `RelatedDocuments` (kind `Table`, props `[]`) and `ConnectionMap` (kind `Diagram`, props `["timeFormat"]`), both `binding: "required"`, both surfaces.
  - `connectionShapes.ts`: `export const EMPTY_RELATED = "No connected documents yet"`, `export const SELF_LABEL = "This document"`, `export const CONNECTION_SHAPES: Record<string, (raw: never) => unknown>` with keys `connections-table` and `connections-map`; `shape("connections-table" | "connections-map", raw)` (`reshapers.ts`) returns the Table / Diagram value.
  - `detailWithVisuals(visuals, documentId)` adopts a node of type `RelatedDocuments` / `ConnectionMap` that binds connections: provider `connections-table` / `connections-map` generated from `connectionsProvider(documentId, entry)`, node id prefixed `v-`, priority at most P1. `turnWithVisuals` never adopts them (K7).

- [ ] **Step 1: Write the failing reshaper tests**

Create `packages/experiences/src/connectionShapes.test.ts`:

```ts
import { DiagramValue, MAX_DIAGRAM_NODES, TableValue, diagramProblems } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { EMPTY_RELATED, SELF_LABEL } from "./connectionShapes";
import type { RawConnections } from "./invoker";
import { shape } from "./reshapers";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SELF = uuid(1);
const B = uuid(2);
const C = uuid(3);
const D = uuid(4);

const RAW: RawConnections = {
  documentId: SELF,
  related: [
    { documentId: B, title: "Contract B", kinds: { entity: 2, reference: 0, similar: 0 }, strength: 0.9 },
    { documentId: C, title: "Notes C", kinds: { entity: 0, reference: 0, similar: 3 }, strength: 0.6 },
    { documentId: D, title: "Memo D", kinds: { entity: 0, reference: 1, similar: 0 }, strength: 0.4 },
  ],
  entities: [
    {
      entityId: uuid(10),
      name: "Acme Corp",
      kind: "organization",
      documents: [{ documentId: B, title: "Contract B" }],
    },
    {
      entityId: uuid(11),
      name: "Jane Doe",
      kind: "person",
      documents: [
        { documentId: B, title: "Contract B" },
        { documentId: uuid(99), title: "Not a node" },
      ],
    },
  ],
};
const EMPTY: RawConnections = { documentId: SELF, related: [], entities: [] };

type Table = {
  columns: unknown[];
  rows: unknown[][];
  rowKeys?: string[];
  rowActions?: { id: string; label: string; primary?: boolean }[][];
  refs?: unknown;
};
type Diagram = {
  layout: string;
  nodes: { id: string; label: string; group?: string; kind?: string }[];
  edges: { from: string; to: string; label?: string; kind?: string }[];
  refs?: unknown;
};

describe("connections-table", () => {
  const t = shape("connections-table", RAW) as Table;

  it("has Document, Why and Strength columns and one keyed row per related document, in order", () => {
    expect(t.columns).toEqual([
      "Document",
      "Why",
      { label: "Strength", format: { semanticType: "percentage", maximumFractionDigits: 0 } },
    ]);
    expect(t.rows).toEqual([
      ["Contract B", "shares Acme Corp, Jane Doe", 0.9],
      ["Notes C", "similar content", 0.6],
      ["Memo D", "referenced", 0.4],
    ]);
    expect(t.rowKeys).toEqual([B, C, D]);
  });

  it("gives every row one primary Open action and cites nothing", () => {
    expect(t.rowActions).toEqual([
      [{ id: "open", label: "Open", primary: true }],
      [{ id: "open", label: "Open", primary: true }],
      [{ id: "open", label: "Open", primary: true }],
    ]);
    expect(t.refs).toBeUndefined();
  });

  it("is a valid loom-ui Table value", () => {
    expect(TableValue.safeParse(t).success).toBe(true);
  });

  it("joins the kinds that apply, names at most three shared entities, and says 'entities' when none is listed", () => {
    const many: RawConnections = {
      documentId: SELF,
      related: [
        { documentId: B, title: "B", kinds: { entity: 1, reference: 1, similar: 1 }, strength: 1 },
        { documentId: C, title: "C", kinds: { entity: 1, reference: 0, similar: 0 }, strength: 1 },
      ],
      entities: ["One", "Two", "Three", "Four"].map((name, i) => ({
        entityId: uuid(20 + i),
        name,
        kind: "other",
        documents: [{ documentId: B, title: "B" }],
      })),
    };
    const rows = (shape("connections-table", many) as Table).rows;
    expect(rows[0]?.[1]).toBe("shares One, Two, Three; referenced; similar content");
    expect(rows[1]?.[1]).toBe("shares entities");
  });

  it("is a single visible placeholder row, with no keys or actions, when nothing is connected", () => {
    const e = shape("connections-table", EMPTY) as Table;
    expect(e.rows).toEqual([[EMPTY_RELATED, "", ""]]);
    expect(EMPTY_RELATED).toBe("No connected documents yet");
    expect(e.rowKeys).toBeUndefined();
    expect(e.rowActions).toBeUndefined();
    expect(TableValue.safeParse(e).success).toBe(true);
  });

  it("labels an untitled document and clips a very long title", () => {
    const odd: RawConnections = {
      documentId: SELF,
      related: [
        { documentId: B, title: "  ", kinds: { entity: 0, reference: 0, similar: 1 }, strength: 0.5 },
        { documentId: C, title: "x".repeat(500), kinds: { entity: 0, reference: 0, similar: 1 }, strength: 0.4 },
      ],
      entities: [],
    };
    const rows = (shape("connections-table", odd) as Table).rows;
    expect(rows[0]?.[0]).toBe("Untitled document");
    expect((rows[1]?.[0] as string).length).toBe(200);
  });
});

describe("connections-map", () => {
  const m = shape("connections-map", RAW) as Diagram;

  it("is a network of this document, the related documents and the shared entities, with prefixed unique ids", () => {
    expect(m.layout).toBe("network");
    expect(m.nodes).toEqual([
      { id: `doc:${SELF}`, label: SELF_LABEL, group: "self" },
      { id: `doc:${B}`, label: "Contract B", group: "document" },
      { id: `doc:${C}`, label: "Notes C", group: "document" },
      { id: `doc:${D}`, label: "Memo D", group: "document" },
      { id: `ent:${uuid(10)}`, label: "Acme Corp", group: "entity", kind: "organization" },
      { id: `ent:${uuid(11)}`, label: "Jane Doe", group: "entity", kind: "person" },
    ]);
    expect(new Set(m.nodes.map((n) => n.id)).size).toBe(m.nodes.length);
  });

  it("links self to a document by a reference or similar link (labelled), and documents to the entities they share", () => {
    expect(m.edges).toEqual([
      { from: `doc:${SELF}`, to: `doc:${C}`, label: "similar", kind: "similar" },
      { from: `doc:${SELF}`, to: `doc:${D}`, label: "reference", kind: "reference" },
      { from: `doc:${SELF}`, to: `ent:${uuid(10)}` },
      { from: `doc:${B}`, to: `ent:${uuid(10)}` },
      { from: `doc:${SELF}`, to: `ent:${uuid(11)}` },
      { from: `doc:${B}`, to: `ent:${uuid(11)}` },
    ]);
  });

  it("names only documents that are nodes, and passes loom-ui's diagram checks, with no refs", () => {
    expect(m.edges.every((e) => m.nodes.some((n) => n.id === e.to))).toBe(true);
    expect(diagramProblems(m)).toEqual([]);
    expect(DiagramValue.safeParse(m).success).toBe(true);
    expect(m.refs).toBeUndefined();
  });

  it("is one self node when nothing is connected", () => {
    const e = shape("connections-map", EMPTY) as Diagram;
    expect(e.nodes).toEqual([{ id: `doc:${SELF}`, label: SELF_LABEL, group: "self" }]);
    expect(e.edges).toEqual([]);
    expect(diagramProblems(e)).toEqual([]);
  });

  it("never exceeds 21 nodes, even from an over-long raw value, and stays clean", () => {
    const big: RawConnections = {
      documentId: SELF,
      related: Array.from({ length: 30 }, (_, i) => ({
        documentId: uuid(100 + i),
        title: `D${i}`,
        kinds: { entity: 0, reference: 1, similar: 0 },
        strength: 0.5,
      })),
      entities: Array.from({ length: 30 }, (_, i) => ({
        entityId: uuid(200 + i),
        name: `E${i}`,
        kind: "person",
        documents: Array.from({ length: 12 }, (_, j) => ({ documentId: uuid(100 + j), title: `D${j}` })),
      })),
    };
    const out = shape("connections-map", big) as Diagram;
    expect(out.nodes.length).toBe(21);
    expect(out.nodes.length).toBeLessThanOrEqual(MAX_DIAGRAM_NODES);
    expect(diagramProblems(out)).toEqual([]);
    expect(new Set(out.edges.map((e) => `${e.from}>${e.to}`)).size).toBe(out.edges.length);
  });

  it("keeps ids unique when the same document or entity appears twice", () => {
    const dup: RawConnections = {
      documentId: SELF,
      related: [RAW.related[0], RAW.related[0], { ...RAW.related[1], documentId: SELF }] as never,
      entities: [RAW.entities[0], RAW.entities[0]] as never,
    };
    const out = shape("connections-map", dup) as Diagram;
    expect(diagramProblems(out)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/experiences exec vitest run src/connectionShapes.test.ts`
Expected: FAIL (`Failed to resolve import "./connectionShapes"`).

- [ ] **Step 3: Write the reshapers and register them**

Create `packages/experiences/src/connectionShapes.ts`:

```ts
import type { RawConnections } from "./invoker";
import { CONNECTIONS_CAPS } from "./providers";

export const EMPTY_RELATED = "No connected documents yet";
export const SELF_LABEL = "This document";
const UNTITLED = "Untitled document";
const MAX_LABEL = 200;
const MAX_NAMES = 3;

/** Cuts to at most `max` UTF-16 units, never ending in half a surrogate pair. */
const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};
const label = (title: string): string => (title.trim() === "" ? UNTITLED : clip(title.trim(), MAX_LABEL));

type Related = RawConnections["related"][number];

/** "shares A, B; referenced; similar content": the kinds that apply, the top shared names (rarest entity first). */
const whyOf = (r: Related, names: readonly string[]): string => {
  const parts: string[] = [];
  if (r.kinds.entity > 0)
    parts.push(names.length > 0 ? `shares ${names.join(", ")}` : "shares entities");
  if (r.kinds.reference > 0) parts.push("referenced");
  if (r.kinds.similar > 0) parts.push("similar content");
  return parts.length > 0 ? parts.join("; ") : "connected";
};

const COLUMNS = [
  "Document",
  "Why",
  { label: "Strength", format: { semanticType: "percentage", maximumFractionDigits: 0 } },
];

/**
 * A Table has no visible caption of its own (loom-ui's `<caption>` is for screen readers), so the empty state is one row
 * that says it. No row keys and no actions: nothing to open.
 */
const table = (raw: RawConnections): unknown => {
  const related = raw.related.slice(0, CONNECTIONS_CAPS.related);
  if (related.length === 0) return { columns: COLUMNS, rows: [[EMPTY_RELATED, "", ""]] };
  const namesFor = (documentId: string): string[] =>
    raw.entities
      .filter((e) => e.documents.some((d) => d.documentId === documentId))
      .map((e) => e.name)
      .slice(0, MAX_NAMES);
  return {
    columns: COLUMNS,
    rows: related.map((r) => [label(r.title), whyOf(r, namesFor(r.documentId)), r.strength]),
    rowKeys: related.map((r) => r.documentId),
    rowActions: related.map(() => [{ id: "open", label: "Open", primary: true }]),
  };
};

type Node = { id: string; label: string; group: string; kind?: string };
type Edge = { from: string; to: string; label?: string; kind?: string };

const map = (raw: RawConnections): unknown => {
  const self = `doc:${raw.documentId}`;
  const nodes: Node[] = [{ id: self, label: SELF_LABEL, group: "self" }];
  const edges: Edge[] = [];
  const ids = new Set([self]);
  const seenEdges = new Set<string>();
  const edge = (e: Edge) => {
    const key = `${e.from}>${e.to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push(e);
  };
  for (const r of raw.related.slice(0, CONNECTIONS_CAPS.related)) {
    const id = `doc:${r.documentId}`;
    if (ids.has(id)) continue;
    ids.add(id);
    nodes.push({ id, label: label(r.title), group: "document" });
    const kind = r.kinds.reference > 0 ? "reference" : r.kinds.similar > 0 ? "similar" : undefined;
    if (kind !== undefined) edge({ from: self, to: id, label: kind, kind });
  }
  for (const e of raw.entities.slice(0, CONNECTIONS_CAPS.entities)) {
    const id = `ent:${e.entityId}`;
    if (ids.has(id)) continue;
    ids.add(id);
    nodes.push({ id, label: label(e.name), group: "entity", kind: e.kind });
    edge({ from: self, to: id });
    for (const d of e.documents) {
      const from = `doc:${d.documentId}`;
      if (from !== self && ids.has(from)) edge({ from, to: id });
    }
  }
  return { layout: "network", nodes, edges };
};

/** The two connections reshapers, by name (they are also the provider handles `CONNECTION_HANDLE`). Both are total on empty data. */
export const CONNECTION_SHAPES: Record<string, (raw: never) => unknown> = {
  "connections-table": (raw: RawConnections) => table(raw),
  "connections-map": (raw: RawConnections) => map(raw),
};
```

In `packages/experiences/src/reshapers.ts` add after `import { CONTENT_STEP, LIST_CAP } from "./providers";` the line `import { CONNECTION_SHAPES } from "./connectionShapes";` and replace `  ...VISUAL_SHAPES,` with `  ...VISUAL_SHAPES,\n  ...CONNECTION_SHAPES,`.

- [ ] **Step 4: Run the reshaper tests**

Run: `pnpm --filter @docmind/experiences exec vitest run src/connectionShapes.test.ts`
Expected: PASS. Note the `dup` test builds a related entry whose `documentId` is the document itself: the map must skip it (its id equals the self id), which `ids.has` does.

- [ ] **Step 5: Write the failing adoption and hydration tests**

Create `packages/experiences/src/connectionsView.test.ts`:

```ts
import {
  type ContainerNode,
  type Experience,
  type ExperienceNode,
  type Operation,
  type ProviderSpec,
  type SemanticNode,
  compile,
  genesis,
  replay,
} from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HYDRATION_PROJECTION_VERSION } from "@loom-ui/hydration";
import { describe, expect, it, vi } from "vitest";
import { connectionsProvider } from "./connections";
import type { RawConnections, UiReaders } from "./invoker";
import { PINS, provider } from "./providers";
import { detailWithVisuals, turnWithVisuals } from "./views";
import { createViews } from "./views-api";
import { factProvider, mergedCatalog } from "./visuals";

const DOC = "00000000-0000-4000-8000-0000000000d1";
const OTHER = "00000000-0000-4000-8000-0000000000d9";
const REL = "00000000-0000-4000-8000-0000000000b1";
const KEY = "k".repeat(32);

const node = (id: string, type: string, handle: string, priority = "P0"): SemanticNode =>
  ({
    id,
    order: id,
    kind: "semantic",
    type,
    typeVersion: "1.0.0",
    span: 12,
    props: {},
    binding: { handle, priority },
  }) as SemanticNode;

/** What the planner commits: a provider per handle and nodes bound to them. */
const experienceOf = (nodes: SemanticNode[], specOf: (handle: string) => ProviderSpec): Experience => {
  const g = genesis({
    experienceId: "docmind.visuals",
    intent: { objective: "Visuals", source: "user" },
    meta: { author: "planner", createdAt: "2026-11-08T00:00:00Z", sourceKind: "code" },
  });
  const ops: Operation[] = [];
  for (const h of new Set(nodes.map((n) => n.binding?.handle as string)))
    ops.push({ type: "remapProvider", handle: h, spec: { ...specOf(h), handle: h } });
  nodes.forEach((n, i) =>
    ops.push({
      type: "insertNode",
      parentId: g.root.id,
      node: { ...n, order: String.fromCharCode(0x61 + i), binding: undefined },
    }),
  );
  for (const n of nodes)
    ops.push({
      type: "bindProvider",
      nodeId: n.id,
      handle: n.binding?.handle as string,
      priority: n.binding?.priority,
    });
  const r = replay(g, ops);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.value;
};
const committed = (h: string): ProviderSpec =>
  h === "connections"
    ? (provider(h, { target: "doc.connections", args: {}, reshaper: "x" }) as ProviderSpec)
    : factProvider(0, "planner-guess", "KeyFigure");

const both = () =>
  experienceOf(
    [node("rel", "RelatedDocuments", "connections"), node("map", "ConnectionMap", "connections")],
    committed,
  );

const find = (n: ExperienceNode, id: string): ExperienceNode | undefined =>
  n.id === id
    ? n
    : n.kind === "container"
      ? (n.children as ExperienceNode[]).map((c) => find(c, id)).find((x) => x)
      : undefined;

describe("detailWithVisuals with connections", () => {
  it("adopts both entries onto their own provider, generated from the server's document id", () => {
    const exp = detailWithVisuals(both(), DOC);
    const panel = find(exp.root, "visuals") as ContainerNode;
    expect(panel.children.map((c) => c.id)).toEqual(["v-rel", "v-map"]);
    expect(exp.providers["connections-table"]).toEqual(connectionsProvider(DOC, "RelatedDocuments"));
    expect(exp.providers["connections-map"]).toEqual(connectionsProvider(DOC, "ConnectionMap"));
    expect(exp.providers["connections-table"]?.executionGraph[0]).toMatchObject({
      toolName: "doc.connections",
      toolSchemaHash: PINS["doc.connections"],
      arguments: { documentId: DOC },
      overridable: [],
    });
    const rel = find(exp.root, "v-rel") as SemanticNode;
    expect(rel.binding?.handle).toBe("connections-table");
    expect((find(exp.root, "v-map") as SemanticNode).binding?.handle).toBe("connections-map");
  });

  it("binds a planner P2 connections node at P1, so the web requests it", () => {
    const e = experienceOf([node("rel", "RelatedDocuments", "connections", "P2")], committed);
    const rel = find(detailWithVisuals(e, DOC).root, "v-rel") as SemanticNode;
    expect(rel.binding?.priority).toBe("P1");
  });

  it("drops a connections entry that binds a fact provider, and keeps a fact node beside connections", () => {
    const mixed = experienceOf(
      [
        node("bad", "RelatedDocuments", "fact-0"),
        node("kf", "KeyFigure", "fact-0"),
        node("rel", "RelatedDocuments", "connections"),
      ],
      committed,
    );
    const panel = find(detailWithVisuals(mixed, DOC).root, "visuals") as ContainerNode;
    expect(panel.children.map((c) => c.id)).toEqual(["v-kf", "v-rel"]);
  });

  it("is the static detail when the only nodes are connections entries that bind nothing real", () => {
    const e = experienceOf([node("bad", "ConnectionMap", "fact-0")], committed);
    expect(find(detailWithVisuals(e, DOC).root, "visuals")).toBeUndefined();
  });

  it("compiles for web and terminal with no findings", () => {
    for (const surface of ["web", "terminal"] as const) {
      const r = compile(detailWithVisuals(both(), DOC), {
        surface,
        catalog: mergedCatalog(),
        hydrationProjectionId: HYDRATION_PROJECTION_ID,
        hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
        viewer: {},
        placeholderKey: KEY,
      });
      expect(r.findings).toEqual([]);
    }
  });

  it("is never adopted for a chat turn (K7)", () => {
    const turn = { chatId: "00000000-0000-4000-8000-0000000000c1", ord: 1 };
    expect(turnWithVisuals(both(), turn, new Set([DOC]))).toBeNull();
  });
});

describe("hydrating connections", () => {
  const RAW: RawConnections = {
    documentId: DOC,
    related: [
      { documentId: REL, title: "Contract B", kinds: { entity: 1, reference: 0, similar: 0 }, strength: 0.8 },
    ],
    entities: [
      {
        entityId: "00000000-0000-4000-8000-0000000000e1",
        name: "Acme Corp",
        kind: "organization",
        documents: [{ documentId: REL, title: "Contract B" }],
      },
    ],
  };
  const views = createViews({ placeholderKey: KEY, revisionKey: "r".repeat(32) });
  const setup = () => {
    const head = both();
    const exp = views.documentExperience(DOC, head);
    const payload = views.documentPayload(DOC, head, "web");
    const load = (handle: string, params: Record<string, string | number> = {}) => ({
      experienceId: payload.experienceId,
      versionHash: payload.versionHash,
      handle,
      params,
    });
    return { exp, payload, load };
  };

  it("lists both handles in the served inventory and hydrates both from one read, under the owner's clearance", async () => {
    const { exp, payload, load } = setup();
    expect(payload.inventory.handles.map((h) => h.handle)).toEqual(
      expect.arrayContaining(["connections-table", "connections-map"]),
    );
    expect(payload.fingerprint.restrictedHandles).toEqual([]);
    const connections = vi.fn(async () => RAW);
    const [t, m] = await views.hydrateExperience(
      exp,
      [load("connections-table"), load("connections-map")],
      { connections } as unknown as UiReaders,
      "u",
      "document",
    );
    expect(connections).toHaveBeenCalledTimes(1);
    expect(connections).toHaveBeenCalledWith({ documentId: DOC });
    expect(t).toMatchObject({
      state: "ready",
      value: { rowKeys: [REL], rows: [["Contract B", "shares Acme Corp", 0.8]] },
    });
    expect(m).toMatchObject({ state: "ready", value: { layout: "network" } });
  });

  it("is refused without the owner's clearance, and never reads", async () => {
    const { exp, load } = setup();
    const connections = vi.fn(async () => RAW);
    const [t] = await views.hydrateExperience(
      exp,
      [load("connections-table")],
      { connections } as unknown as UiReaders,
      "u",
    );
    expect(t?.state).toBe("error");
    expect(connections).not.toHaveBeenCalled();
  });

  it("takes its document only from the server's view: a client parameter never reaches the reader", async () => {
    const { exp, load } = setup();
    const connections = vi.fn(async () => RAW);
    await views.hydrateExperience(
      exp,
      [load("connections-table", { documentId: OTHER })],
      { connections } as unknown as UiReaders,
      "u",
      "document",
    );
    expect(connections).not.toHaveBeenCalledWith({ documentId: OTHER });
  });

  it("gives a failing read its own error state while another widget still renders", async () => {
    const { exp, load } = setup();
    const connections = vi.fn(async () => {
      throw new Error("down");
    });
    const [t] = await views.hydrateExperience(
      exp,
      [load("connections-table")],
      { connections } as unknown as UiReaders,
      "u",
      "document",
    );
    expect(t?.state).toBe("error");
  });

  it("answers an empty library with the empty states", async () => {
    const { exp, load } = setup();
    const connections = vi.fn(async () => ({ documentId: DOC, related: [], entities: [] }));
    const [t, m] = await views.hydrateExperience(
      exp,
      [load("connections-table"), load("connections-map")],
      { connections } as unknown as UiReaders,
      "u",
      "document",
    );
    expect(t).toMatchObject({ state: "ready", value: { rows: [["No connected documents yet", "", ""]] } });
    expect(m).toMatchObject({ state: "ready" });
    expect((m as { value: { nodes: unknown[] } }).value.nodes).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @docmind/experiences exec vitest run src/connectionsView.test.ts`
Expected: FAIL (the nodes are dropped; `connections-table` is not a provider).

- [ ] **Step 7: Add the catalogue entries and the adoption**

In `packages/experiences/src/visuals.ts`:

1. Replace `  ["FactTable", "Table"],\n] as const;` with:
```ts
  ["FactTable", "Table"],
  ["RelatedDocuments", "Table"],
  ["ConnectionMap", "Diagram"],
] as const;
```
2. Replace `  Table: [],\n};` (inside `PROPS`) with `  Table: [],\n  Diagram: ["timeFormat"],\n};`.

In `packages/experiences/src/views.ts`:

1. After `import { type Child, build, panel, tabs, widget } from "./compose";` add:
```ts
import { CONNECTION_HANDLE, bindsConnections, connectionsProvider, isConnectionEntry } from "./connections";
```
2. In `interface Adopt<R extends FactRef>`, after `provider(ref: R, entry: VisualEntry): ProviderSpec;` add:
```ts
  /** The document page only: connections entries are adopted onto providers made from this (the server's own) document id. */
  connections?: { documentId: string };
```
3. In `adoptVisuals`' `copy`, replace the line `    const ref = n.binding ? o.refOf(visuals, n.binding.handle) : null;` with:
```ts
    if (o.connections !== undefined && isConnectionEntry(n.type)) {
      // A connections entry binds the connections capability and nothing else; its provider is generated, never the planner's.
      if (!n.binding || !bindsConnections(visuals, n.binding.handle)) return null;
      const handle = CONNECTION_HANDLE[n.type];
      providers[handle] ??= connectionsProvider(o.connections.documentId, n.type);
      const priority = n.binding.priority === "P0" ? "P0" : "P1";
      return { ...n, id: `v-${n.id}`, binding: { ...n.binding, handle, priority } };
    }
    const ref = n.binding ? o.refOf(visuals, n.binding.handle) : null;
```
4. In `detailWithVisuals`, replace `      provider: (r, entry) => factProvider(r.ordinal, documentId, entry),\n    },` with `      provider: (r, entry) => factProvider(r.ordinal, documentId, entry),\n      connections: { documentId },\n    },`.

Update the existing catalogue assertion in `packages/experiences/src/visuals.test.ts`: in the `resolves every entry on web and terminal to a framework kind` test, replace the expected list with
```ts
    ).toEqual([
      ["FigureChart", "BarChart"],
      ["FigureTrend", "TimeSeries"],
      ["KeyFigure", "Kpi"],
      ["FactTable", "Table"],
      ["RelatedDocuments", "Table"],
      ["ConnectionMap", "Diagram"],
    ]);
```

- [ ] **Step 8: Run all experiences tests, then the dependants**

Run: `pnpm --filter @docmind/experiences test && pnpm --filter @docmind/experiences build && pnpm --filter @docmind/web test && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: PASS. If `compile` reports a finding for the `terminal` surface, its code names the cause (the terminal registry knows `Diagram`: `loom-ui/packages/renderer-terminal/src/registry.ts`); the entry's kind contract must equal loom-ui's `diagramKindContracts` (`{ kind: "Diagram", props: ["timeFormat"], binding: "required" }`).

- [ ] **Step 9: Commit**

```bash
git add packages/experiences
git commit -m "feat(visuals): RelatedDocuments and ConnectionMap entries, reshapers and adoption

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uGukQihQRMMZgAPLXQiX6"
```

---

### Task 5: Planning and rollout (capability, intent, fingerprint, NULL-format stale)

**Files:**
- Modify: `apps/server/app/flows/visualize-document/plan.ts` (capabilities, `VISUALS_INTENT`)
- Modify: `packages/experiences/src/providers.ts` (`factFormatFingerprint`), `providers.test.ts`
- Create: `infra/migrations/0032_stale_format_null.sql`
- Modify (comments): `apps/server/app/flows/visualize-document/start.ts`, `runs.ts`
- Modify (tests): `apps/server/app/flows/visualize-document/plan.test.ts`, `runs.pg.test.ts`

**Interfaces:**
- Consumes (Task 2): `visualCapabilities(facts)`, `PINS["doc.connections"]`.
- Produces:
  - `planVisuals(planner, facts, ctx)` offers `visualCapabilities(facts)` (facts, then `connections`).
  - `factFormatFingerprint(): string` = `` `${PINS["visual.facts"]}+${PINS["turn.facts"]}+${PINS["doc.connections"]}` `` (about 90 characters, inside the `format` column's 200).
  - SQL function `docmind_visual_stale_format_documents(p_after uuid, p_limit integer, p_format text)`: same signature and columns; lists `state = 'done' AND format IS DISTINCT FROM p_format` (so NULL is stale).

- [ ] **Step 1: Write the failing tests**

Replace `packages/experiences/src/providers.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { PINS, factFormatFingerprint } from "./providers";

describe("factFormatFingerprint", () => {
  it("is stable and names the pins of both fact tools and of the connections tool", () => {
    expect(factFormatFingerprint()).toBe(factFormatFingerprint());
    expect(factFormatFingerprint()).toBe(
      `${PINS["visual.facts"]}+${PINS["turn.facts"]}+${PINS["doc.connections"]}`,
    );
    expect(factFormatFingerprint().length).toBeLessThanOrEqual(200);
  });

  it("changes when any of the three pins changes, and not when another pin does", () => {
    const saved = { ...PINS };
    const mut = PINS as Record<string, string>;
    try {
      const before = factFormatFingerprint();
      mut["visual.facts"] = "docmind:visual.facts@2";
      const afterVisual = factFormatFingerprint();
      expect(afterVisual).not.toBe(before);
      mut["turn.facts"] = "docmind:turn.facts@2";
      const afterTurn = factFormatFingerprint();
      expect(afterTurn).not.toBe(afterVisual);
      mut["doc.connections"] = "docmind:doc.connections@2";
      expect(factFormatFingerprint()).not.toBe(afterTurn);
      Object.assign(mut, saved);
      mut["documents.list"] = "docmind:documents.list@9";
      expect(factFormatFingerprint()).toBe(before);
    } finally {
      Object.assign(mut, saved);
    }
  });
});
```

In `apps/server/app/flows/visualize-document/plan.test.ts`:

1. Add to the import `import { VISUALS_CATALOG, capabilitiesOf } from "@docmind/experiences";` the name `visualCapabilities`: `import { VISUALS_CATALOG, capabilitiesOf, visualCapabilities } from "@docmind/experiences";`.
2. After `const EMPTY_JSON = draft([]);` add:
```ts
const CONNECTIONS_NODE = {
  id: "related",
  type: "RelatedDocuments",
  label: "Related documents",
  span: 12,
  props: {},
  binding: { capability: "connections", arguments: {}, path: "", priority: "P1" },
};
```
3. Append inside the file (shell `cat >>`):

```ts

describe("planVisuals offers the live connections", () => {
  it("binds a RelatedDocuments node to the connections capability beside a fact node", async () => {
    const ctx = recording();
    const model = scriptedPlannerModel([draft([NODE, CONNECTIONS_NODE], "A figure and its neighbours")]);
    const plan = await planVisuals(new ReferencePlanner({ model, modelId: "t" }), [FIGURE], ctx);
    expect(plan.findings.filter((f) => f.severity === "error")).toEqual([]);
    const ops = JSON.stringify(plan.ops);
    expect(ops).toContain("RelatedDocuments");
    expect(ops).toContain("connections");
    expect(ctx.decisions.size).toBe(1);
  });

  it("offers the facts first and connections last, and always connections", () => {
    expect(visualCapabilities([FIGURE]).map((c) => c.handle)).toEqual(["fact-0", "connections"]);
    expect(visualCapabilities([]).map((c) => c.handle)).toEqual(["connections"]);
  });

  it("tells the planner connections are live, bind no fact, and belong in a compact section when material is or may be related", () => {
    const o = VISUALS_INTENT.objective;
    expect(o).toContain("Every widget binds one fact, except RelatedDocuments and ConnectionMap");
    expect(o).toContain("live connections capability");
    expect(o).toContain("compact Connections section");
    expect(o).toContain("is likely to gain, related material");
  });
});
```

In `apps/server/app/flows/visualize-document/runs.pg.test.ts`:

1. Add `import { factFormatFingerprint } from "@docmind/experiences";` as the first import line.
2. Replace the test title `it("docmind_visual_stale_format_documents lists done runs with a different non-null format, across tenants, paged, ids only"` with `it("docmind_visual_stale_format_documents lists done runs with a different or no format (NULL is stale since 0032), across tenants, paged, ids only"`.
3. Replace `    const unstamped = await readyDoc(); // done, format NULL (a row from before the column): not stale` with `    const unstamped = await readyDoc(); // done, format NULL (a row from before the column): stale since 0032`.
4. Replace `    expect(all.map((d) => d.documentId)).toEqual([stale.id, staleB.id].sort());` with `    expect(all.map((d) => d.documentId)).toEqual([stale.id, staleB.id, unstamped.id].sort());`.
5. Replace
```ts
    const first = await list(NIL, 1);
    const second = await list(first[0]?.documentId as string, 1);
    expect([first[0]?.documentId, second[0]?.documentId]).toEqual([stale.id, staleB.id].sort());
    expect(await list(second[0]?.documentId as string, 1)).toEqual([]);
```
with
```ts
    const first = await list(NIL, 1);
    const second = await list(first[0]?.documentId as string, 1);
    const third = await list(second[0]?.documentId as string, 1);
    expect([first[0]?.documentId, second[0]?.documentId, third[0]?.documentId]).toEqual(
      [stale.id, staleB.id, unstamped.id].sort(),
    );
    expect(await list(third[0]?.documentId as string, 1)).toEqual([]);
```
6. Replace `    expect((await list(NIL, 100)).map((d) => d.documentId)).toEqual([staleB.id]);` with `    expect((await list(NIL, 100)).map((d) => d.documentId)).toEqual([staleB.id, unstamped.id].sort());`.
7. Before the line `  it("the retry list leaves out a document whose generation moved on, a user being erased, and answers nothing to a null (STRICT)", async () => {` insert:

```ts
  it("lists a NULL-format done run for the current fingerprint until a done run stamps it, then never again (the re-plan happens once)", async () => {
    await owner.query("DELETE FROM documents");
    const d = await readyDoc();
    const at = (run: number) => ({ userId: U1, documentId: d.id, generation: d.g, run });
    await runs.record(at(0), "done"); // a run from before the column: no format
    const list = pgStaleFormatDocuments(app); // the current fingerprint
    expect((await list(NIL, 10)).map((x) => x.documentId)).toEqual([d.id]);
    await runs.record(at(1), "running"); // the boot pass starts the re-plan
    expect(await list(NIL, 10)).toEqual([]); // a running run is not `done`: not listed again mid-run
    await runs.record(at(1), "done", undefined, factFormatFingerprint());
    expect(await list(NIL, 10)).toEqual([]);
    expect(await pgStaleFormatDocuments(app, "docmind:other@2")(NIL, 10)).toHaveLength(1);
  });

```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @docmind/experiences exec vitest run src/providers.test.ts` (FAIL: fingerprint lacks the pin), and `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/plan.test.ts app/flows/visualize-document/runs.pg.test.ts` (FAIL: capabilities/intent assertions; `unstamped` not listed).

- [ ] **Step 3: Implement the fingerprint, the capability and the intent**

In `packages/experiences/src/providers.ts` replace the doc comment line
` * The identity of the fact format visuals are planned over: the pins of the two fact tools, as one short canonical string.`
with
` * The identity of the format visuals are planned over: the pins of the two fact tools and of the connections tool, as one short canonical string.`
and replace the function body line `  return \`${PINS["visual.facts"]}+${PINS["turn.facts"]}\`;` with
```ts
  return `${PINS["visual.facts"]}+${PINS["turn.facts"]}+${PINS["doc.connections"]}`;
```

In `apps/server/app/flows/visualize-document/plan.ts`:

1. Replace `import { VISUALS_CATALOG, capabilitiesOf } from "@docmind/experiences";` with `import { VISUALS_CATALOG, visualCapabilities } from "@docmind/experiences";`.
2. Replace the objective string with:
```ts
  objective:
    "Help a reader grasp this document at a glance. Show only what a visual makes clearer than prose. Prefer fewer widgets. Every widget binds one fact, except RelatedDocuments and ConnectionMap, which bind the live connections capability: it may grow, so include a compact Connections section when the document has, or is likely to gain, related material.",
```
3. Replace `): Promise<PlanResult> => composeVisuals(planner, VISUALS_INTENT, capabilitiesOf(facts), ctx);` with `): Promise<PlanResult> => composeVisuals(planner, VISUALS_INTENT, visualCapabilities(facts), ctx);`.

- [ ] **Step 4: The migration and the comments**

Create `infra/migrations/0032_stale_format_null.sql`:

```sql
-- 0032: for this release a done visualize run with NO recorded format counts as stale (document connections, K6). The fact-format
-- fingerprint gained the connections pin, and every visualized document needs one re-plan (over its stored facts, no extraction)
-- to add the Connections section: the runs that predate the `format` column have a NULL format and 0030's function skipped them.
-- A re-plan that ends `done` stamps the new fingerprint (the event feed), so each document is listed once. Same signature and
-- columns as 0030's function (CREATE OR REPLACE keeps the grants); only the format test changes, from
-- `format IS NOT NULL AND format <> p_format` to `format IS DISTINCT FROM p_format`. STRICT still answers nothing to a NULL argument.
-- A later release returns to "NULL is not stale" with its own migration; 0030 is not edited.
CREATE OR REPLACE FUNCTION public.docmind_visual_stale_format_documents(p_after uuid, p_limit integer, p_format text)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
    JOIN public.visual_runs r ON r.document_id = d.id AND r.generation = d.ingest_generation
   WHERE d.id > p_after
     AND r.state = 'done' AND r.format IS DISTINCT FROM p_format
     AND EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND NOT s.erased
          AND s.state ->> 'status' = 'ready'
          AND s.execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text
              || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
REVOKE ALL ON FUNCTION public.docmind_visual_stale_format_documents(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_visual_stale_format_documents(uuid, integer, text) TO docmind_app;
```

Comment updates (no behaviour change), exact replacements:
- `apps/server/app/flows/visualize-document/start.ts`: ` * other than \`format\` (default: the current fingerprint). A NULL format is not stale.` with ` * other than \`format\` (default: the current fingerprint). A NULL format counts as stale for the connections release (migration 0032).`; and `(migration 0030's stamp; a NULL stamp is never stale)` with `(migration 0030's stamp; a NULL stamp counts as stale, migration 0032)`.
- `apps/server/app/flows/visualize-document/runs.ts`: `A NULL stamp is never stale.` with `A NULL stamp counts as stale (migration 0032), so a document never stamped is re-planned at each boot until a live end event stamps it.`

- [ ] **Step 5: Run the suites**

Run: `pnpm --filter @docmind/experiences test && pnpm --filter @docmind/experiences build && set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/flows/visualize-document app/db` then `pnpm typecheck && pnpm typecheck:tests && pnpm lint`.
Expected: PASS, the pg tests running (not skipped). `app/db/tenancy.test.ts` still passes (the function keeps its owner and grants).

- [ ] **Step 6: Commit**

```bash
git add apps/server/app/flows/visualize-document packages/experiences/src/providers.ts packages/experiences/src/providers.test.ts infra/migrations/0032_stale_format_null.sql
git commit -m "feat(visuals): always offer connections to the planner; re-plan NULL-format runs once (0032)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uGukQihQRMMZgAPLXQiX6"
```

---

### Task 6: The Open row action navigates

**Files:**
- Modify: `packages/contracts/src/intents.ts`, `intents.test.ts`
- Modify: `apps/web/src/components/dm-doc-detail.ts`
- Test: `apps/web/src/components/dm-doc-detail.test.ts`

**Interfaces:**
- Consumes (Task 4): the served value of handle `connections-table`: `{ rowKeys: string[] }` (document ids).
- Produces: `intentOf("detail", { type: "TABLE_ROW_ACTION", payload: { action: "open", rowKey } }, held)` returns `{ type: "document.open", id }` when `held.rowKeys` contains `rowKey` (case-insensitive, held spelling); any other action name, an unheld key or a non-uuid key is `undefined`. `dm-doc-detail` passes the served `connections-table` row keys as `held.rowKeys`, and the existing `performIntent` navigates (`router.navigate({ name: "document", id })`, i.e. `/documents/<id>`; the destination page is owner-checked by the existing routes).

- [ ] **Step 1: Write the failing tests**

In `packages/contracts/src/intents.test.ts`:

1. Replace `    expect(intentOf("detail", row("open", A), held)).toBeUndefined();` (inside "a row action on a view that has no table...") with `    expect(intentOf("detail", row("open", A))).toBeUndefined(); // nothing held: a row action means nothing`.
2. Append (shell `cat >>`):

```ts

describe("intentOf: the document's Related documents table", () => {
  it("opens a related document whose row key the surface holds, in the held spelling", () => {
    expect(intentOf("detail", row("open", A), held)).toEqual({ type: "document.open", id: A });
    expect(intentOf("detail", row("open", A.toUpperCase()), held)).toEqual({
      type: "document.open",
      id: A,
    });
  });
  it("refuses a key that was not served, a non-uuid key, and every other row action", () => {
    expect(
      intentOf("detail", row("open", "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a99"), held),
    ).toBeUndefined();
    expect(intentOf("detail", row("open", "nope"), { rowKeys: ["nope"] })).toBeUndefined();
    for (const a of ["ask", "retry", "delete", "rename", "__proto__"])
      expect(intentOf("detail", row(a, A), held)).toBeUndefined();
    expect(intentOf("detail", row("open", A), { rowKeys: [] })).toBeUndefined();
  });
  it("does not make a turn's visuals actionable", () => {
    expect(intentOf("turn", row("open", A), held)).toBeUndefined();
  });
});
```

Append to `apps/web/src/components/dm-doc-detail.test.ts` (shell `cat >>`):

```ts

describe("dm-doc-detail: the Related documents Open action", () => {
  const action = (rowKey: string, name = "open") => ({
    type: "TABLE_ROW_ACTION",
    widgetId: "v-related",
    payload: { action: name, rowKey },
  });
  type Answer = { ok: boolean; reason?: string } | undefined;
  async function served() {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(deepText(view(page))).toContain("Ready"));
    // The fake UI plane serves no planned visuals; what the table "served" is what the session reads.
    const session = view(page).session as unknown as { valueOf(h: string): unknown };
    const real = session.valueOf.bind(session);
    vi.spyOn(session, "valueOf").mockImplementation((h: string) =>
      h === "connections-table" ? { rowKeys: [id(7)] } : real(h),
    );
    const act = view(page).onAct as (a: unknown) => Promise<Answer>;
    return { t, act };
  }

  it("opens the related document whose row key the served table holds", async () => {
    const { t, act } = await served();
    expect(await act(action(id(7)))).toEqual({ ok: true });
    expect(t.services.router.route).toEqual({ name: "document", id: id(7) });
  });

  it("refuses a row key the table did not serve, and any other row action, and stays on the page", async () => {
    const { t, act } = await served();
    expect(await act(action(id(8)))).toEqual({ ok: false, reason: "refused" });
    expect(await act(action(id(7), "delete"))).toEqual({ ok: false, reason: "refused" });
    expect(await act(action(id(7), "ask"))).toEqual({ ok: false, reason: "refused" });
    expect(t.services.router.route).toEqual({ name: "document", id: id(1) });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @docmind/contracts exec vitest run src/intents.test.ts && pnpm --filter @docmind/web exec vitest run src/components/dm-doc-detail.test.ts`
Expected: FAIL (the detail view refuses row actions; the page passes no row keys).

- [ ] **Step 3: Implement**

In `packages/contracts/src/intents.ts`, in `case "detail":` replace
```ts
      if (type === "REF_OPEN") return refOpen(p);
      if (type !== "A2UI_ACTION") return undefined;
```
with
```ts
      if (type === "REF_OPEN") return refOpen(p);
      if (type === "TABLE_ROW_ACTION") {
        // The Related documents table (the document's connections): its one action opens that document. The key must be one
        // the surface was served; any other action name is refused.
        if (own(p, "action") !== "open") return undefined;
        const id = heldId(own(p, "rowKey"), held);
        return id === undefined ? undefined : { type: "document.open", id };
      }
      if (type !== "A2UI_ACTION") return undefined;
```

In `apps/web/src/components/dm-doc-detail.ts`, in `private act`, replace
```ts
    const intent: Intent | undefined = intentOf("detail", a, { list: questions });
```
with
```ts
    // The Related documents table's row keys, as the server served them in its value: never the action's own claim.
    const related = this.session?.valueOf("connections-table") as { rowKeys?: unknown } | undefined;
    const rowKeys = Array.isArray(related?.rowKeys)
      ? (related.rowKeys as unknown[]).filter((k): k is string => typeof k === "string")
      : [];
    const intent: Intent | undefined = intentOf("detail", a, { list: questions, rowKeys });
```

- [ ] **Step 4: Run, build and check**

Run: `pnpm --filter @docmind/contracts exec vitest run src/intents.test.ts && pnpm --filter @docmind/contracts build && pnpm --filter @docmind/web test && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/intents.ts packages/contracts/src/intents.test.ts apps/web/src/components/dm-doc-detail.ts apps/web/src/components/dm-doc-detail.test.ts
git commit -m "feat(web): the Related documents Open action navigates to the document

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uGukQihQRMMZgAPLXQiX6"
```

---

### Task 7: End to end, and documentation

**Files:**
- Modify: `apps/server/app/documents/visuals.e2e.pg.test.ts` (planner stub with connections, upload name, the new test)
- Modify: `docs/architecture.md`, `docs/codebase-guide.md`, `docs/operations/cloud-deploy.md`

**Interfaces:**
- Consumes: everything above; `startIngestStack({ visuals: true })` (`documents/ingestStack.ts`), `IngestStack.db.owner` (owner-role pool), `IngestStack.fields`, `IngestStack.durable.raw.eventStore.listExecutions?()`, the file's helpers `upload`, `detail`, `hydrate`, `visualizeOutcome`.
- Produces: the acceptance test of the spec's end-to-end line, and the written documentation.

- [ ] **Step 1: Teach the visuals stub to plan connections, and the upload helper a name**

In `apps/server/app/documents/visuals.e2e.pg.test.ts`:

1. Add the import `import { randomUUID } from "node:crypto";` and `import { entityNameBind } from "../flows/ingest-document/pgEntities";` (keep imports sorted: `node:` first; the entity import after the `lineage` imports).
2. Replace `function stubVisuals(claude: FakeAnthropic, figures: Figure[], down?: { value: boolean }) {` with:
```ts
const CONNECTION_NODES = [
  {
    id: "related",
    type: "RelatedDocuments",
    label: "Related documents",
    span: 12,
    props: {},
    binding: { capability: "connections", arguments: {}, path: "", priority: "P1" },
  },
  {
    id: "map",
    type: "ConnectionMap",
    label: "Connection map",
    span: 12,
    props: {},
    binding: { capability: "connections", arguments: {}, path: "", priority: "P1" },
  },
];

function stubVisuals(
  claude: FakeAnthropic,
  figures: Figure[],
  down?: { value: boolean },
  connections = false,
) {
```
3. Replace `        summary: "A headline figure",\n        nodes: [` with `        summary: "A headline figure",\n        nodes: [\n          ...(connections ? CONNECTION_NODES : []),`.
4. Replace `    opts: { visuals: boolean } = { visuals: true },` with `    opts: { visuals: boolean; name?: string } = { visuals: true },` and `      const res = await st.upload(cookie, "report.txt", Buffer.from(text));` with `      const res = await st.upload(cookie, opts.name ?? "report.txt", Buffer.from(text));`.

- [ ] **Step 2: Write the end-to-end test**

Append as the last test of the `describe` (Edit: replace the final `  }, 180_000);\n});` of the file with the same text preceded by the new test, i.e. insert the following before the closing `});`):

```ts

  it("connections are live: A shows B once B shares an entity with it, with no re-plan of A, and nothing after B is deleted", async () => {
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    stubVisuals(st.visualsClaude as FakeAnthropic, [ADA, BEN], undefined, true);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const a = await upload(st, ada.cookie, "Revenue was 1,200 in 2024", { visuals: true, name: "alpha.txt" });
    expect(await visualizeOutcome(st, ada.userId, a)).toBe("done");

    type Table = { rows: string[][]; rowKeys?: string[] };
    type Map = { nodes: { id: string; label: string; group: string }[] };
    const table = async () =>
      (await hydrate(st, ada.cookie, a, "connections-table")) as { state: string; value: Table };
    const map = async () =>
      (await hydrate(st, ada.cookie, a, "connections-map")) as { state: string; value: Map };
    const visualizeRuns = async () =>
      ((await st.durable.raw.eventStore.listExecutions?.()) ?? []).filter((e) =>
        e.includes(`visualize-${a}`),
      );

    // A, uploaded first, already has the section, empty.
    expect((await table()).value.rows).toEqual([["No connected documents yet", "", ""]]);
    expect((await map()).value.nodes.map((n) => n.group)).toEqual(["self"]);
    const before = {
      runs: await visualizeRuns(),
      version: UiViewResponse.parse(await (await detail(st, ada.cookie, a)).json()).versionHash,
    };
    expect(before.runs).toHaveLength(1);

    // B arrives and shares an entity with A (the ingest here has no entity model, so the rows are the ones it would write).
    const b = await upload(st, ada.cookie, "Zebra takings were 7,391.25 in 2024", { visuals: true, name: "bravo.txt" });
    const chunkOf = async (id: string) =>
      (
        await st.db.owner.query("SELECT id FROM chunks WHERE document_id = $1 ORDER BY ordinal LIMIT 1", [id])
      ).rows[0].id as string;
    const [ca, cb] = [await chunkOf(a), await chunkOf(b)];
    const entityId = randomUUID();
    await st.db.owner.query(
      "INSERT INTO entities (id, tenant_id, owner_id, kind, name_enc, name_key) VALUES ($1, $2, $3, 'organization', $4::jsonb, $5)",
      [
        entityId,
        ada.tenantId,
        ada.userId,
        JSON.stringify(await st.fields.forUser(ada.userId).seal(entityNameBind(entityId), "Acme Corp")),
        randomUUID().replaceAll("-", "").repeat(2),
      ],
    );
    for (const c of [ca, cb])
      await st.db.owner.query(
        "INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id) VALUES ($1, $2, $3)",
        [ada.tenantId, c, entityId],
      );
    for (const [s, d] of [
      [ca, cb],
      [cb, ca],
    ])
      await st.db.owner.query(
        "INSERT INTO chunk_links (tenant_id, src_chunk_id, dst_chunk_id, kind, weight) VALUES ($1, $2, $3, 'entity', 0.8) ON CONFLICT DO NOTHING",
        [ada.tenantId, s, d],
      );

    const titleOfB = (
      (await (await get(st, ada.cookie, `/api/documents/${b}`)).json()) as { title: string }
    ).title;
    const live = await table();
    expect(live.state).toBe("ready");
    expect(live.value.rowKeys).toEqual([b]);
    expect(live.value.rows[0]?.[0]).toBe(titleOfB);
    expect(live.value.rows[0]?.[1]).toContain("Acme Corp");
    const liveMap = (await map()).value.nodes;
    expect(liveMap.some((n) => n.group === "document" && n.label === titleOfB)).toBe(true);
    expect(liveMap.some((n) => n.group === "entity" && n.label === "Acme Corp")).toBe(true);

    // No re-plan of A: the same visualize executions and the same served experience.
    expect(await visualizeRuns()).toEqual(before.runs);
    expect(UiViewResponse.parse(await (await detail(st, ada.cookie, a)).json()).versionHash).toBe(
      before.version,
    );

    // Another user cannot read A's connections.
    const other = await st.signUpAndLogIn("other@example.com");
    const view = UiViewResponse.parse(await (await detail(st, ada.cookie, a)).json());
    const foreign = await fetch(`${st.base}/api/ui/hydrate`, {
      method: "POST",
      headers: { cookie: other.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        document: a,
        requests: [
          { experienceId: view.experienceId, versionHash: view.versionHash, handle: "connections-table", params: {} },
        ],
      }),
    });
    expect(foreign.status).toBe(404);

    // Deleting B removes it.
    const del = await fetch(`${st.base}/api/documents/${b}`, {
      method: "DELETE",
      headers: { cookie: ada.cookie },
    });
    expect(del.status).toBe(204);
    expect((await table()).value.rows).toEqual([["No connected documents yet", "", ""]]);
    expect((await map()).value.nodes.map((n) => n.group)).toEqual(["self"]);
  }, 180_000);
```

- [ ] **Step 3: Run it**

Run: `pnpm build && set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/documents/visuals.e2e.pg.test.ts`
Expected: PASS with every test running (not skipped). If the first `visualizeRuns()` length is not 1, print `listExecutions()` and adjust the `includes` filter to the execution-id shape in `visualizeExecutionId` (`visualize-<id>`, re-runs `-r<n>`, generations `.<g>`).

- [ ] **Step 4: Documentation**

`docs/architecture.md` (section 7.1, document visuals). Apply these exact replacements:
1. `the pins of the \`visual.facts\` and \`turn.facts\` tools; written by the event-feed sink only` with `the pins of the \`visual.facts\`, \`turn.facts\` and \`doc.connections\` tools; written by the event-feed sink only`.
2. `with a non-NULL format that differs from the current one (it re-plans over the stored facts and restamps; NULL, from before the column, is never stale)` with `with a format that differs from the current one, or none (it re-plans over the stored facts and restamps; since migration 0032 a NULL format counts as stale, so the first boot after the connections release re-plans every visualized document once: one planner call each, at most 2 at a time, no extraction; a document whose end event is lost stays NULL and is re-planned again at the next boot until a live end event stamps it)`.
3. Insert before the line starting `- **Retry.** \`POST /api/documents/:id/visuals/retry\``:

```
- **Connections.** The Visuals tab can show how a document relates to the rest of the owner's library, as live data rather than stored facts. The planner is always offered a `connections` capability (tool `doc.connections`, pin `docmind:doc.connections@1`, sensitive) beside the fact capabilities, and may bind `RelatedDocuments` (a Table with an "Open" row action) and `ConnectionMap` (a Diagram, network layout, at most 21 nodes). `detailWithVisuals` serves them from providers it generates (`connections-table`, `connections-map`) whose only argument is the server's own document id and which nothing can override; hydration is under the owner's `sensitive` clearance. One owner-scoped query (`ui/connections.ts`, `readConnections`) reads `chunk_links`, `chunk_entities`, `entities`, `chunks` and `documents` for ready, live documents of the owner (readiness from the status read model): up to 8 related documents (links grouped per document, by strength, link count, id) and up to 12 shared entities (rarest first, up to 5 documents each); titles and entity names are opened with the owner's key, an entity whose name does not open is dropped, and nothing is logged. A new upload or a deletion changes what the next hydrate returns and needs no re-plan. An empty library shows the empty states (a table with one "No connected documents yet" row, a map of a single node). Chat turns never offer connections. `Open` is answered by `intentOf("detail")` as `document.open` for a row key the served table holds, and the web navigates to `/documents/<id>`. The web registers loom-ui's opt-in `@loom-ui/renderer-lit/diagram` entry (`createViewRegistry`).
```

`docs/codebase-guide.md`: replace `| \`apps/server/app/ui/\` | \`GET /api/ui/views/:view\` and \`POST /api/ui/hydrate\`: compiled experiences and their owner-scoped readers |` with `| \`apps/server/app/ui/\` | \`GET /api/ui/views/:view\` and \`POST /api/ui/hydrate\`: compiled experiences and their owner-scoped readers (\`connections.ts\`: a document's related documents and shared entities) |`.

`docs/operations/cloud-deploy.md`: after the line `- The migration connection must be direct or session-mode, not a transaction pooler (cloud-scaling.md S8).` add:

```
- Migration `0032` (document connections) replaces one SECURITY DEFINER function and stores nothing new. With the `visuals`
  role on, the first boot after it re-plans every visualized document once (one planner call each over its stored facts, at
  most 2 at a time, no extraction) to add the Connections section; it is stamped, so later boots do not repeat it.
```

- [ ] **Step 5: Full verification**

Run, from the worktree root, in order:
```bash
pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm build
set -a; . ./.env; set +a
pnpm --filter @docmind/contracts test
pnpm --filter @docmind/experiences test
pnpm --filter @docmind/server test
pnpm --filter @docmind/web test
```
Expected: all pass; the server run shows the pg suites (`connections.pg.test.ts`, `runs.pg.test.ts`, `visuals.e2e.pg.test.ts`, `tenancy.test.ts`) executed, none skipped.

- [ ] **Step 6: Commit**

```bash
git add apps/server/app/documents/visuals.e2e.pg.test.ts docs/architecture.md docs/codebase-guide.md docs/operations/cloud-deploy.md
git commit -m "test(visuals): connections end to end; docs(visuals): document connections

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uGukQihQRMMZgAPLXQiX6"
```

---

## Self-Review

**1. Spec coverage** (spec section -> task):

| Spec | Task |
|---|---|
| 1 Goal; K1 connections only; K7 documents only | 1-7; K7 tests: Task 2 (`factCapabilities` has no connections), Task 4 (`turnWithVisuals` drops) |
| K2 live binding, planner binds once | Task 2 (provider, capability), Task 4 (adoption generates providers), Task 7 (no re-plan assertion) |
| K3 existing data only, no new stored data | Task 1 (query over existing tables; no data migration); Task 5 migration 0032 replaces a function only (Plan decision 9) |
| 3 provider `doc.connections`, pin, args from the server view, `sensitive` clearance | Task 2 (pin, `ARGS`, `OWNER_READ`), Task 4 ("takes its document only from the server's view", "refused without clearance") |
| 3 the owner-scoped query: related (8, kinds, strength, order) and entities (12, 5, rarest first) | Task 1 |
| 3 decryption with `fields.forUser`, entity dropped when the name does not open, gone document absent | Task 1 (tests "drops an entity...", deleted-document test) |
| 3 performance and the 500-document `EXPLAIN` | Task 1 (second `describe`) |
| K4, 4 catalogue entries `RelatedDocuments` (Table), `ConnectionMap` (Diagram network) | Task 4 |
| 4 table columns, "Why", row key, "Open" `TABLE_ROW_ACTION`, empty state | Task 4 reshaper + tests; Task 6 (navigation) |
| 4 map nodes, groups, edges, 21 cap, prefixes, `diagramProblems`, empty single node | Task 4 |
| 4 no fact refs | Task 4 (`refs` undefined assertions) |
| 4 web registers `@loom-ui/renderer-lit/diagram`, element-registration test | Task 3 |
| K5, 5 capability always offered; widgets show an empty state | Task 2 (`visualCapabilities`), Task 4/7 (empty states) |
| 5 `VISUALS_INTENT` sentence | Task 5 (Plan decision 8) |
| K6, 5 fingerprint includes the connections pin; NULL-format stale once; at most 2 at a time; stamped | Task 5 (fingerprint, 0032, "re-plan happens once" test); the 2-at-a-time bound is the existing `PLANNER_CONCURRENCY`/`SWEEP_EXECUTIONS` and is unchanged |
| 6 errors: a failed query gives that widget its own error state | Task 4 ("gives a failing read its own error state") |
| 6 reshapers never throw on empty data | Task 4 |
| 6 privacy: owner-scoped, decrypted only into rendered values, nothing logged, no new stored data | Task 1 (`catch` logs nothing), Task 7 (other user 404) |
| 6 testing: reshaper unit, pg query, hydration (clearance, args), e2e, web, boot | Tasks 4, 1, 4, 7, 3 and 6, 5 |
| 7 out of scope | not built |

Gaps found while checking: none left open. Spec/code conflicts, recorded as Plan decisions: ready from the read model not `documents.status` (2); Table has no visible caption (6); `document.open` for the detail view needed an `intentOf` change that reverses an existing test (10); the stale-format definer needs migration 0032 although K3 says "no migration" (9); a document with no extracted facts ends the visualize flow `empty` before planning (`runVisualize`), so it gets no Connections section; the spec does not address this and the plan leaves that flow unchanged (changing it would add a planner call for every fact-less document).

**2. Placeholder scan:** no "TBD", "TODO", "implement later" or "similar to Task N"; every code step shows the code; every command is exact.

**3. Type consistency:** `RawConnections`, `ConnectionDocument`, `CONNECTIONS_CAPS` (Task 1) are used with those names in Tasks 2, 4 and 7. `CONNECTION_HANDLE`, `CONNECTION_ENTRIES`, `isConnectionEntry`, `connectionsProvider(documentId, entry)`, `bindsConnections(visuals, handle)`, `clipConnections`, `connectionsCapability()`, `visualCapabilities(facts)` (Task 2) match their uses in Tasks 4 and 5. Handles `connections` (planner), `connections-table` and `connections-map` (served, and reshaper names) are the same in Tasks 2, 4, 6 and 7. `EMPTY_RELATED` = "No connected documents yet" in the shapes (Task 4), the unit tests and the e2e test (Task 7). `readConnections(deps, who, documentId)` (Task 1) is what the reader calls (Task 2). `createViewRegistry` (Task 3) is the only registry factory the web uses.
