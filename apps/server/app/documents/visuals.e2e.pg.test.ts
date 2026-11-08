import type { UploadDocumentResponse } from "@docmind/contracts";
import { UiViewResponse } from "@docmind/contracts";
import type { FakeAnthropic } from "@docmind/llm-anthropic/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNoPlaintext } from "../chats/eventLogProof";
import { PG_URL } from "../db/testSupport";
import { eraseMe, waitErased } from "../erasure/e2eSupport";
import type { PgFixture } from "../flows/ingest-document/pgFixture";
import { experienceIdOf, visualsLineage } from "../flows/visualize-document/lineage";
import { PgVisualFacts } from "../flows/visualize-document/pgFacts";
import { visualizeExecutionId } from "../flows/visualize-document/start";
import { collectLineageContent } from "../storage/lineageGc";
import { lineageGcDeps } from "../storage/pgLineageGc";
import { subjectOfExecution } from "../subject";
import { CONNECTIONS_PLAN_NODE, connectionsSeeder } from "../ui/testSupport";
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
const CONNECTIONS_NODES = [
  CONNECTIONS_PLAN_NODE,
  { ...CONNECTIONS_PLAN_NODE, id: "map", type: "ConnectionMap", label: "Connection map" },
];

/** A document whose text carries this finds no facts (the text-only case). */
const NO_FACTS = "Plain-prose-without-figures";

