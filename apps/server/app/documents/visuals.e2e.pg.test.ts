import type { UploadDocumentResponse } from "@docmind/contracts";
import { UiViewResponse } from "@docmind/contracts";
import type { FakeAnthropic } from "@docmind/llm-anthropic/testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { eraseMe, waitErased } from "../erasure/e2eSupport";
import { experienceIdOf, visualsLineage } from "../flows/visualize-document/lineage";
import { PgVisualFacts } from "../flows/visualize-document/pgFacts";
import { visualizeExecutionId } from "../flows/visualize-document/start";
import { subjectOfExecution } from "../subject";
import { type IngestStack, startIngestStack } from "./ingestStack";

const CHUNK_ID = /\[\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/;

/** What a document states: the model finds this figure in any document that carries `marker`. */
interface Figure {
  marker: string;
  label: string;
  value: number;
}
const ADA: Figure = { marker: "Revenue", label: "Revenue", value: 1200 };
const BEN: Figure = { marker: "Zebra", label: "Zebra-Quarterly-Takings", value: 7391.25 };

/** A `visuals` model that finds one figure fact in whatever document it is shown, and plans a KeyFigure for it. */
function stubVisuals(claude: FakeAnthropic, figures: Figure[], down?: { value: boolean }) {
  claude.reply((body) => {
    if (down?.value) return { status: 503, rawBody: "{}" }; // the visuals model is unavailable
    const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    const text = JSON.stringify(body.messages);
    const { label, value } = figures.find((f) => text.includes(f.marker)) ?? (ADA as Figure);
    if (system.includes("You extract facts")) {
      const chunk = CHUNK_ID.exec(text)?.[1];
      if (!chunk) return { text: '{"facts":[]}' };
      return {
        text: JSON.stringify({
          facts: [{ kind: "figure", label, value, unit: "USD", chunkIds: [chunk] }],
        }),
      };
    }
    return {
      text: JSON.stringify({
        summary: "A headline figure",
        nodes: [
          {
            id: "headline",
            type: "KeyFigure",
            label,
            span: 4,
            props: {},
            binding: { capability: "fact-0", arguments: {}, path: "value", priority: "P0" },
          },
        ],
      }),
    };
  });
}

describe.skipIf(!PG_URL)("document visuals end to end (needs DOCMIND_TEST_PG_URL)", () => {
  const stacks: IngestStack[] = [];
  afterAll(async () => {
    for (const s of stacks.splice(0)) await s.close();
  });

  const get = (st: IngestStack, cookie: string, path: string) =>
    fetch(`${st.base}${path}`, { headers: { cookie } });
  const detail = (st: IngestStack, cookie: string, id: string) =>
    get(st, cookie, `/api/ui/documents/${id}/detail?surface=web`);

  /** Uploads a text document; resolves with its id once ingest is ready and the visuals-ready event followed (or just ready, without visuals). */
  async function upload(
    st: IngestStack,
    cookie: string,
    text: string,
    opts: { visuals: boolean } = { visuals: true },
  ) {
    const events = await st.events(cookie);
    try {
      const res = await st.upload(cookie, "report.txt", Buffer.from(text));
      expect(res.status).toBe(201);
      const id = ((await res.json()) as UploadDocumentResponse).document.id;
      const seen = await st.until(events, id, (s) => s === "ready" || s === "failed");
      expect(seen.at(-1)?.status).toBe("ready");
      if (opts.visuals) {
        // The commit step publishes {status: ready, step: finalize, visuals: ready}: an open page reloads its detail.
        const after = await st.until(events, id, () => true);
        expect(after.at(-1)).toMatchObject({
          status: "ready",
          step: "finalize",
          visuals: "ready",
        });
      }
      return id;
    } finally {
      events.close();
    }
  }

  /** The outcome the visualize execution of the document's current generation ended with. */
  async function visualizeOutcome(st: IngestStack, userId: string, documentId: string) {
    const { rows } = await st.db.owner.query(
      "SELECT ingest_generation AS g FROM documents WHERE id = $1",
      [documentId],
    );
    const execution = visualizeExecutionId(userId, documentId, Number(rows[0].g));
    let outcome = "";
    await vi.waitFor(
      async () => {
        const end = (await st.durable.raw.eventStore.read(execution)).find(
          (e) => e.eventType === "EXECUTION_COMPLETED",
        );
        expect(end).toBeDefined();
        outcome = (end?.payload as { output: { outcome: string } }).output.outcome;
      },
      { timeout: 30_000, interval: 50 },
    );
    return outcome;
  }

  const hydrate = async (st: IngestStack, cookie: string, id: string, handle: string) => {
    const view = UiViewResponse.parse(await (await detail(st, cookie, id)).json());
    const res = await fetch(`${st.base}/api/ui/hydrate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        document: id,
        requests: [
          { experienceId: view.experienceId, versionHash: view.versionHash, handle, params: {} },
        ],
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { results: { state: string; value: unknown }[] }).results[0];
  };

  it("extracts, plans and commits visuals; serves, hydrates and cites them; deletes them with the document", async () => {
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    stubVisuals(st.visualsClaude as FakeAnthropic, [ADA]);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const id = await upload(st, ada.cookie, "Revenue was 1,200 in 2024");
    expect(await visualizeOutcome(st, ada.userId, id)).toBe("done");

    // The detail carries the visuals panel; a non-owner gets 404.
    const served = await detail(st, ada.cookie, id);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain('"id":"visuals"');
    const other = await st.signUpAndLogIn("other@example.com");
    expect((await detail(st, other.cookie, id)).status).toBe(404);

    // fact-0 hydrates to the figure, under the owner's clearance only.
    expect(await hydrate(st, ada.cookie, id, "fact-0")).toMatchObject({
      state: "ready",
      value: { value: 1200, unit: "USD" },
    });

    // Its citation is a real passage of the document, which the source route resolves.
    const refs = { tenantId: ada.tenantId, userId: ada.userId, documentId: id };
    const [fact] = await new PgVisualFacts(st.app, st.fields).list(refs);
    const passage = fact?.chunkIds[0];
    expect(passage).toBeDefined();
    const source = await get(st, ada.cookie, `/api/documents/${id}/source?passage=${passage}`);
    expect(source.status).toBe(200);
    expect(await source.json()).toMatchObject({
      format: "txt",
      text: "Revenue was 1,200 in 2024",
      focus: expect.anything(),
    });

    // Deleting the document: its detail is gone and so are its facts.
    const del = await fetch(`${st.base}/api/documents/${id}`, {
      method: "DELETE",
      headers: { cookie: ada.cookie },
    });
    expect(del.status).toBe(204);
    expect((await detail(st, ada.cookie, id)).status).toBe(404);
    const left = await st.db.owner.query("SELECT 1 FROM visual_facts WHERE document_id = $1", [id]);
    expect(left.rowCount).toBe(0);
  }, 120_000);

  it("erasing a user unreads their lineage and leaves no label or value in the stores; another user is unaffected", async () => {
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    stubVisuals(st.visualsClaude as FakeAnthropic, [ADA, BEN]);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const ben = await st.signUpAndLogIn("ben@example.com");
    const adaDoc = await upload(st, ada.cookie, "Revenue was 1,200 in 2024");
    const benDoc = await upload(st, ben.cookie, "Zebra takings were 7,391.25 in 2024");
    expect(await visualizeOutcome(st, ben.userId, benDoc)).toBe("done");
    expect(await hydrate(st, ben.cookie, benDoc, "fact-0")).toMatchObject({
      value: { value: 7391.25 },
    });

    // The composed lineage (the sealing event store and content store the server uses).
    const lineage = visualsLineage({
      events: st.durable.storage.eventStore,
      content: st.composed.lineageContent,
      keys: st.keys,
      subjectOf: subjectOfExecution,
    });
    const benLine = experienceIdOf({ ...ben, documentId: benDoc });
    const before = await lineage.resolveLatest(benLine);
    expect(before.ok && JSON.stringify(before.value)).toContain(BEN.label);

    const erased = await eraseMe(st, ben.cookie);
    expect(erased.status).toBe(202);
    await waitErased(st, ben.userId);

    expect(await lineage.resolveLatest(benLine)).toMatchObject({
      ok: false,
      refusal: { kind: "refused", finding: { code: "line-erased" } },
    });

    // Raw rows: the artifact store and every event of every execution hold neither the label nor the value.
    const stored = await st.db.owner.query("SELECT count(*)::int AS n FROM lineage_content");
    expect(stored.rows[0].n).toBeGreaterThan(0); // not vacuous: ciphertext is still there
    for (const needle of [BEN.label, String(BEN.value)]) {
      const found = await st.db.owner.query(
        "SELECT 1 FROM lineage_content WHERE position(convert_to($1, 'UTF8') in bytes) > 0",
        [needle],
      );
      expect(found.rowCount, `lineage_content has ${needle}`).toBe(0);
      const ids = (await st.durable.raw.eventStore.listExecutions?.()) ?? [];
      expect(ids.length).toBeGreaterThan(0);
      for (const execution of ids) {
        const raw = JSON.stringify(await st.durable.raw.eventStore.read(execution));
        expect(raw.includes(needle), `${execution} has ${needle}`).toBe(false);
      }
    }

    // Ada's visuals are untouched.
    expect(await visualizeOutcome(st, ada.userId, adaDoc)).toBe("done");
    expect((await detail(st, ada.cookie, adaDoc)).status).toBe(200);
    expect(await hydrate(st, ada.cookie, adaDoc, "fact-0")).toMatchObject({
      state: "ready",
      value: { value: 1200 },
    });
  }, 180_000);

  it("with the visuals role off, no flow starts and no panel is served", async () => {
    const st = await startIngestStack(); // every role is off (DOCMIND_LLM_PROVIDER=off)
    stacks.push(st);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const id = await upload(st, ada.cookie, "Revenue was 1,200 in 2024", { visuals: false });
    await st.composed.visuals.idle();
    const ids = (await st.durable.raw.eventStore.listExecutions?.()) ?? [];
    expect(ids.filter((e) => e.includes(":visualize-"))).toEqual([]);
    const served = await detail(st, ada.cookie, id);
    expect(served.status).toBe(200);
    expect(await served.text()).not.toContain('"id":"visuals"');
  }, 120_000);

  /** The output the visualize execution `rerun` (0: the automatic one) of the document's current generation ended with. */
  async function visualizeEnd(st: IngestStack, userId: string, documentId: string, rerun = 0) {
    const { rows } = await st.db.owner.query(
      "SELECT ingest_generation AS g FROM documents WHERE id = $1",
      [documentId],
    );
    const execution = visualizeExecutionId(
      userId,
      documentId,
      Number(rows[0].g),
      rerun === 0 ? undefined : rerun,
    );
    let output: unknown;
    await vi.waitFor(
      async () => {
        const end = (await st.durable.raw.eventStore.read(execution)).find(
          (e) => e.eventType === "EXECUTION_COMPLETED",
        );
        expect(end).toBeDefined();
        output = (end?.payload as { output: unknown }).output;
      },
      { timeout: 30_000, interval: 50 },
    );
    return output;
  }
  const runRow = async (st: IngestStack, id: string) =>
    (
      await st.db.owner.query("SELECT run, state, code FROM visual_runs WHERE document_id = $1", [
        id,
      ])
    ).rows;

  it("a visuals model that stays down ends the run failed: the page is told and a retry makes the visuals; nothing readable is logged", async () => {
    const logged: string[] = [];
    for (const m of ["error", "info", "warn", "log"] as const)
      vi.spyOn(console, m).mockImplementation(
        (...a: unknown[]) => void logged.push(a.map(String).join(" ")),
      );
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    const down = { value: true };
    stubVisuals(st.visualsClaude as FakeAnthropic, [ADA], down);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const events = await st.events(ada.cookie);
    try {
      const res = await st.upload(
        ada.cookie,
        "report.txt",
        Buffer.from("Revenue was 1,200 in 2024"),
      );
      const id = ((await res.json()) as UploadDocumentResponse).document.id;
      await st.until(events, id, (s) => s === "ready");
      const [told] = await st.until(events, id, () => true);
      expect(told).toMatchObject({ status: "ready", step: "finalize", visuals: "failed" });

      expect(await visualizeEnd(st, ada.userId, id)).toEqual({
        outcome: "failed",
        code: "visuals-model-unavailable",
      });
      expect(await runRow(st, id)).toEqual([
        { run: 0, state: "failed", code: "visuals-model-unavailable" },
      ]);
      const failedDetail = UiViewResponse.parse(await (await detail(st, ada.cookie, id)).json());
      expect(failedDetail.visuals).toEqual({ state: "failed" });
      expect(JSON.stringify(failedDetail)).not.toContain('"id":"visuals"');
      const other = await st.signUpAndLogIn("other@example.com");
      expect((await detail(st, other.cookie, id)).status).toBe(404); // owner-only

      // Retry: 202, the page is told when it is made, and the state follows.
      down.value = false;
      const retry = await fetch(`${st.base}/api/documents/${id}/visuals/retry`, {
        method: "POST",
        headers: { cookie: ada.cookie },
      });
      expect([retry.status, await retry.json()]).toEqual([202, { started: true }]);
      const [made] = await st.until(events, id, () => true);
      expect(made).toMatchObject({ status: "ready", step: "finalize", visuals: "ready" });
      expect(await visualizeEnd(st, ada.userId, id, 1)).toEqual({ outcome: "done" });
      await vi.waitFor(async () =>
        expect(await runRow(st, id)).toEqual([{ run: 1, state: "done", code: null }]),
      );
      const readyDetail = UiViewResponse.parse(await (await detail(st, ada.cookie, id)).json());
      expect(readyDetail.visuals).toEqual({ state: "ready" });
      expect(await hydrate(st, ada.cookie, id, "fact-0")).toMatchObject({
        state: "ready",
        value: { value: 1200 },
      });
      // A foreign user's retry is a 404 and starts nothing.
      const foreign = await fetch(`${st.base}/api/documents/${id}/visuals/retry`, {
        method: "POST",
        headers: { cookie: other.cookie },
      });
      expect(foreign.status).toBe(404);

      // No document text, label or value reached the logs or any execution's raw event log.
      expect(logged.join("\n")).not.toContain("Revenue");
      expect(logged.join("\n")).not.toContain("1,200");
      for (const execution of (await st.durable.raw.eventStore.listExecutions?.()) ?? [])
        expect(JSON.stringify(await st.durable.raw.eventStore.read(execution))).not.toContain(
          "Revenue",
        );
    } finally {
      events.close();
      vi.restoreAllMocks();
    }
  }, 120_000);

  it("deleting a document that has a re-run succeeds and removes its run row", async () => {
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    stubVisuals(st.visualsClaude as FakeAnthropic, [ADA]);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const id = await upload(st, ada.cookie, "Revenue was 1,200 in 2024");
    await visualizeOutcome(st, ada.userId, id);
    const retry = await fetch(`${st.base}/api/documents/${id}/visuals/retry`, {
      method: "POST",
      headers: { cookie: ada.cookie },
    });
    expect(retry.status).toBe(202);
    await visualizeEnd(st, ada.userId, id, 1);
    const del = await fetch(`${st.base}/api/documents/${id}`, {
      method: "DELETE",
      headers: { cookie: ada.cookie },
    });
    expect(del.status).toBe(204);
    expect(await runRow(st, id)).toEqual([]);
  }, 120_000);

  it("the next boot re-runs a document whose last run ended visuals-model-unavailable, once", async () => {
    const first = await startIngestStack({ visuals: true });
    stacks.push(first);
    stubVisuals(first.visualsClaude as FakeAnthropic, [ADA], { value: true });
    const ada = await first.signUpAndLogIn("ada@example.com");
    const id = await upload(first, ada.cookie, "Revenue was 1,200 in 2024", { visuals: false });
    expect(await visualizeEnd(first, ada.userId, id)).toEqual({
      outcome: "failed",
      code: "visuals-model-unavailable",
    });
    await vi.waitFor(async () => expect((await runRow(first, id))[0]?.state).toBe("failed"));
    await first.close({ keepDb: true });
    stacks.splice(stacks.indexOf(first), 1);

    const second = await startIngestStack({
      visuals: true,
      resume: { db: first.db, kek: first.kek, root: first.root },
    });
    stacks.push(second);
    stubVisuals(second.visualsClaude as FakeAnthropic, [ADA]);
    // The sweep of this boot already ran with the default (healthy) model reply; wait for the re-run's end.
    expect(await visualizeEnd(second, ada.userId, id, 1)).toEqual({ outcome: "done" });
    const served = UiViewResponse.parse(await (await detail(second, ada.cookie, id)).json());
    expect(served.visuals).toEqual({ state: "ready" });
    await second.composed.visuals.idle();
    const ids = (await second.durable.raw.eventStore.listExecutions?.()) ?? [];
    expect(ids.filter((e) => e.includes(`visualize-${id}`)).sort()).toEqual(
      [visualizeExecutionId(ada.userId, id, 2), visualizeExecutionId(ada.userId, id, 2, 1)].sort(),
    ); // one re-run, not two
  }, 180_000);
});
