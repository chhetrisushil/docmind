import { randomUUID } from "node:crypto";
import { replay } from "@loom-ui/core";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import { registerLineageSensitivePaths } from "@loom-ui/lineage";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryContentStore } from "@loom/plugin-content";
import {
  EncryptingContentStore,
  EncryptingEventStore,
  InMemoryKeyStore,
} from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { subjectOfExecution } from "../../subject";
import { turnExperienceId } from "../visualize-turn/ids";
import { TURN_INTENT } from "../visualize-turn/plan";
import { aTurnPlan } from "../visualize-turn/testing";
import { HeadMovedError, commitPlan, commitPlanTo, visualsLineage } from "./lineage";
import type { VisualizeRef } from "./pgFacts";
import { experienceIdOf, lineageTestIds } from "./testSupport";
import { aPlan, childrenOf } from "./testing";

const ref = (): VisualizeRef => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  documentId: randomUUID(),
});
const NOW = "2026-11-08T10:00:00.000Z";
const now = () => NOW;
const sealedContent = (inner: InMemoryContentStore, keys: InMemoryKeyStore) =>
  new EncryptingContentStore(inner, keys, { subjectOf: subjectOfExecution });
const newLineage = () =>
  new Lineage({ events: new InMemoryLineageStore(), content: new InMemoryContentStore() });
const startOf = (state: Awaited<ReturnType<Lineage["state"]>>): string => {
  if (!state.ok) throw new Error("no state");
  return state.value.order[0] as string;
};
const childIds = async (lineage: Lineage, r: VisualizeRef) => {
  const latest = await lineage.resolveLatest(await experienceIdOf(r));
  if (!latest.ok) throw new Error("no head");
  return childrenOf(latest.value.root).map((c) => c.id);
};

describe("commitPlan", () => {
  it("creates the line on the first commit; the head's root children are the plan's", async () => {
    const lineage = newLineage();
    const r = ref();
    const plan = await aPlan("revenue", "Revenue");
    expect(plan.ops.length).toBeGreaterThan(0);
    const { head } = await commitPlan(lineage, lineageTestIds, r, plan, now);
    const headResult = await lineage.head(await experienceIdOf(r));
    expect(headResult).toEqual({ ok: true, value: head });
    const latest = await lineage.resolveLatest(await experienceIdOf(r));
    if (!latest.ok) throw new Error("no head");
    expect(latest.value.versionHash).toBe(head);
    // The head is the replay of the plan's ops over the line's genesis.
    const genesisOnly = await lineage.get(
      await experienceIdOf(r),
      startOf(await lineage.state(await experienceIdOf(r))),
    );
    if (!genesisOnly.ok) throw new Error("no genesis");
    const replayed = replay(genesisOnly.value, plan.ops);
    if (!replayed.ok) throw new Error("replay failed");
    expect(childrenOf(latest.value.root)).toEqual(childrenOf(replayed.value.root));
    expect(await childIds(lineage, r)).toEqual(["revenue"]);
  });

  it("replaces the head's content with the next plan, on top of the head", async () => {
    const lineage = newLineage();
    const r = ref();
    const first = await commitPlan(lineage, lineageTestIds, r, await aPlan("a", "A"), now);
    const second = await commitPlan(lineage, lineageTestIds, r, await aPlan("b", "B"), now);
    expect(second.head).not.toBe(first.head);
    const state = await lineage.state(await experienceIdOf(r));
    if (!state.ok) throw new Error("no state");
    expect(state.value.head).toBe(second.head);
    expect(state.value.versions.get(second.head)?.parents).toEqual([first.head]);
    expect(await childIds(lineage, r)).toEqual(["b"]);
  });

  it("a different plan that reuses the same node ids replaces the head's nodes", async () => {
    const lineage = newLineage();
    const r = ref();
    await commitPlan(lineage, lineageTestIds, r, await aPlan("revenue", "Old label"), now);
    await commitPlan(lineage, lineageTestIds, r, await aPlan("revenue", "New label"), now);
    const latest = await lineage.resolveLatest(await experienceIdOf(r));
    if (!latest.ok) throw new Error("no head");
    expect(childrenOf(latest.value.root).map((c) => c.id)).toEqual(["revenue"]);
    const json = JSON.stringify(latest.value.root);
    expect(json).toContain("New label");
    expect(json).not.toContain("Old label");
  });

  it("committing the same plan twice writes one version and returns the same head", async () => {
    const lineage = newLineage();
    const r = ref();
    const plan = await aPlan("revenue", "Revenue");
    const first = await commitPlan(lineage, lineageTestIds, r, plan, now);
    const again = await commitPlan(
      lineage,
      lineageTestIds,
      r,
      plan,
      () => "2026-11-09T00:00:00.000Z",
    );
    expect(again).toEqual(first);
    const versions = await lineage.versions(await experienceIdOf(r));
    expect(versions.ok && versions.value.length).toBe(2); // genesis + the one composed version
  });

  // Moves the head under the commit: the interferer composes first, then the commit's compose sees a stale head.
  const interfering = async (lineage: Lineage, r: VisualizeRef, times: number) => {
    const interferers = await Promise.all(
      Array.from({ length: times }, (_, i) => aPlan(`other${i}`, `Other ${i}`)),
    );
    let moved = 0;
    return {
      head: (id: string) => lineage.head(id),
      resolveLatest: (id: string) => lineage.resolveLatest(id),
      start: (g: Parameters<Lineage["start"]>[0], by: Parameters<Lineage["start"]>[1]) =>
        lineage.start(g, by),
      compose: async (input: Parameters<Lineage["compose"]>[0]) => {
        const next = interferers[moved];
        if (next && moved < times) {
          moved++;
          const head = await lineage.head(await experienceIdOf(r));
          if (!head.ok || head.value === null) throw new Error("no head");
          await lineage.compose({
            ...input,
            expectedHead: head.value,
            ops: next.ops.map((op) => ({ op, by: input.by, at: NOW })),
          });
        }
        return lineage.compose(input);
      },
    } as unknown as Lineage;
  };

  it("retries once when the head moved concurrently", async () => {
    const lineage = newLineage();
    const r = ref();
    await commitPlan(lineage, lineageTestIds, r, await aPlan("a", "A"), now);
    const racing = await interfering(lineage, r, 1);
    await commitPlan(racing, lineageTestIds, r, await aPlan("mine", "Mine"), now);
    expect((await childIds(lineage, r)).sort()).toEqual(["mine"]);
  });

  it("throws when the head moves again on the retry", async () => {
    const lineage = newLineage();
    const r = ref();
    await commitPlan(lineage, lineageTestIds, r, await aPlan("a", "A"), now);
    const racing = await interfering(lineage, r, 2);
    await expect(
      commitPlan(racing, lineageTestIds, r, await aPlan("mine", "Mine"), now),
    ).rejects.toBeInstanceOf(HeadMovedError);
    expect((await childIds(lineage, r)).sort()).toEqual(["a", "other0", "other1"]);
  });
});

