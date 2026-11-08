import { randomUUID } from "node:crypto";
import { withTenant } from "../db/tenant";
import { ingestExecutionId } from "../documents/ingest";
import { insertDocument, titleBind } from "../documents/repo";
import { newDocument, seedRow } from "../documents/testHarness";
import { chunkIdFor } from "../flows/ingest-document/chunker";
import { entityNameBind } from "../flows/ingest-document/pgEntities";
import type { PgFixture } from "../flows/ingest-document/pgFixture";
import type { LinkKind } from "../flows/ingest-document/pgLinks";

/** What the status read model holds for a document whose ingest finished (the rule `docmind_ready_documents` applies). */
export const READY_STATE = '{"status":"ready","step":"finalize","code":null}';

export interface SeedWho {
  tenantId: string;
  userId: string;
}

/**
 * Test seeding for the connections tests: documents with chunks (ready through the status read model's execution id),
 * chunk links in both directions, and entities with their chunk occurrences. Names map to ids; `id(name)` and `ch(name, n)`
 * read them back.
 */
export function connectionsSeeder(getFixture: () => PgFixture, defaultWho: SeedWho) {
  const fixture = getFixture; // read lazily: the fixture starts in `beforeAll`
  const ids = new Map<string, string>();
  const id = (name: string): string => ids.get(name) as string;
  const ch = (name: string, ordinal: number): string => chunkIdFor(id(name), ordinal);

  /** A document of `who` with `chunks` chunks; ready unless `ready: false`. The title is the name unless given. */
  async function seed(
    name: string,
    opts: {
      who?: SeedWho;
      chunks?: number;
      ready?: boolean;
      title?: string;
      titleKey?: string;
    } = {},
  ): Promise<void> {
    const who = opts.who ?? defaultWho;
    const d = await newDocument(
      fixture().fields,
      who.tenantId,
      who.userId,
      (ids.size + 1).toString(16).padStart(64, "0"),
    );
    const titleEnc = await fixture()
      .fields.forUser(opts.titleKey ?? who.userId)
      .seal(titleBind(d.id), opts.title ?? name);
    await withTenant(fixture().app, who.tenantId, (tx) => insertDocument(tx, { ...d, titleEnc }));
    ids.set(name, d.id);
    for (let i = 0; i < (opts.chunks ?? 2); i++) {
      await fixture().db.owner.query(
        `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
         VALUES ($1, $2, $3, $4, 0, '{"x":1}', '{"kind":"section","index":0}', 1)`,
        [chunkIdFor(d.id, i), who.tenantId, d.id, i],
      );
    }
    if (opts.ready !== false)
      await seedRow(
        fixture().db.owner,
        ingestExecutionId(who.userId, d.id, 2),
        d.id,
        who.userId,
        READY_STATE,
      );
  }

  /** Both directions, as the link store writes them. */
  const link = async (
    a: string,
    b: string,
    weight: number,
    kind: LinkKind = "similar",
    tenantId = defaultWho.tenantId,
  ) => {
    for (const [s, d] of [
      [a, b],
      [b, a],
    ] as const)
      await fixture().db.owner.query(
        "INSERT INTO chunk_links (tenant_id, src_chunk_id, dst_chunk_id, kind, weight) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
        [tenantId, s, d, kind, weight],
      );
  };

  const entity = async (
    name: string,
    chunks: string[],
    opts: { user?: string; sealedBy?: string; kind?: string; tenantId?: string } = {},
  ): Promise<string> => {
    const entityId = randomUUID();
    const owner = opts.user ?? defaultWho.userId;
    const tenantId = opts.tenantId ?? defaultWho.tenantId;
    await fixture().db.owner.query(
      "INSERT INTO entities (id, tenant_id, owner_id, kind, name_enc, name_key) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
      [
        entityId,
        tenantId,
        owner,
        opts.kind ?? "organization",
        JSON.stringify(
          await fixture()
            .fields.forUser(opts.sealedBy ?? owner)
            .seal(entityNameBind(entityId), name),
        ),
        randomUUID().replaceAll("-", "").repeat(2),
      ],
    );
    for (const c of chunks)
      await fixture().db.owner.query(
        "INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id) VALUES ($1, $2, $3)",
        [tenantId, c, entityId],
      );
    return entityId;
  };

  return { ids, id, ch, seed, link, entity };
}
