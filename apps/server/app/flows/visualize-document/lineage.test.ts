import { randomUUID } from "node:crypto";
import { replay } from "@loom-ui/core";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import { InMemoryContentStore } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { HeadMovedError, commitPlan, experienceIdOf } from "./lineage";
import type { VisualizeRef } from "./pgFacts";
import { aPlan } from "./testing";

const ref = (): VisualizeRef => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  documentId: randomUUID(),
});
const NOW = "2026-11-08T10:00:00.000Z";
const now = () => NOW;
const newLineage = () =>
  new Lineage({ events: new InMemoryLineageStore(), content: new InMemoryContentStore() });
const startOf = (state: Awaited<ReturnType<Lineage["state"]>>): string => {
  if (!state.ok) throw new Error("no state");
  return state.value.order[0] as string;
};
const childIds = async (lineage: Lineage, r: VisualizeRef) => {
  const latest = await lineage.resolveLatest(experienceIdOf(r));
  if (!latest.ok) throw new Error("no head");
  return latest.value.root.children.map((c) => c.id);
};

describe("commitPlan", () => {
  it("creates the line on the first commit; the head's root children are the plan's", async () => {
    const lineage = newLineage();
    const r = ref();
    const plan = await aPlan("revenue", "Revenue");
    expect(plan.ops.length).toBeGreaterThan(0);
    const { head } = await commitPlan(lineage, r, plan, now);
    const headResult = await lineage.head(experienceIdOf(r));
    expect(headResult).toEqual({ ok: true, value: head });
    const latest = await lineage.resolveLatest(experienceIdOf(r));
    if (!latest.ok) throw new Error("no head");
    expect(latest.value.versionHash).toBe(head);
    // The head is the replay of the plan's ops over the line's genesis.
    const genesisOnly = await lineage.get(
      experienceIdOf(r),
      startOf(await lineage.state(experienceIdOf(r))),
    );
    if (!genesisOnly.ok) throw new Error("no genesis");
    const replayed = replay(genesisOnly.value, plan.ops);
    if (!replayed.ok) throw new Error("replay failed");
    expect(latest.value.root.children).toEqual(replayed.value.root.children);
    expect(await childIds(lineage, r)).toEqual(["revenue"]);
  });

  it("composes a second commit on top of the head", async () => {
    const lineage = newLineage();
    const r = ref();
    const first = await commitPlan(lineage, r, await aPlan("a", "A"), now);
    const second = await commitPlan(lineage, r, await aPlan("b", "B"), now);
    expect(second.head).not.toBe(first.head);
    const state = await lineage.state(experienceIdOf(r));
    if (!state.ok) throw new Error("no state");
    expect(state.value.head).toBe(second.head);
    expect(state.value.versions.get(second.head)?.parents).toEqual([first.head]);
    expect((await childIds(lineage, r)).sort()).toEqual(["a", "b"]);
  });

  // Moves the head under the commit: the interferer composes first, then the commit's compose sees a stale head.
  const interfering = async (lineage: Lineage, r: VisualizeRef, times: number) => {
    const interferers = await Promise.all(
      Array.from({ length: times }, (_, i) => aPlan(`other${i}`, `Other ${i}`)),
    );
    let moved = 0;
    return {
      head: (id: string) => lineage.head(id),
      start: (g: Parameters<Lineage["start"]>[0], by: Parameters<Lineage["start"]>[1]) =>
        lineage.start(g, by),
      compose: async (input: Parameters<Lineage["compose"]>[0]) => {
        const next = interferers[moved];
        if (next && moved < times) {
          moved++;
          const head = await lineage.head(experienceIdOf(r));
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
    await commitPlan(lineage, r, await aPlan("a", "A"), now);
    const racing = await interfering(lineage, r, 1);
    await commitPlan(racing, r, await aPlan("mine", "Mine"), now);
    expect((await childIds(lineage, r)).sort()).toEqual(["a", "mine", "other0"]);
  });

  it("throws when the head moves again on the retry", async () => {
    const lineage = newLineage();
    const r = ref();
    await commitPlan(lineage, r, await aPlan("a", "A"), now);
    const racing = await interfering(lineage, r, 2);
    await expect(commitPlan(racing, r, await aPlan("mine", "Mine"), now)).rejects.toBeInstanceOf(
      HeadMovedError,
    );
    expect((await childIds(lineage, r)).sort()).toEqual(["a", "other0", "other1"]);
  });
});
