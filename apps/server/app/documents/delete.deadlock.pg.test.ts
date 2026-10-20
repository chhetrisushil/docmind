import type { DocumentDto } from "@docmind/contracts";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type DocumentHarness, TEXT, startDocumentServer } from "./testHarness";

const state = { deadlocks: 0, bumpOnCancel: false, queries: 0, cancels: [] as number[] };

/** A pool whose transactions fail the document DELETE with a deadlock `state.deadlocks` times. */
function deadlocking(pool: Pool): Pool {
  const wrap = <T extends object>(target: T, intercept: (p: string | symbol) => unknown): T =>
    new Proxy(target, {
      get(t, p) {
        const own = intercept(p);
        if (own !== undefined) return own;
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return wrap(pool, (p) =>
    p === "connect"
      ? async () => {
          const client = await pool.connect();
          return wrap(client, (q) =>
            q === "query"
              ? async (...args: unknown[]) => {
                  const text = typeof args[0] === "string" ? args[0] : "";
                  if (/^\s*DELETE FROM documents/i.test(text) && state.deadlocks > 0) {
                    state.deadlocks--;
                    state.queries++;
                    throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
                  }
                  return (client.query as (...a: unknown[]) => unknown)(...args);
                }
              : undefined,
          );
        }
      : undefined,
  );
}

describe.skipIf(!PG_URL)(
  "delete: deadlock retry and the retry race (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: DocumentHarness;
    beforeAll(async () => {
      h = await startDocumentServer({
        deps: (deps) => ({
          ...deps,
          pool: deadlocking(deps.pool),
          ingest: {
            ...deps.ingest,
            cancel: async (identity, documentId, generation) => {
              state.cancels.push(generation);
              if (state.bumpOnCancel) {
                state.bumpOnCancel = false;
                // What a retry does between the delete's two reads.
                await h.owner.query(
                  "UPDATE documents SET ingest_generation = ingest_generation + 1 WHERE id = $1",
                  [documentId],
                );
              }
              return deps.ingest.cancel(identity, documentId, generation);
            },
          },
        }),
      });
    });
    afterAll(async () => {
      await h?.close();
    });

    const del = (id: string) =>
      fetch(`${h.base}/api/documents/${id}`, {
        method: "DELETE",
        headers: { "x-test-user": "alice" },
      });
    const create = async (name: string) => {
      const res = await h.upload("alice", `${name}.txt`, TEXT(name));
      if (res.status !== 201) throw new Error(`upload answered ${res.status}: ${await res.text()}`);
      return ((await res.json()) as { document: DocumentDto }).document;
    };
    const exists = async (id: string) =>
      (await h.owner.query("SELECT 1 FROM documents WHERE id = $1", [id])).rowCount;

    it("retries the transaction after a deadlock (40P01) and answers 204", async () => {
      const doc = await create("deadlock-once");
      state.deadlocks = 1;
      state.queries = 0;
      expect((await del(doc.id)).status).toBe(204);
      expect(state.queries).toBe(1);
      expect(await exists(doc.id)).toBe(0);
    });

    it("gives up after 3 attempts with a server error, leaving the row for a repeat", async () => {
      const doc = await create("deadlock-always");
      state.deadlocks = 3;
      state.queries = 0;
      expect((await del(doc.id)).status).toBe(500);
      expect(state.queries).toBe(3);
      expect(await exists(doc.id)).toBe(1);
      expect((await del(doc.id)).status).toBe(204);
    });

    it("cancels again, up to the new generation, when a retry bumped it after the first read", async () => {
      const doc = await create("bumped");
      state.cancels = [];
      state.bumpOnCancel = true;
      expect((await del(doc.id)).status).toBe(204);
      expect(state.cancels).toHaveLength(2);
      expect(state.cancels[1]).toBe((state.cancels[0] as number) + 1);
      expect(await exists(doc.id)).toBe(0);
    });
  },
);