describe("a line whose key is gone", () => {
  it("is line-unreadable, not line-erased, when the key store never recorded a destruction", async () => {
    const events = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const content = new InMemoryContentStore();
    const make = (k: InMemoryKeyStore) =>
      visualsLineage({
        events: new EncryptingEventStore(events, k, {
          sensitive: {},
          subjectOf: subjectOfExecution,
        }) as never,
        content: sealedContent(content, k),
        keys: k,
        subjectOf: subjectOfExecution,
      });
    const r = ref();
    await commitPlan(make(keys), lineageTestIds, r, await aPlan("revenue", "Revenue"), now);
    // The same blobs and log on a node whose key store has no key and no record of a destruction.
    const lost = await make(new InMemoryKeyStore()).resolveLatest(await experienceIdOf(r));
    expect(lost).toMatchObject({
      ok: false,
      refusal: { kind: "refused", finding: { code: "line-unreadable" } },
    });
  });
});

describe("visualsLineage", () => {
  it("refuses a content store that does not seal (fails closed)", () => {
    const keys = new InMemoryKeyStore();
    expect(() =>
      visualsLineage({
        events: new InMemoryAsyncEventStore() as never,
        content: new InMemoryContentStore(),
        keys,
        subjectOf: subjectOfExecution,
      }),
    ).toThrow(/sealsContent/);
  });

  it("accepts the sealing store", () => {
    const keys = new InMemoryKeyStore();
    expect(
      visualsLineage({
        events: new InMemoryAsyncEventStore() as never,
        content: sealedContent(new InMemoryContentStore(), keys),
        keys,
        subjectOf: subjectOfExecution,
      }),
    ).toBeInstanceOf(Lineage);
  });
});

describe("commitPlanTo a turn's line", () => {
  const target = (r: { userId: string; chatId: string; ord: number }) => ({
    experienceId: turnExperienceId(r),
    intent: TURN_INTENT,
    sourceKind: "turn-visuals",
  });
  it("creates the line, replaces its content on a re-run, and writes nothing for an identical plan", async () => {
    const lineage = newLineage();
    const r = { userId: randomUUID(), chatId: randomUUID(), ord: 6 };
    const first = await commitPlanTo(lineage, target(r), await aTurnPlan("a", "A"), now);
    const again = await commitPlanTo(lineage, target(r), await aTurnPlan("a", "A"), now);
    expect(again.head).toBe(first.head);
    const second = await commitPlanTo(lineage, target(r), await aTurnPlan("b", "B"), now);
    expect(second.head).not.toBe(first.head);
    const latest = await lineage.resolveLatest(turnExperienceId(r));
    if (!latest.ok) throw new Error("no head");
    expect(childrenOf(latest.value.root).map((c) => c.id)).toEqual(["b"]);
  });
  it("keeps a document's line and a turn's line apart", async () => {
    const lineage = newLineage();
    const doc = ref();
    const turn = { userId: doc.userId, chatId: randomUUID(), ord: 2 };
    await commitPlan(lineage, lineageTestIds, doc, await aPlan("doc", "D"), now);
    await commitPlanTo(lineage, target(turn), await aTurnPlan("turn", "T"), now);
    expect((await lineage.head(await experienceIdOf(doc))).ok).toBe(true);
    expect((await lineage.head(turnExperienceId(turn))).ok).toBe(true);
  });
});
