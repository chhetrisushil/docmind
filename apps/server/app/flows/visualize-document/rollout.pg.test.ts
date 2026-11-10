import { randomUUID } from "node:crypto";
import { factFormatFingerprint } from "@docmind/experiences";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { InMemoryContentStore } from "@loom/plugin-content";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import type { WorkflowRuntime } from "@loom/workflow-runtime";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { buildApp } from "../../config";
import { FieldCrypto } from "../../crypto/fields";
import { migrate, setAppRolePassword } from "../../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../../db/testSupport";
import { InMemoryProgressBus } from "../../documents/progress";
import { ALICE, U1, seedDoc, seedRow, seedUsers } from "../../documents/testHarness";
import { opaqueIds } from "../../opaqueIds";
import {
  deterministicUser,
  legacyIngestId,
  legacyVisualizeId,
  testIdSource,
} from "../../opaqueIds/testing";
import { SENSITIVE_EVENT_PATHS } from "../../sensitive";
import { subjectOfExecution } from "../../subject";
import type { VisualizeDeps } from "./deps";
import {
  AGGREGATE_ORDINAL_BASE,
  type ExtractionWrite,
  type Fact,
  STRUCTURE_ORDINAL_BASE,
  type StructureFact,
} from "./facts";
import { visualizeDocumentFlow } from "./flow";
import { visualsPlanner } from "./planner";
import { PgVisualRuns, visualRunRecorder } from "./runs";
import { loomVisualsStarter, pgStaleFormatDocuments } from "./start";
import type { StructureReader } from "./structure";
import { experienceIdOf, lineageTestIds } from "./testSupport";
import { childrenOf } from "./testing";

const NIL = "00000000-0000-0000-0000-000000000000";
const CHUNK = randomUUID();
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 3);
const PLAN = JSON.stringify({
  summary: "Revenue and outline",
  nodes: [
    {
      id: "revenue",
      type: "KeyFigure",
      label: "Revenue",
      span: 4,
      props: {},
      binding: { capability: "fact-0", arguments: {}, path: "value", priority: "P0" },
    },
    {
      id: "outline",
      type: "DocumentOutline",
      label: "Outline",
      span: 12,
      props: {},
      binding: { capability: "fact-16", arguments: {}, path: "nodes", priority: "P1" },
    },
  ],
});
const READER: StructureReader = {
  title: async () => "Report",
  headings: async () => [
    { chunkId: CHUNK, sectionOrdinal: 1, headingPath: ["One"] },
    { chunkId: CHUNK, sectionOrdinal: 2, headingPath: ["Two"] },
    { chunkId: CHUNK, sectionOrdinal: 3, headingPath: ["Two", "Sub"] },
  ],
  entities: async () => [],
  mentions: async () => [],
};

