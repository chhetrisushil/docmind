import type { Identity } from "@docmind/auth";
import { describe, expect, it, vi } from "vitest";
import { visualsStateReader } from "./state";

vi.mock("../../db/tenant", () => ({
  withTenant: async (_p: unknown, _t: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock("../../documents/repo", () => ({ getDocument: async () => ({ ingest_generation: 1 }) }));

const who = { tenantId: "t", userId: "u" } as unknown as Identity;
type Last = { run: number; state: string; code: string | null } | null;

function reader(o: { tracked?: boolean; last?: Last }) {
  const reconcile = vi.fn(async (_r: unknown, _g: number, last: unknown) => last);
  const read = visualsStateReader({
    pool: {} as never,
    runs: { last: async () => (o.last ?? null) as never },
    starter: { running: () => o.tracked === true, reconcile: reconcile as never },
  });
  return { read, reconcile };
}
const running: Last = { run: 0, state: "running", code: null };

describe("visualsStateReader", () => {
  it("a first run in flight (no visuals yet) is running, tracked or recorded", async () => {
    expect(await reader({ tracked: true }).read(who, "d", false)).toBe("running");
    expect(await reader({ last: running }).read(who, "d", false)).toBe("running");
  });

  it("a re-plan over visuals that already exist (boot stale-format, any run) is ready, not running", async () => {
    expect(await reader({ tracked: true }).read(who, "d", true)).toBe("ready");
    expect(await reader({ last: running }).read(who, "d", true)).toBe("ready");
  });

  it("failed without visuals is failed; none otherwise", async () => {
    expect(
      await reader({ last: { run: 0, state: "failed", code: "internal" } }).read(who, "d", false),
    ).toBe("failed");
    expect(await reader({}).read(who, "d", false)).toBe("none");
  });
});
