import { describe, expect, it, vi } from "vitest";
import { lineageTurnHeads } from "./turnHeads";

const ref = {
  userId: "11111111-1111-4111-8111-111111111111",
  chatId: "22222222-2222-4222-8222-222222222222",
};
const head = (heads: Set<number>) =>
  vi.fn(async (experienceId: string) => {
    const ord = Number(experienceId.split("-").at(-1));
    if (ord === 99) throw new Error("line unreadable");
    return { ok: true as const, value: heads.has(ord) ? "hash" : null };
  });

describe("lineageTurnHeads", () => {
  it("answers which of the ords have a head, reading the turn's own line for each", async () => {
    const h = head(new Set([2, 6]));
    const out = await lineageTurnHeads({ head: h } as never).has(ref, [2, 4, 6]);
    expect([...out].sort()).toEqual([2, 6]);
    expect(h.mock.calls.map((c) => c[0]).sort()).toEqual(
      [2, 4, 6].map((o) => `turnvisuals-${ref.userId}-${ref.chatId}-${o}`),
    );
  });
  it("counts an unreadable or refused head as none, and reads nothing for no ords", async () => {
    expect([
      ...(await lineageTurnHeads({ head: head(new Set([1])) } as never).has(ref, [1, 99])),
    ]).toEqual([1]);
    const h = head(new Set());
    expect((await lineageTurnHeads({ head: h } as never).has(ref, [])).size).toBe(0);
    expect(h).not.toHaveBeenCalled();
    const refused = { head: async () => ({ ok: false, refusal: { kind: "line-erased" } }) };
    expect((await lineageTurnHeads(refused as never).has(ref, [1])).size).toBe(0);
  });
  it("never has more than the bound reads in flight", async () => {
    let live = 0;
    let peak = 0;
    const slow = {
      head: async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 1));
        live--;
        return { ok: true, value: null };
      },
    };
    await lineageTurnHeads(slow as never, 3).has(
      ref,
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});