describe.skipIf(!PG_URL)("rollout of the structure release (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let owner: Pool;
  let app: Pool;
  let fields: FieldCrypto;
  const apps: ReturnType<typeof buildApp>[] = [];
  beforeAll(async () => {
    db = await createTestDb();
    owner = db.owner;
    await migrate(owner);
    await setAppRolePassword(owner, APP_PASSWORD);
    await seedUsers(owner);
    app = new Pool({ connectionString: db.appUrl });
    fields = new FieldCrypto(new InMemoryKeyStore());
  });
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
  });
  afterAll(async () => {
    await app.end();
    await db.drop();
  });

  it("S6: a document stamped with the old fingerprint is re-planned once by the boot stale pass, with structure derived and no extraction, then restamped", async () => {
    const id = await seedDoc(owner, app, fields, ALICE, "f".repeat(64), 600);
    const g = Number(
      (await owner.query("SELECT ingest_generation FROM documents WHERE id = $1", [id])).rows[0]
        .ingest_generation,
    );
    await seedRow(
      owner,
      legacyIngestId(U1, id, g),
      id,
      U1,
      '{"status":"ready","step":"finalize","code":null}',
    );
    const runs = new PgVisualRuns(app);
    // The document was planned before this release: run 0 done, stamped with the previous fact format.
    await runs.record(
      { userId: U1, documentId: id, generation: g, run: 0 },
      "done",
      undefined,
      "docmind:visual.facts@1+docmind:turn.facts@1+docmind:doc.connections@1",
    );
    const list = pgStaleFormatDocuments(app); // the current fingerprint
    expect((await list(NIL, 10)).map((d) => d.documentId)).toEqual([id]);

    // The process under test: the real 1.1.0 flow, an in-memory log, the real recorder writing visual_runs.
    const requests: LlmRequest[] = [];
    const llm: LlmProvider & { model: string } = {
      model: "claude-test",
      complete: async (r: LlmRequest) => {
        requests.push(r);
        return { content: PLAN, stopReason: "end_turn" };
      },
    };
    const planner = visualsPlanner(llm, KEY);
    let held: ExtractionWrite[] = [
      { kind: "figure", label: "Revenue", value: 4242, chunkIds: [CHUNK], ordinal: 0 },
    ];
    let structured: StructureFact[] = [];
    const afterDone = new Set<string>();
    const lineage = new Lineage({
      events: new InMemoryLineageStore(),
      content: new InMemoryContentStore(),
    });
    const bus = new InMemoryProgressBus();
    const deps: VisualizeDeps = {
      guard: { begin: async () => {} },
      chunks: { sectionsOf: async () => [{ id: CHUNK, sectionOrdinal: 0 }], read: async () => [] },
      facts: {
        replace: async (_r, facts) => {
          held = [...facts];
          return facts.length;
        },
        replaceStructure: async (_r, facts) => {
          structured = [...facts];
          return facts.length;
        },
        list: async () => held.filter((f) => f.ordinal < STRUCTURE_ORDINAL_BASE) as Fact[],
        listAll: async () => [...held, ...structured],
        aggregateCount: async () => held.filter((f) => f.ordinal >= AGGREGATE_ORDINAL_BASE).length,
        extractFormat: async () => null,
      },
      structure: READER,
      summaryMaxChars: 400_000,
      bus,
      lineage,
      ids: lineageTestIds,
      now: () => "2026-11-10T10:00:00.000Z",
      sleep: async () => {},
      afterDone,
      llm,
      planner,
    };
    const flow = visualizeDocumentFlow(() => planner);
    const log = new EncryptingEventStore(new InMemoryAsyncEventStore(), new InMemoryKeyStore(), {
      sensitive: { ...SENSITIVE_EVENT_PATHS },
      subjectOf: subjectOfExecution,
    });
    const built = buildApp(
      { kind: "custom", eventStore: log },
      { events: log },
      { visualize: { flow, deps } },
    );
    apps.push(built);
    const recorder = visualRunRecorder({
      runs,
      bus,
      onError: (e) => {
        throw e;
      },
    });
    const ended: Promise<void>[] = [];
    const runtime = {
      cancel: async () => {},
      start: async (f: never, input: never, o: { executionId: string }) => {
        const handle = await built.runtime.start(f, input, o as never);
        ended.push(
          handle.waitForCompletion().then((state) => {
            recorder.onEvent({
              id: randomUUID(),
              workflowId: "visualize-document",
              executionId: o.executionId,
              eventType: "EXECUTION_COMPLETED",
              sequence: 99,
              timestamp: 1,
              payload: { output: state.variables._output },
            } as EventEnvelope);
          }),
        );
        return handle;
      },
    };
    // The recorder parses the new-format execution id through the process-wide id cache: the starter's own cache is installed for this test.
    const ids = testIdSource();
    opaqueIds.install(ids);
    onTestFinished(() => opaqueIds.install(undefined));
    const starter = loomVisualsStarter(
      runtime as unknown as Pick<WorkflowRuntime, "start" | "cancel">,
      flow,
      { ids, stale: list, runs, afterDone },
    );

    expect(await starter.sweep()).toBe(1); // boot pass: re-planned once
    await Promise.all(ended);
    await recorder.idle();

    expect(requests).toHaveLength(1); // the planner call only: zero extraction requests
    expect(structured.map((f) => f.ordinal)).toEqual([16]); // structure derived
    const latest = await lineage.resolveLatest(
      await experienceIdOf({ tenantId: ALICE.tenantId, userId: U1, documentId: id }),
    );
    expect(latest.ok && childrenOf(latest.value.root).map((c) => c.id)).toEqual([
      "revenue",
      "outline",
    ]);
    const row = (
      await owner.query("SELECT run, state, format FROM visual_runs WHERE document_id = $1", [id])
    ).rows;
    expect(row).toEqual([{ run: 1, state: "done", format: factFormatFingerprint() }]); // restamped
    expect(await list(NIL, 10)).toEqual([]); // the next boot lists nothing
    expect(await starter.sweep()).toBe(0);
    expect(requests).toHaveLength(1);
    expect(legacyVisualizeId(U1, id, g, 1)).toBeTruthy();
  });

  it("D5 (timeline and relations): a document planned before c2, stamped with the current fingerprint, is not listed by the stale pass, and a boot sweep re-plans only the one stamped with an older format", async () => {
    // The literal is the fingerprint on `main` before the c2 release: if a change moves factFormatFingerprint(), this fails.
    const C1_FORMAT =
      "docmind:visual.facts@1+docmind:turn.facts@1+docmind:doc.connections@1+docmind.structure@1";
    expect(factFormatFingerprint()).toBe(C1_FORMAT);
    const runs = new PgVisualRuns(app);
    const seed = async (fingerprint: string, age: number, format: string) => {
      const id = await seedDoc(owner, app, fields, ALICE, fingerprint, age);
      const g = Number(
        (await owner.query("SELECT ingest_generation FROM documents WHERE id = $1", [id])).rows[0]
          .ingest_generation,
      );
      await seedRow(
        owner,
        legacyIngestId(U1, id, g),
        id,
        U1,
        '{"status":"ready","step":"finalize","code":null}',
      );
      await runs.record(
        { userId: U1, documentId: id, generation: g, run: 0 },
        "done",
        undefined,
        format,
      );
      return { id, g };
    };
    const current = await seed("e".repeat(64), 610, C1_FORMAT);
    const older = await seed(
      "d".repeat(64),
      611,
      "docmind:visual.facts@1+docmind:turn.facts@1+docmind:doc.connections@1", // before c1: the control
    );
    const listed = (await pgStaleFormatDocuments(app)(NIL, 50)).map((d) => d.documentId);
    expect(listed).toContain(older.id); // the control: the pass does list a stale document
    expect(listed).not.toContain(current.id);

    // A boot sweep over the real stale source re-plans the stale document and nothing for the current one.
    const start = vi.fn(
      async (_f: unknown, _i: unknown, o: { executionId: string }) =>
        ({ executionId: o.executionId, waitForCompletion: async () => {} }) as never,
    );
    const starter = loomVisualsStarter(
      { start, cancel: vi.fn() } as unknown as Pick<WorkflowRuntime, "start" | "cancel">,
      visualizeDocumentFlow(),
      { ids: testIdSource(), stale: pgStaleFormatDocuments(app), runs },
    );
    expect(await starter.sweep()).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect((start.mock.calls[0] as unknown[])[2]).toMatchObject({
      executionId: deterministicUser(U1).visualize(older.id, older.g, 1),
    });
  });
});
