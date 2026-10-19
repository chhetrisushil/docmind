import { randomUUID } from "node:crypto";
import { ParseAbortedError } from "@docmind/parsers";
import type { Pool, PoolClient } from "pg";
import { type EntityKeys, type EntityKind, normalizeEntityName } from "../../crypto/entityKeys";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";

export const SHARED_CAP = 2000;

export const entityNameBind = (entityId: string) => `entity:${entityId}:name`;

export interface EntityMention {
  chunkIds: string[];
  name: string;
  kind: EntityKind;
}

export interface SharedEntityRow {
  chunkId: string;
  otherChunkId: string;
  entityId: string;
  chunksWithEntity: number;
}

export interface EntityStore {
  /** Replaces this document's mentions; returns the `chunk_entities` rows written. */
  replaceForDocument(
    ref: IngestStartInput,
    mentions: EntityMention[],
    signal?: AbortSignal,
  ): Promise<number>;
  /** The owner's chunks in other documents that share an entity with this one's, rarest entity first. */
  sharedWith(ref: IngestStartInput): Promise<SharedEntityRow[]>;
}

interface Group {
  nameKey: string;
  kind: EntityKind;
  name: string;
  id: string;
  sealed: unknown;
  chunkIds: Set<string>;
}

/** Owner-scoped FOR KEY SHARE: a concurrent DELETE waits, then cascades our rows. Not found is gone. */
async function lockDocument(tx: PoolClient, ref: IngestStartInput) {
  const { rowCount } = await tx.query(
    "SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2 FOR KEY SHARE",
    [ref.documentId, ref.userId],
  );
  if (!rowCount) throw new DocumentGoneError();
}

export class PgEntityStore implements EntityStore {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
    private readonly entityKeys: EntityKeys,
  ) {}

  async replaceForDocument(
    ref: IngestStartInput,
    mentions: EntityMention[],
    signal?: AbortSignal,
  ): Promise<number> {
    // Everything that touches the key store happens before the transaction: no KMS call under row locks.
    const keys = this.entityKeys.forUser(ref.userId);
    const groups = new Map<string, Group>();
    for (const m of mentions) {
      if (normalizeEntityName(m.name) === null) continue;
      const nameKey = await keys.nameKey(m.name);
      if (nameKey === null) continue;
      const g = groups.get(nameKey);
      if (g) {
        if (g.kind === "other") g.kind = m.kind;
        for (const c of m.chunkIds) g.chunkIds.add(c);
      } else {
        groups.set(nameKey, {
          nameKey,
          kind: m.kind,
          name: m.name,
          id: randomUUID(),
          sealed: undefined,
          chunkIds: new Set(m.chunkIds),
        });
      }
    }
    // A stable order keeps two concurrent upserts from locking each other's keys in opposite orders.
    const ordered = [...groups.values()].sort((a, b) => (a.nameKey < b.nameKey ? -1 : 1));
    const cipher = this.fields.forUser(ref.userId);
    await Promise.all(
      ordered.map(async (g) => {
        g.sealed = await cipher.seal(entityNameBind(g.id), g.name);
      }),
    );

    return withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      await tx.query(
        `DELETE FROM chunk_entities ce USING chunks c
          WHERE ce.chunk_id = c.id AND c.document_id = $1`,
        [ref.documentId],
      );
      const chunkIds: string[] = [];
      const entityIds: string[] = [];
      for (const g of ordered) {
        await tx.query(
          `INSERT INTO entities (id, tenant_id, owner_id, kind, name_enc, name_key)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT (tenant_id, owner_id, name_key) DO NOTHING`,
          [g.id, ref.tenantId, ref.userId, g.kind, JSON.stringify(g.sealed), g.nameKey],
        );
        const { rows } = await tx.query<{ id: string }>(
          "SELECT id FROM entities WHERE owner_id = $1 AND name_key = $2",
          [ref.userId, g.nameKey],
        );
        const entityId = rows[0]?.id;
        if (!entityId) throw new Error("the entity row is missing after its upsert");
        for (const c of g.chunkIds) {
          chunkIds.push(c);
          entityIds.push(entityId);
        }
      }
      let written = 0;
      if (chunkIds.length > 0) {
        // The join to this document's chunks drops any id that is not one of them.
        const res = await tx.query(
          `INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id)
           SELECT $1, c.id, u.entity_id
             FROM unnest($2::text[], $3::uuid[]) AS u(chunk_id, entity_id)
             JOIN chunks c ON c.id::text = u.chunk_id AND c.document_id = $4
           ON CONFLICT DO NOTHING`,
          [ref.tenantId, chunkIds, entityIds, ref.documentId],
        );
        written = res.rowCount ?? 0;
      }
      // The last statement before COMMIT: an abandoned attempt rolls back.
      if (signal?.aborted) throw new ParseAbortedError();
      return written;
    });
  }

  async sharedWith(ref: IngestStartInput): Promise<SharedEntityRow[]> {
    return withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      const { rows } = await tx.query<{
        chunk_id: string;
        other_chunk_id: string;
        entity_id: string;
        chunks_with_entity: number;
      }>(
        `WITH mine AS (
           SELECT ce.chunk_id, ce.entity_id FROM chunk_entities ce JOIN chunks c ON c.id = ce.chunk_id
            WHERE c.document_id = $1),
         freq AS (
           SELECT ce.entity_id, count(*)::int AS n FROM chunk_entities ce
            WHERE ce.entity_id IN (SELECT entity_id FROM mine)
            GROUP BY ce.entity_id)
         SELECT m.chunk_id, o.chunk_id AS other_chunk_id, m.entity_id, f.n AS chunks_with_entity
           FROM mine m
           JOIN chunk_entities o ON o.entity_id = m.entity_id
           JOIN chunks oc ON oc.id = o.chunk_id AND oc.document_id <> $1
           JOIN documents od ON od.id = oc.document_id AND od.owner_id = $2
           JOIN freq f ON f.entity_id = m.entity_id
          ORDER BY f.n, m.chunk_id, o.chunk_id
          LIMIT $3`,
        [ref.documentId, ref.userId, SHARED_CAP],
      );
      return rows.map((r) => ({
        chunkId: r.chunk_id,
        otherChunkId: r.other_chunk_id,
        entityId: r.entity_id,
        chunksWithEntity: r.chunks_with_entity,
      }));
    });
  }
}
