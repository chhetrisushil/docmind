import { Uuid } from "@docmind/contracts";
import {
  CONNECTIONS_CAPS,
  type ConnectionDocument,
  type RawConnections,
} from "@docmind/experiences";
import type { Pool } from "pg";
import { type FieldCrypto, FieldKeyStoreError } from "../crypto/fields";
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
 * `execKey` is the status row's execution id, computed by the caller in a subquery's output: row-level security only lets a
 * leakproof comparison of plain values reach the primary key (model_id, execution_id), and the string building is not leakproof.
 */
const EXEC_KEY = (d: string): string => `'u_' || ${d}.owner_id::text || ':ingest-' || ${d}.id::text
           || CASE WHEN ${d}.ingest_generation = 1 THEN '' ELSE '.' || ${d}.ingest_generation::text END`;
const READY_ROW = (key: string): string => `EXISTS (
    SELECT 1 FROM read_model_state s
     WHERE s.model_id = 'ingest-status' AND s.execution_id = ${key}
       AND NOT s.erased AND s.state ->> 'status' = 'ready')`;

/** $1 owner, $2 document. */
export const SELF_SQL = "SELECT 1 FROM documents WHERE id = $2 AND owner_id = $1";

/**
 * $1 owner, $2 document, $3 limit. Related documents. The neighbourhood is built first, from this document alone: its chunks
 * (`chunks_document_ordinal_key`), the links out of them (the `chunk_links` primary key leads with the source chunk), the chunks
 * they reach, grouped per document. Each step is MATERIALIZED, so the planner cannot reorder it into a scan of the owner's
 * library. Only then does each neighbour document meet `documents` (owner) and the readiness check, in a LATERAL with LIMIT 1 so the
 * planner looks each one up by key (documents primary key, then the status row's primary key) and cannot scan either table. `structure` links stay inside a document and are never a connection.
 */
export const RELATED_SQL = `WITH mine AS MATERIALIZED (
  SELECT mc.tenant_id, mc.id
    FROM documents me
    JOIN chunks mc ON mc.tenant_id = me.tenant_id AND mc.document_id = me.id
   WHERE me.id = $2 AND me.owner_id = $1),
nbr AS MATERIALIZED (
  SELECT dc.tenant_id, dc.document_id,
         (count(*) FILTER (WHERE l.kind = 'entity'))::int AS entity,
         (count(*) FILTER (WHERE l.kind = 'reference'))::int AS reference,
         (count(*) FILTER (WHERE l.kind = 'similar'))::int AS similar,
         count(*) AS n,
         max(l.weight) AS strength
    FROM mine m
    JOIN chunk_links l ON l.tenant_id = m.tenant_id AND l.src_chunk_id = m.id
                      AND l.kind IN ('entity', 'reference', 'similar')
    JOIN chunks dc ON dc.tenant_id = l.tenant_id AND dc.id = l.dst_chunk_id AND dc.document_id <> $2
   GROUP BY dc.tenant_id, dc.document_id)
SELECT dd.id AS document_id, dd.title_enc, n.entity, n.reference, n.similar, n.strength
  FROM nbr n
  CROSS JOIN LATERAL (
    SELECT d.id, d.title_enc, ${EXEC_KEY("d")} AS exec_key FROM documents d
     WHERE d.tenant_id = n.tenant_id AND d.id = n.document_id AND d.owner_id = $1
     LIMIT 1) dd
 WHERE ${READY_ROW("dd.exec_key")}
 ORDER BY n.strength DESC, n.n DESC, dd.id
 LIMIT $3`;

/**
 * $1 owner, $2 document, $3 entity limit, $4 documents per entity. The owner's entities of this document's chunks
 * (`chunks_document_ordinal_key`, the `chunk_entities` primary key, `entities`), then the (entity, document) pairs through
 * the other chunks of each entity (`chunk_entities_entity_idx`), all MATERIALIZED so they stay a walk from this document.
 * Rarity (the number of other documents) is counted over those pairs, before the readiness join; an entity whose other
 * documents are none ready, or none the owner's, drops out at that join. Titles are sealed, so SQL keeps the newest
 * documents per entity and the reader orders them by title.
 */
export const ENTITIES_SQL = `WITH mine AS MATERIALIZED (
  SELECT DISTINCT ce.tenant_id, ce.entity_id
    FROM documents me
    JOIN chunks mc ON mc.tenant_id = me.tenant_id AND mc.document_id = me.id
    JOIN chunk_entities ce ON ce.tenant_id = mc.tenant_id AND ce.chunk_id = mc.id
    JOIN entities en ON en.tenant_id = ce.tenant_id AND en.id = ce.entity_id AND en.owner_id = $1
   WHERE me.id = $2 AND me.owner_id = $1),
pairs AS MATERIALIZED (
  SELECT m.entity_id, oc.tenant_id, oc.document_id
    FROM mine m
    JOIN chunk_entities oe ON oe.tenant_id = m.tenant_id AND oe.entity_id = m.entity_id
    JOIN chunks oc ON oc.tenant_id = oe.tenant_id AND oc.id = oe.chunk_id AND oc.document_id <> $2
   GROUP BY m.entity_id, oc.tenant_id, oc.document_id),
counted AS MATERIALIZED (
  SELECT p.*, count(*) OVER (PARTITION BY p.entity_id) AS n FROM pairs p),
shared AS MATERIALIZED (
  SELECT c.entity_id, c.n, dd.id AS document_id, dd.title_enc, dd.created_at
    FROM counted c
    CROSS JOIN LATERAL (
      SELECT d.id, d.title_enc, d.created_at, ${EXEC_KEY("d")} AS exec_key FROM documents d
       WHERE d.tenant_id = c.tenant_id AND d.id = c.document_id AND d.owner_id = $1
       LIMIT 1) dd
   WHERE ${READY_ROW("dd.exec_key")}),
rarest AS (
  SELECT entity_id, min(n) AS n FROM shared GROUP BY entity_id ORDER BY min(n), entity_id LIMIT $3),
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
    } catch (err) {
      if (err instanceof FieldKeyStoreError) throw err; // an outage is not "this value does not open": the widget errors
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

  const groups = new Map<
    string,
    { kind: string; nameEnc: unknown; docs: { id: string; enc: unknown }[] }
  >();
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
