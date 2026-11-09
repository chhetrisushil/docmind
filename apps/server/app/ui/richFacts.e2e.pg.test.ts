import type { UploadDocumentResponse } from "@docmind/contracts";
import type { FakeAnthropic } from "@docmind/llm-anthropic/testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { CONNECTIONS_PLAN_NODE } from "./testSupport";

const CHUNK_ID = /\[\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/;
const TEXT =
  "# Report\n\nRevenue was 1,200 in 2024. Sales by region: North 300, South 450. Quarterly: Q1 2024 100, Q2 2024 150.\n";
const bind = (id: string, type: string, capability: string) => ({
  id,
  type,
  label: id,
  span: 4,
  props: {},
  binding: { capability, arguments: {}, path: "label", priority: "P1" },
});

function stub(claude: FakeAnthropic) {
  claude.reply((body) => {
    const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    const text = JSON.stringify(body.messages);
    if (system.includes("You extract facts")) {
      const chunk = CHUNK_ID.exec(text)?.[1];
      if (!chunk) return { text: '{"facts":[]}' };
      return {
        text: JSON.stringify({
          facts: [
            { kind: "figure", label: "Revenue", value: 1200, unit: "USD", chunkIds: [chunk] },
            {
              kind: "series",
              label: "Sales by region",
              points: [
                { x: "North", y: 300 },
                { x: "South", y: 450 },
              ],
              chunkIds: [chunk],
            },
            {
              kind: "series",
              label: "Quarterly",
              points: [
                { x: "Q1 2024", y: 100 },
                { x: "Q2 2024", y: 150 },
              ],
              chunkIds: [chunk],
            },
          ],
        }),
      };
    }
    return {
      text: JSON.stringify({
        summary: "x",
        nodes: [
          CONNECTIONS_PLAN_NODE,
          ...(text.includes("fact-0")
            ? [
                bind("headline", "KeyFigure", "fact-0"),
                bind("trendbad", "FigureTrend", "fact-1"),
                bind("chart", "FigureChart", "fact-2"),
                bind("kpibad", "KeyFigure", "fact-1"),
              ]
            : []),
        ],
      }),
    };
  });
}

type Handle = { handle: string; priority: string; params: string[]; finding?: unknown };

describe.skipIf(!PG_URL)("facts that do not fit their widget (needs DOCMIND_TEST_PG_URL)", () => {
  let st: IngestStack;
  afterAll(async () => st?.close());

  it("are dropped at commit: every handle the web requests hydrates with no reshape-failed", async () => {
    st = await startIngestStack({ visuals: true, chat: true });
    stub(st.visualsClaude as FakeAnthropic);
    const u = await st.signUpAndLogIn("ada@example.com");
    const events = await st.events(u.cookie);
    const res = await st.upload(u.cookie, "report.md", Buffer.from(TEXT));
    const id = ((await res.json()) as UploadDocumentResponse).document.id;
    await st.until(events, id, (s) => s === "ready" || s === "failed");
    await st.until(events, id, () => true);
    events.close();

    const view = (await (
      await fetch(`${st.base}/api/ui/documents/${id}/detail?surface=web`, {
        headers: { cookie: u.cookie },
      })
    ).json()) as { experienceId: string; versionHash: string; inventory: { handles: Handle[] } };
    const handles = view.inventory.handles.filter((h) => !h.finding && h.priority !== "P2");
    expect(handles.length).toBeGreaterThan(0);

    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });
    let results: { state: string; finding?: { code: string } }[];
    try {
      const r = await fetch(`${st.base}/api/ui/hydrate`, {
        method: "POST",
        headers: { cookie: u.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          document: id,
          requests: handles.map((h) => ({
            experienceId: view.experienceId,
            versionHash: view.versionHash,
            handle: h.handle,
            params: Object.fromEntries(
              Object.entries({ id, upto: 20 }).filter(([k]) => h.params.includes(k)),
            ),
          })),
        }),
      });
      results = ((await r.json()) as { results: typeof results }).results;
    } finally {
      spy.mockRestore();
    }
    expect(results.map((x) => x.finding?.code).filter(Boolean)).toEqual([]);
    expect(logged.filter((l) => l.includes("reshape-failed"))).toEqual([]);
    expect(logged.filter((l) => l.startsWith("ui finding"))).toEqual([]);
    // The two fitting widgets (the headline and the quarterly chart) and the connections ones remain; the two misfits are gone.
    const bound = JSON.stringify(view.inventory.handles);
    expect(bound).toContain("fact-0");
    expect(bound).toContain("fact-2");
  });
});
