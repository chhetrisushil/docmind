import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { UploadDocumentResponse } from "@docmind/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";

type Handle = { handle: string; priority: string; params: string[] };
type Result = { state: string; finding?: { code: string } };

describe.skipIf(!PG_URL)(
  "a document whose stored file is missing (needs DOCMIND_TEST_PG_URL)",
  () => {
    let st: IngestStack;
    afterAll(async () => st?.close());

    it("hydrates doc-source as unavailable, logs no finding, and the original route answers 404 file_missing", async () => {
      st = await startIngestStack();
      const u = await st.signUpAndLogIn("ada@example.com");
      const events = await st.events(u.cookie);
      const upload = async (name: string, text: string) => {
        const res = await st.upload(u.cookie, name, Buffer.from(text));
        const id = ((await res.json()) as UploadDocumentResponse).document.id;
        await st.until(events, id, (s) => s === "ready" || s === "failed");
        return id;
      };
      const lost = await upload("report.md", "# Report\n\nRevenue was 1,200 in 2024.\n");
      events.close();

      const hydrateSource = async (id: string) => {
        const view = (await (
          await fetch(`${st.base}/api/ui/documents/${id}/detail?surface=web`, {
            headers: { cookie: u.cookie },
          })
        ).json()) as {
          experienceId: string;
          versionHash: string;
          inventory: { handles: Handle[] };
        };
        const h = view.inventory.handles.find((x) => x.handle === "doc-source") as Handle;
        const res = await fetch(`${st.base}/api/ui/hydrate`, {
          method: "POST",
          headers: { cookie: u.cookie, "content-type": "application/json" },
          body: JSON.stringify({
            document: id,
            requests: [
              {
                experienceId: view.experienceId,
                versionHash: view.versionHash,
                handle: h.handle,
                params: Object.fromEntries(
                  Object.entries({ id, upto: 20 }).filter(([k]) => h.params.includes(k)),
                ),
              },
            ],
          }),
        });
        return ((await res.json()) as { results: Result[] }).results[0] as Result;
      };

      const before = await hydrateSource(lost); // an existing blob is served as before
      expect(before.state).toBe("ready");
      const dir = join(st.root, u.tenantId, u.userId);
      for (const f of readdirSync(dir)) rmSync(join(dir, f));

      const logged: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(" "));
      });
      let out: Result;
      try {
        out = await hydrateSource(lost);
      } finally {
        spy.mockRestore();
      }
      expect(out.state).toBe("ready");
      expect(out.finding).toBeUndefined();
      expect(logged.filter((l) => l.startsWith("ui finding"))).toEqual([]);

      const route = await fetch(`${st.base}/api/documents/${lost}/source`, {
        headers: { cookie: u.cookie },
      });
      expect(route.status).toBe(404);
      expect(await route.json()).toMatchObject({ error: { code: "file_missing" } });
    });
  },
);
