import { DocumentTagsResponse, ListDocumentsResponse, TagResponse } from "@docmind/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { suggestTagsExecutionId } from "../flows/suggest-tags/start";
import { ingestExecutionId } from "./ingest";
import {
  ALICE,
  type DocumentHarness,
  callApi,
  getDoc,
  startDocumentServer,
  uploadAndAwaitTerminal,
} from "./testHarness";

const WAIT = 60_000;
const md = (word: string) =>
  `# Notes\n\n${Array.from({ length: 4 }, (_, i) => `Paragraph ${i}. ${`${word} programme ledger `.repeat(22)}`).join("\n\n")}`;
const TLDR = "Reduce answer: the programme is on track";

describe.skipIf(!PG_URL)("document tags end to end (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  const DEFAULTS = {
    ingestTags: ["Finance", "Q3 plan", "Kestrel", "Fourth new one"] as unknown,
    suggestTags: ["Legal", "Q3 plan"] as unknown,
  };
  const state = { ...DEFAULTS };
  beforeAll(async () => {
    h = await startDocumentServer({ llm: true });
    h.fake.reply((body) => {
      const system = String((body as { system?: unknown }).system ?? "");
      if (system.startsWith("You combine"))
        return {
          text: JSON.stringify({
            tldr: TLDR,
            keyPoints: ["k"],
            entities: [],
            topics: ["t"],
            suggestedQuestions: ["q?"],
            suggestedTags: state.ingestTags,
          }),
        };
      if (system.startsWith("You suggest tags"))
        return { text: JSON.stringify({ suggestedTags: state.suggestTags }) };
      return { text: JSON.stringify({ summary: "part", entities: [] }) };
    });
  }, WAIT);
  afterAll(async () => void (await h?.close()));
  // Each test starts from the same model answers and no tags, so none depends on what an earlier one left (preflight F13).
  beforeEach(async () => {
    Object.assign(state, DEFAULTS);
    await h.owner.query("DELETE FROM tags");
  });

  const call = (method: string, path: string, body?: unknown) =>
    callApi(h, "alice", method, path, body);
  const list = async (qs: string) =>
    ListDocumentsResponse.parse(await (await call("GET", `/api/documents?${qs}`)).json()).items.map(
      (d) => d.id,
    );
  const tagIdOf = async (name: string) =>
    (
      (await (await call("GET", "/api/tags")).json()) as { tags: { id: string; name: string }[] }
    ).tags.find((t) => t.name === name)?.id as string;

  it(
    "upload, suggestions appear without being applied, accept one; the log holds no tag name; existing tags steer the next prompt",
    async () => {
      const id = await uploadAndAwaitTerminal(h, "alice", "a.md", md("Kestrel"), "ready");
      const doc = await getDoc(h, "alice", id);
      expect(doc.tags).toEqual([]); // never applied automatically
      expect(doc.suggestedTags).toEqual(["Finance", "Q3 plan", "Kestrel"]); // at most 3 new names
      const accepted = DocumentTagsResponse.parse(
        await (
          await call("POST", `/api/documents/${id}/tag-suggestions/accept`, { name: "q3 PLAN" })
        ).json(),
      );
      expect([accepted.tags.map((t) => t.name), accepted.suggestedTags]).toEqual([
        ["q3 PLAN"],
        ["Finance", "Kestrel"],
      ]);
      const dismissed = DocumentTagsResponse.parse(
        await (
          await call("POST", `/api/documents/${id}/tag-suggestions/dismiss`, { name: "Kestrel" })
        ).json(),
      );
      expect(dismissed.suggestedTags).toEqual(["Finance"]);

      const log = JSON.stringify(await h.eventStore.read(ingestExecutionId(ALICE.userId, id, 1)));
      for (const name of ["Finance", "Q3 plan", "q3 PLAN", "Kestrel", "Fourth new one"])
        expect(log).not.toContain(name);

      // The user's tag names go to the configured provider in the next summary prompt, and the model maps onto them.
      state.ingestTags = ["Q3 PLAN", "brand new"];
      const second = await uploadAndAwaitTerminal(h, "alice", "b.md", md("Osprey"), "ready");
      const reduce = h.fake.requests.filter(
        (r) =>
          JSON.stringify(r).includes("suggestedTags") && JSON.stringify(r).includes("already uses"),
      );
      expect(JSON.stringify(reduce.at(-1))).toContain('[\\"q3 PLAN\\"]');
      expect((await getDoc(h, "alice", second)).suggestedTags).toEqual(["q3 PLAN", "brand new"]); // the existing tag keeps its display name
    },
    WAIT,
  );

  it(
    "filters across three documents with Any and with All, paged without a gap",
    async () => {
      await h.owner.query("DELETE FROM tags");
      const ids = [
        await uploadAndAwaitTerminal(h, "alice", "x1.md", md("Alpha"), "ready"),
        await uploadAndAwaitTerminal(h, "alice", "x2.md", md("Bravo"), "ready"),
        await uploadAndAwaitTerminal(h, "alice", "x3.md", md("Charlie"), "ready"),
      ];
      const add = (doc: string, name: string) =>
        call("POST", `/api/documents/${doc}/tags`, { name });
      for (const [doc, names] of [
        [ids[0], ["red"]],
        [ids[1], ["red", "blue"]],
        [ids[2], ["blue"]],
      ] as const)
        for (const n of names) await add(doc as string, n);
      const red = await tagIdOf("red");
      const blue = await tagIdOf("blue");
      const onlyMine = (found: string[]) => found.filter((x) => ids.includes(x)).sort();
      const sorted = (...xs: (string | undefined)[]) => xs.filter(Boolean).sort() as string[];
      expect(onlyMine(await list(`tags=${red},${blue}&match=any`))).toEqual(sorted(...ids));
      expect(onlyMine(await list(`tags=${red},${blue}&match=all`))).toEqual(sorted(ids[1]));
      expect(onlyMine(await list(`tags=${red}`))).toEqual(sorted(ids[0], ids[1]));
      const paged: string[] = [];
      let cursor: string | null = null;
      do {
        const res: Response = await call(
          "GET",
          `/api/documents?tags=${red},${blue}&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
        );
        const page = ListDocumentsResponse.parse(await res.json());
        paged.push(...page.items.map((d) => d.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(paged.sort()).toEqual(sorted(...ids));
    },
    WAIT,
  );

  it(
    "renames a tag (rows follow) and deletes one (the documents stay, the links go)",
    async () => {
      const id = await uploadAndAwaitTerminal(h, "alice", "r.md", md("Delta"), "ready");
      const tag = TagResponse.parse(
        await (await call("POST", "/api/tags", { name: "temp-name" })).json(),
      ).tag;
      await call("PUT", `/api/documents/${id}/tags`, { tagIds: [tag.id] });
      expect((await call("PATCH", `/api/tags/${tag.id}`, { name: "final-name" })).status).toBe(200);
      expect((await getDoc(h, "alice", id)).tags.map((t) => t.name)).toEqual(["final-name"]);
      expect((await call("DELETE", `/api/tags/${tag.id}`)).status).toBe(204);
      expect((await getDoc(h, "alice", id)).tags).toEqual([]);
      expect(await list(`tags=${tag.id}`)).toEqual([]);
      expect((await call("GET", `/api/documents/${id}`)).status).toBe(200);
    },
    WAIT,
  );

  it(
    "Suggest tags on an existing document: one run for a double press, reads only the summary, no tag name in the log",
    async () => {
      const id = await uploadAndAwaitTerminal(h, "alice", "s.md", md("Echo"), "ready");
      const before = h.fake.requests.length;
      const gate = h.fake.holdNext(); // the suggestion call parks, so the second press finds a run in flight
      const first = await call("POST", `/api/documents/${id}/tag-suggestions/refresh`);
      expect(first.status).toBe(202);
      const second = await call("POST", `/api/documents/${id}/tag-suggestions/refresh`);
      expect([
        second.status,
        ((await second.json()) as { error: { code: string } }).error.code,
      ]).toEqual([409, "suggest_running"]);
      gate.release();
      await expectSuggestions(id, ["Legal", "Q3 plan"]);
      const calls = h.fake.requests
        .slice(before)
        .filter((r) => JSON.stringify(r).includes("You suggest tags"));
      expect(calls).toHaveLength(1);
      const sent = JSON.stringify(calls[0]);
      expect(sent).toContain(TLDR); // the stored summary
      expect(sent).not.toContain("Paragraph 0."); // never a passage
      const log = JSON.stringify(
        await h.eventStore.read(suggestTagsExecutionId(ALICE.userId, id, 1)),
      );
      for (const name of ["Legal", "Q3 plan"]) expect(log).not.toContain(name);
      expect(log).toContain('"outcome":"suggested"');
    },
    WAIT,
  );

  async function expectSuggestions(id: string, want: string[]) {
    await vi.waitFor(
      async () => expect((await getDoc(h, "alice", id)).suggestedTags).toEqual(want),
      { timeout: WAIT },
    );
  }
});
