import type { Pool } from "pg";
import { z } from "zod";
import { ENTITY_KINDS, type EntityKind } from "../../crypto/entityKeys";
import { type FieldCrypto, FieldKeyStoreError } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { titleBind } from "../../documents/repo";
import { DocumentGoneError } from "../ingest-document/errors";
import { chunkBind } from "../ingest-document/pgChunks";
import { entityNameBind } from "../ingest-document/pgEntities";
import { type EntityCandidate, MAX_MAP_ENTITIES, type Mention } from "./cooccurrence";
import type { HeadingRow } from "./outline";
import type { VisualizeRef } from "./pgFacts";
import type { StructureReader } from "./structure";

/** The most candidate entities one read returns: the top 20 plus any tied with the 20th, bounded. */
export const ENTITY_CANDIDATE_CAP = 200;

/**
 * $1 document, $2 owner, $3 tenant. Each passage's section (plaintext) and sealed text; `owned` is false when the document is
 * not the owner's (an owner and tenant predicate of its own, not only row-level security). A document with no passages yields
 * one row with a null `id`.
 */
export const HEADINGS_SQL = `SELECT o.owned, c.id, c.section_ordinal, c.text_enc
   FROM (SELECT EXISTS (
           SELECT 1 FROM documents d WHERE d.id = $1 AND d.owner_id = $2 AND d.tenant_id = $3) AS owned) o
   LEFT JOIN chunks c ON o.owned AND c.tenant_id = $3 AND c.document_id = $1
  ORDER BY c.ordinal`;

/**
 * $1 owner, $2 document, $3 tenant, $4 rank limit, $5 row cap. The owner's entities of THIS document's passages: the document
 * (owner and tenant named), its chunks (`chunks_document_ordinal_key`), their `chunk_entities` rows (the primary key leads with
 * the tenant and the chunk), counted per entity, ranked by that count; the entity row is read by key only for the ranked few.
 * MATERIALIZED so the planner cannot reorder it into a scan of the owner's library. `rank()` keeps every entity tied with the
 * last wanted one, so a tie at the boundary is broken by name later (names are sealed, SQL cannot), and the cap bounds a
 * document full of equal entities.
 */
export const CANDIDATES_SQL = `WITH counted AS MATERIALIZED (
  SELECT ce.tenant_id, ce.entity_id, count(DISTINCT ce.chunk_id)::int AS n
    FROM documents d
    JOIN chunks c ON c.tenant_id = d.tenant_id AND c.document_id = d.id
    JOIN chunk_entities ce ON ce.tenant_id = c.tenant_id AND ce.chunk_id = c.id
   WHERE d.id = $2 AND d.owner_id = $1 AND d.tenant_id = $3
   GROUP BY ce.tenant_id, ce.entity_id),
ranked AS MATERIALIZED (
  SELECT k.tenant_id, k.entity_id, k.n, rank() OVER (ORDER BY k.n DESC) AS r FROM counted k)
SELECT en.id AS entity_id, en.kind, en.name_enc, k.n
  FROM ranked k
  JOIN entities en ON en.tenant_id = k.tenant_id AND en.id = k.entity_id AND en.owner_id = $1
 WHERE k.r <= $4
 ORDER BY k.n DESC, en.id
 LIMIT $5`;

/**
 * $1 owner, $2 document, $3 tenant, $4 entity ids. The kept entities' passages in this document, in passage order. It starts
 * from this document's passages (MATERIALIZED) and probes `chunk_entities` once per passage through its primary key, in a
 * LATERAL with a LIMIT (never reached: a passage has at most as many rows as there are ids, at most 200) so the planner
 * cannot flatten it into a join. A plain `JOIN ... entity_id = ANY($4)` was planned as a sequential scan of all of
 * `chunk_entities` once a hub entity (on every passage of the library) was among the ids.
 */