function stubVisuals(
  claude: FakeAnthropic,
  figures: Figure[],
  down?: { value: boolean },
  connections = false,
) {
  claude.reply((body) => {
    if (down?.value) return { status: 503, rawBody: "{}" }; // the visuals model is unavailable
    const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    const text = JSON.stringify(body.messages);
    const { label, value } = figures.find((f) => text.includes(f.marker)) ?? (ADA as Figure);
    if (system.includes("You extract facts")) {
      const chunk = CHUNK_ID.exec(text)?.[1];
      if (!chunk || text.includes(NO_FACTS)) return { text: '{"facts":[]}' };
      return {
        text: JSON.stringify({
          facts: [{ kind: "figure", label, value, unit: "USD", chunkIds: [chunk] }],
        }),
      };
    }
    if (!text.includes("fact-0")) {
      // The connections capability alone (no facts were found).
      return {
        text: JSON.stringify({
          summary: "The documents this one connects to",
          nodes: connections ? CONNECTIONS_NODES : [],
        }),
      };
    }
    return {
      text: JSON.stringify({
        summary: "A headline figure",
        nodes: [
          ...(connections ? CONNECTIONS_NODES : []),
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
  // Each test's stacks close when the test ends: holding every stack (each with its own pools) open until the end of the
  // file exhausts a default-sized Postgres (CI's max_connections is 100).
  afterEach(async () => {
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
    opts: { visuals: boolean; name?: string } = { visuals: true },
  ) {
    const events = await st.events(cookie);
    try {
      const res = await st.upload(cookie, opts.name ?? "report.txt", Buffer.from(text));
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

  it("the production collector wiring runs over real visuals: no refusal, the document's blobs are roots and survive", async () => {
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    stubVisuals(st.visualsClaude as FakeAnthropic, [ADA]);
    const ada = await st.signUpAndLogIn("gc@example.com");
    await upload(st, ada.cookie, "Revenue was 1,200 in 2024");
    const before = (await st.app.query("SELECT count(*)::int AS n FROM lineage_content")).rows[0].n;
    expect(before).toBeGreaterThan(0);
    const report = await collectLineageContent(
      lineageGcDeps(st.composed.lineageGc, st.durable.pool, st.app, 86_400_000),
    );
    expect(report.refused).toBeUndefined();
    expect(report.roots).toBeGreaterThan(0);
    expect(report).toMatchObject({ failed: 0, notDue: false });
    expect((await st.app.query("SELECT count(*)::int AS n FROM lineage_content")).rows[0].n).toBe(
      before,
    );
  });

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
    // The boot's retry list only holds failures at least an hour old.
    await first.db.owner.query(
      "UPDATE visual_runs SET updated_at = now() - interval '2 hours' WHERE document_id = $1",
      [id],
    );
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

  it("a run whose end event was lost (a stale running row) is repaired on the next read, and Retry works again", async () => {
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    const down = { value: true };
    stubVisuals(st.visualsClaude as FakeAnthropic, [ADA], down);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const id = await upload(st, ada.cookie, "Revenue was 1,200 in 2024", { visuals: false });
    await visualizeEnd(st, ada.userId, id);
    await vi.waitFor(async () => expect((await runRow(st, id))[0]?.state).toBe("failed"));
    // The recorded end is lost: the row says running although the execution failed over.
    await st.db.owner.query(
      "UPDATE visual_runs SET state = 'running', code = NULL WHERE document_id = $1",
      [id],
    );
    const served = UiViewResponse.parse(await (await detail(st, ada.cookie, id)).json());
    expect(served.visuals).toEqual({ state: "failed" }); // read from Loom's state, not stuck at running
    expect(await runRow(st, id)).toEqual([
      { run: 0, state: "failed", code: "visuals-model-unavailable" },
    ]);
    // Another lost end, then a retry: it repairs first and starts the next run instead of answering 409 forever.
    await st.db.owner.query(
      "UPDATE visual_runs SET state = 'running', code = NULL WHERE document_id = $1",
      [id],
    );
    down.value = false;
    const retry = await fetch(`${st.base}/api/documents/${id}/visuals/retry`, {
      method: "POST",
      headers: { cookie: ada.cookie },
    });
    expect(retry.status).toBe(202);
    expect(await visualizeEnd(st, ada.userId, id, 1)).toEqual({ outcome: "done" });
    await vi.waitFor(async () =>
      expect(await runRow(st, id)).toEqual([{ run: 1, state: "done", code: null }]),
    );
  }, 120_000);

  it("the next boot repairs a stale running row from Loom's state; the repaired unavailable failure is fresh, so it is not re-run until it is an hour old", async () => {
    const first = await startIngestStack({ visuals: true });
    stacks.push(first);
    stubVisuals(first.visualsClaude as FakeAnthropic, [ADA], { value: true });
    const ada = await first.signUpAndLogIn("ada@example.com");
    const id = await upload(first, ada.cookie, "Revenue was 1,200 in 2024", { visuals: false });
    await visualizeEnd(first, ada.userId, id);
    await vi.waitFor(async () => expect((await runRow(first, id))[0]?.state).toBe("failed"));
    await first.db.owner.query(
      "UPDATE visual_runs SET state = 'running', code = NULL WHERE document_id = $1",
      [id],
    );
    await first.close({ keepDb: true });
    stacks.splice(stacks.indexOf(first), 1);

    const second = await startIngestStack({
      visuals: true,
      resume: { db: first.db, kek: first.kek, root: first.root },
    });
    stacks.push(second);
    stubVisuals(second.visualsClaude as FakeAnthropic, [ADA]);
    await vi.waitFor(async () =>
      expect(await runRow(second, id)).toEqual([
        { run: 0, state: "failed", code: "visuals-model-unavailable" },
      ]),
    ); // repaired from Loom's output; the repair is stamped now, so the retry pass leaves it for a later boot
    await second.db.owner.query(
      "UPDATE visual_runs SET updated_at = now() - interval '2 hours' WHERE document_id = $1",
      [id],
    );
    expect(await second.composed.visuals.sweep()).toBeGreaterThanOrEqual(1);
    await second.composed.visuals.idle();
    await vi.waitFor(async () =>
      expect(await runRow(second, id)).toEqual([{ run: 1, state: "done", code: null }]),
    );
  }, 180_000);

  /** Seeds what the ingest (which has no entity model here) would write: one entity on a chunk of each document, linked both ways. */
  async function connect(
    st: IngestStack,
    who: { userId: string; tenantId: string },
    a: string,
    b: string,
    name: string,
  ) {
    const seed = connectionsSeeder(
      () => ({ db: st.db, fields: st.fields }) as unknown as PgFixture,
      who,
    );
    const chunkOf = async (id: string) =>
      (
        await st.db.owner.query(
          "SELECT id FROM chunks WHERE document_id = $1 ORDER BY ordinal LIMIT 1",
          [id],
        )
      ).rows[0].id as string;
    const [ca, cb] = [await chunkOf(a), await chunkOf(b)];
    await seed.entity(name, [ca, cb]);
    await seed.link(ca, cb, 0.8, "entity");
  }

  const eventLog = async (st: IngestStack) => {
    const ids = (await st.durable.raw.eventStore.listExecutions?.()) ?? [];
    return (await Promise.all(ids.map((id) => st.durable.raw.eventStore.read(id)))).flat();
  };

  it("connections are live: A shows B once B shares an entity with it, with no re-plan of A, and nothing after B is deleted", async () => {
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    stubVisuals(st.visualsClaude as FakeAnthropic, [ADA, BEN], undefined, true);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const a = await upload(st, ada.cookie, "Revenue was 1,200 in 2024", {
      visuals: true,
      name: "alpha-ledger-2024.txt",
    });
    expect(await visualizeOutcome(st, ada.userId, a)).toBe("done");

    type Table = { rows: string[][]; rowKeys?: string[] };
    type GraphMap = { nodes: { id: string; label: string; group: string }[] };
    const table = async () =>
      (await hydrate(st, ada.cookie, a, "connections-table")) as { state: string; value: Table };
    const graph = async () =>
      (await hydrate(st, ada.cookie, a, "connections-map")) as { state: string; value: GraphMap };
    const visualizeRuns = async () =>
      ((await st.durable.raw.eventStore.listExecutions?.()) ?? [])
        .filter((e) => e.includes(`visualize-${a}`))
        .sort();
    const versionOf = async () =>
      UiViewResponse.parse(await (await detail(st, ada.cookie, a)).json()).versionHash;

    // A, uploaded first, already has the section, empty.
    expect((await table()).value.rows).toEqual([["No connected documents yet", "", ""]]);
    expect((await graph()).value.nodes.map((n) => n.group)).toEqual(["self"]);
    const runsBefore = await visualizeRuns();
    const versionBefore = await versionOf();
    expect(runsBefore.length).toBeGreaterThan(0);

    // B arrives and shares an entity with A.
    const b = await upload(st, ada.cookie, "Zebra takings were 7,391.25 in 2024", {
      visuals: true,
      name: "bravo-ledger-2024.txt",
    });
    await connect(st, ada, a, b, "Acme-Holdings-International");
    const titleOfB = (
      (await (await get(st, ada.cookie, `/api/documents/${b}`)).json()) as { title: string }
    ).title;
    const live = await table();
    expect(live.state).toBe("ready");
    expect(live.value.rowKeys).toEqual([b]);
    expect(live.value.rows[0]?.[0]).toBe(titleOfB);
    expect(live.value.rows[0]?.[1]).toContain("Acme-Holdings-International");
    const liveMap = (await graph()).value.nodes;
    expect(liveMap.some((n) => n.group === "document" && n.label === titleOfB)).toBe(true);
    expect(
      liveMap.some((n) => n.group === "entity" && n.label === "Acme-Holdings-International"),
    ).toBe(true);

    // No re-plan of A: the same visualize executions and the same served experience.
    expect(await visualizeRuns()).toEqual(runsBefore);
    expect(await versionOf()).toBe(versionBefore);

    // Another user cannot read A's connections.
    const other = await st.signUpAndLogIn("other@example.com");
    const view = UiViewResponse.parse(await (await detail(st, ada.cookie, a)).json());
    const foreign = await fetch(`${st.base}/api/ui/hydrate`, {
      method: "POST",
      headers: { cookie: other.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        document: a,
        requests: [
          {
            experienceId: view.experienceId,
            versionHash: view.versionHash,
            handle: "connections-table",
            params: {},
          },
        ],
      }),
    });
    expect(foreign.status).toBe(404);

    // Nothing readable in the event log: no title, no entity name.
    expect(titleOfB.length).toBeGreaterThanOrEqual(12);
    assertNoPlaintext(await eventLog(st), [
      titleOfB,
      "Acme-Holdings-International",
      "alpha-ledger-2024",
    ]);

    // Deleting B removes it on the next hydrate.
    const del = await fetch(`${st.base}/api/documents/${b}`, {
      method: "DELETE",
      headers: { cookie: ada.cookie },
    });
    expect(del.status).toBe(204);
    await vi.waitFor(async () =>
      expect((await table()).value.rows).toEqual([["No connected documents yet", "", ""]]),
    );
    expect((await graph()).value.nodes.map((n) => n.group)).toEqual(["self"]);
  }, 180_000);

  it("a text-only document with no facts still gets a Connections section", async () => {
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    stubVisuals(st.visualsClaude as FakeAnthropic, [ADA, BEN], undefined, true);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const a = await upload(st, ada.cookie, `${NO_FACTS} describing the situation in words only`, {
      visuals: true,
    });
    expect(await visualizeOutcome(st, ada.userId, a)).toBe("done");
    const view = UiViewResponse.parse(await (await detail(st, ada.cookie, a)).json());
    expect(view.visuals?.state).toBe("ready");
    expect((await hydrate(st, ada.cookie, a, "connections-table"))?.value).toMatchObject({
      rows: [["No connected documents yet", "", ""]],
    });
    const b = await upload(st, ada.cookie, "Zebra takings were 7,391.25 in 2024", {
      visuals: true,
    });
    await connect(st, ada, a, b, "Globex-Industries-Ltd");
    const t = (await hydrate(st, ada.cookie, a, "connections-table"))?.value as {
      rowKeys?: string[];
    };
    expect(t.rowKeys).toEqual([b]);
  }, 180_000);
});
