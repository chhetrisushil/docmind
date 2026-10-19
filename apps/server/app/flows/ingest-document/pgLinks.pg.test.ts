import { randomUUID } from "node:crypto";
import { ParseAbortedError } from "@docmind/parsers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_LOCK_EXCLUSIVE } from "../../db/entityLock";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { insertDocument } from "../../documents/repo";
import { T1, T2, U1, U1B, U2, newDocument } from "../../documents/testHarness";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";
import { type PgFixture, startPgFixture } from "./pgFixture";
import { type Link, type LinkStore, MAX_DEGREE, PgLinkStore } from "./pgLinks";

describe.skipIf(!PG_URL)("PgLinkStore (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let store: LinkStore;
  let DOC_A: IngestStartInput;
  let DOC_B: IngestStartInput;
  let DOC_C: IngestStartInput;
  let ALICE2_DOC: IngestStartInput;
  let BOB_DOC: IngestStartInput;
  const chunks = new Map<string, string[]>();

  async function seedDoc(
    tenant: string,
    user: string,
    fp: string,
    n = 2,
  ): Promise<IngestStartInput> {
    const d = await newDocument(fx.fields, tenant, user, fp);
    await withTenant(fx.app, tenant, (tx) => insertDocument(tx, d));
    const ids = Array.from({ length: n }, () => randomUUID());
    for (const [i, id] of ids.entries()) {
      await fx.db.owner.query(
        `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
         VALUES ($1, $2, $3, $4, 0, '{"x":1}', '{"kind":"chars","start":0,"end":5}', 2)`,
        [id, tenant, d.id, i],
      );
    }
    chunks.set(d.id, ids);
    return { tenantId: tenant, userId: user, documentId: d.id };
  }
  const ch = (d: IngestStartInput, i: number) => chunks.get(d.documentId)?.[i] as string;
  const edge = (src: string, dst: string, weight = 0.5, kind: Link["kind"] = "similar"): Link => ({
    src,
    dst,
    kind,
    weight,
  });
  const all = async () =>
    (
      await fx.db.owner.query<{ src: string; dst: string; kind: string; weight: number }>(
        `SELECT src_chunk_id AS src, dst_chunk_id AS dst, kind, weight FROM chunk_links
          ORDER BY src_chunk_id, dst_chunk_id, kind`,
      )
    ).rows;
  const pairs = async () => (await all()).map((r) => `${r.src}>${r.dst}`).sort();

  beforeAll(async () => {
    fx = await startPgFixture();
    store = new PgLinkStore(fx.app);
    DOC_A = await seedDoc(T1, U1, "a".repeat(64), 2);
    DOC_B = await seedDoc(T1, U1, "b".repeat(64), 2);
    DOC_C = await seedDoc(T1, U1, "c".repeat(64), 31);
    ALICE2_DOC = await seedDoc(T1, U1B, "d".repeat(64));
    BOB_DOC = await seedDoc(T2, U2, "e".repeat(64));
  });
  afterAll(async () => {
    await fx?.close();
  });
  beforeEach(async () => {
    await fx.db.owner.query("DELETE FROM chunk_links");
  });

  it("writes both directions for each link and counts them", async () => {
    const n = await store.replaceForDocument(DOC_A, [edge(ch(DOC_A, 0), ch(DOC_A, 1), 0.7)]);
    expect(n).toBe(2);
    expect(await store.countForDocument(DOC_A)).toBe(2);
    expect(await pairs()).toEqual(
      [`${ch(DOC_A, 0)}>${ch(DOC_A, 1)}`, `${ch(DOC_A, 1)}>${ch(DOC_A, 0)}`].sort(),
    );
  });

  it("keeps the maximum weight when a link is given twice or in both directions", async () => {
    await store.replaceForDocument(DOC_A, [
      edge(ch(DOC_A, 0), ch(DOC_A, 1), 0.3),
      edge(ch(DOC_A, 1), ch(DOC_A, 0), 0.9),
    ]);
    const rows = await all();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.weight).toBeCloseTo(0.9, 5);
  });

  it("replaces every link touching the document, including reverse rows held by other documents", async () => {
    await store.replaceForDocument(DOC_A, [edge(ch(DOC_A, 0), ch(DOC_B, 0))]);
    expect(await store.countForDocument(DOC_B)).toBe(1);
    await store.replaceForDocument(DOC_A, [edge(ch(DOC_A, 1), ch(DOC_B, 1))]);
    expect(await pairs()).toEqual(
      [`${ch(DOC_A, 1)}>${ch(DOC_B, 1)}`, `${ch(DOC_B, 1)}>${ch(DOC_A, 1)}`].sort(),
    );
  });

  it("drops links whose end is another owner's chunk, another tenant's chunk or unknown", async () => {
    const n = await store.replaceForDocument(DOC_A, [
      edge(ch(DOC_A, 0), ch(ALICE2_DOC, 0)),
      edge(ch(DOC_A, 0), ch(BOB_DOC, 0)),
      edge(ch(DOC_A, 0), randomUUID()),
      edge(ch(DOC_A, 0), "not-a-uuid"),
      edge(ch(DOC_A, 0), ch(DOC_A, 0)),
      edge(ch(DOC_A, 0), ch(DOC_A, 1), 0),
      edge(ch(DOC_A, 0), ch(DOC_A, 1), 1e-40),
    ]);
    expect(n).toBe(0);
    expect(await all()).toEqual([]);
  });

  it("drops a link between two other documents", async () => {
    const n = await store.replaceForDocument(DOC_A, [edge(ch(DOC_B, 0), ch(DOC_C, 0))]);
    expect(n).toBe(0);
    expect(await all()).toEqual([]);
  });

  it("caps each source at MAX_DEGREE strongest links, ties broken by dst then kind", async () => {
    const hub = ch(DOC_A, 0);
    const links: Link[] = [];
    // 30 distinct weights from 0.01 to 0.30.
    for (let i = 0; i < 30; i++) links.push(edge(hub, ch(DOC_C, i), (i + 1) / 100));
    await store.replaceForDocument(DOC_A, links);
    const out = (await all()).filter((r) => r.src === hub);
    expect(out).toHaveLength(MAX_DEGREE);
    const kept = new Set(out.map((r) => r.dst));
    for (let i = 6; i < 30; i++) expect(kept.has(ch(DOC_C, i))).toBe(true);
    for (let i = 0; i < 6; i++) expect(kept.has(ch(DOC_C, i))).toBe(false);
  });

  it("breaks ties by dst then kind", async () => {
    const hub = ch(DOC_A, 0);
    const dsts = Array.from({ length: 13 }, (_, i) => ch(DOC_C, i)).sort();
    const links: Link[] = [];
    for (const d of dsts) {
      links.push(edge(hub, d, 0.5, "similar"));
      links.push(edge(hub, d, 0.5, "entity"));
    }
    await store.replaceForDocument(DOC_A, links);
    const out = (await all()).filter((r) => r.src === hub);
    expect(out).toHaveLength(MAX_DEGREE);
    // 26 equal links: the last dst sorts last on both kinds, so both of its rows are the ones dropped.
    const lastDst = dsts[12] as string;
    expect(out.filter((r) => r.dst === lastDst)).toEqual([]);
  });

  it("leaves the previous links unchanged when the signal is aborted", async () => {
    await store.replaceForDocument(DOC_A, [edge(ch(DOC_A, 0), ch(DOC_A, 1))]);
    const before = await all();
    const ac = new AbortController();
    ac.abort();
    await expect(
      store.replaceForDocument(DOC_A, [edge(ch(DOC_A, 0), ch(DOC_B, 0))], ac.signal),
    ).rejects.toBeInstanceOf(ParseAbortedError);
    expect(await all()).toEqual(before);
  });

  it("treats another owner's call and a missing document as gone", async () => {
    const other = { ...DOC_A, userId: U1B };
    await expect(store.replaceForDocument(other, [])).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(store.countForDocument(other)).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(
      store.replaceForDocument({ ...DOC_A, documentId: randomUUID() }, []),
    ).rejects.toBeInstanceOf(DocumentGoneError);
  });

  it("serialises same-owner writes: a second call waits for the first's transaction", async () => {
    const held = await fx.db.owner.connect();
    let second: Promise<number> | undefined;
    try {
      await held.query("BEGIN");
      await held.query(LINK_LOCK_EXCLUSIVE, [U1]);
      second = store.replaceForDocument(DOC_B, [edge(ch(DOC_B, 0), ch(DOC_B, 1))]);
      second.catch(() => {});
      await vi.waitFor(async () => {
        const { rowCount } = await fx.db.owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'",
        );
        expect(rowCount).toBe(1);
      });
      expect(await all()).toEqual([]);
      await held.query("COMMIT");
    } finally {
      held.release();
    }
    expect(await second).toBe(2);
  });
});