export const MENTIONS_SQL = `WITH mine AS MATERIALIZED (
  SELECT c.tenant_id, c.id, c.ordinal
    FROM documents d
    JOIN chunks c ON c.tenant_id = d.tenant_id AND c.document_id = d.id
   WHERE d.id = $2 AND d.owner_id = $1 AND d.tenant_id = $3)
SELECT x.entity_id, x.chunk_id, m.ordinal
  FROM mine m
  CROSS JOIN LATERAL (
    SELECT ce.entity_id, ce.chunk_id FROM chunk_entities ce
     WHERE ce.tenant_id = m.tenant_id AND ce.chunk_id = m.id AND ce.entity_id = ANY($4::uuid[])
     LIMIT ${ENTITY_CANDIDATE_CAP}) x
 ORDER BY m.ordinal, x.entity_id`;

const SEALED = z.object({ headingPath: z.array(z.string()) }).passthrough();
const KINDS: readonly string[] = ENTITY_KINDS;

/**
 * Reads what the structure step needs, under the owner's key and for this document only. A value that does not open (or
 * has an unexpected shape) makes the whole kind unreadable (`null`), and nothing is logged (headings and names are
 * content). A key-store outage is not "does not open": it is rethrown so the step fails and retries.
 */
export class PgStructureReader implements StructureReader {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  private async open<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (err) {
      if (err instanceof FieldKeyStoreError) throw err;
      return null;
    }
  }

  async title(ref: VisualizeRef): Promise<string | null> {
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const res = await tx.query<{ title_enc: unknown }>(
        "SELECT title_enc FROM documents WHERE id = $1 AND owner_id = $2 AND tenant_id = $3",
        [ref.documentId, ref.userId, ref.tenantId],
      );
      return res.rows;
    });
    const row = rows[0];
    if (!row) throw new DocumentGoneError();
    const cipher = this.fields.forUser(ref.userId);
    return this.open(() => cipher.openText(titleBind(ref.documentId), row.title_enc));
  }

  async headings(ref: VisualizeRef): Promise<HeadingRow[] | null> {
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const res = await tx.query<{
        owned: boolean;
        id: string | null;
        section_ordinal: number;
        text_enc: unknown;
      }>(HEADINGS_SQL, [ref.documentId, ref.userId, ref.tenantId]);
      return res.rows;
    });
    if (!rows[0]?.owned) throw new DocumentGoneError();
    const cipher = this.fields.forUser(ref.userId);
    const opened = await Promise.all(
      rows.map(async (r): Promise<HeadingRow | null | "none"> => {
        if (r.id === null) return "none"; // the LEFT JOIN of a document with no passages
        const id = r.id;
        const sealed = SEALED.safeParse(
          await this.open(() => cipher.open(chunkBind(id), r.text_enc)),
        );
        return sealed.success
          ? { chunkId: id, sectionOrdinal: r.section_ordinal, headingPath: sealed.data.headingPath }
          : null;
      }),
    );
    if (opened.includes(null)) return null;
    return opened.filter((r): r is HeadingRow => r !== "none" && r !== null);
  }

  async entities(ref: VisualizeRef): Promise<EntityCandidate[] | null> {
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const res = await tx.query<{ entity_id: string; kind: string; name_enc: unknown; n: number }>(
        CANDIDATES_SQL,
        [ref.userId, ref.documentId, ref.tenantId, MAX_MAP_ENTITIES, ENTITY_CANDIDATE_CAP],
      );
      return res.rows;
    });
    const cipher = this.fields.forUser(ref.userId);
    const out = await Promise.all(
      rows.map(async (r): Promise<EntityCandidate | null> => {
        const name = await this.open(() =>
          cipher.openText(entityNameBind(r.entity_id), r.name_enc),
        );
        if (name === null || !KINDS.includes(r.kind)) return null;
        return { id: r.entity_id, kind: r.kind as EntityKind, name, passages: r.n };
      }),
    );
    return out.includes(null) ? null : (out as EntityCandidate[]);
  }

  async mentions(ref: VisualizeRef, entityIds: readonly string[]): Promise<Mention[]> {
    if (entityIds.length === 0) return [];
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const res = await tx.query<{ entity_id: string; chunk_id: string; ordinal: number }>(
        MENTIONS_SQL,
        [ref.userId, ref.documentId, ref.tenantId, [...entityIds]],
      );
      return res.rows;
    });
    return rows.map((r) => ({ entityId: r.entity_id, chunkId: r.chunk_id, ordinal: r.ordinal }));
  }
}
