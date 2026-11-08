import { Uuid } from "@docmind/contracts";
import {
  CONNECTIONS_CAPS,
  type ConnectionDocument,
  type RawConnections,
} from "@docmind/experiences";
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
