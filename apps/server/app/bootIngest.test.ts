import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BootIngestParts, bootIngest, recoveryOwns } from "./bootIngest";
import { opaqueIds } from "./opaqueIds";

const calls: string[] = [];
const owned: (((id: string) => boolean) | undefined)[] = [];
const swept: (AbortSignal | undefined)[] = [];
const note = (name: string) => () => void calls.push(name);

vi.mock("@docmind/auth", () => ({ primeDecoy: async () => void calls.push("primeDecoy") }));
vi.mock("./flows/ingest-document/verifyVectors", () => ({
  verifyVectors: async (_v: unknown, cleanup: (() => Promise<unknown>)[]) => {
    calls.push("verifyVectors");
    expect(cleanup).toHaveLength(4);
  },
}));
vi.mock("./flows/ingest-document/limits", () => ({
  closeIngest: async () => void calls.push("closeIngest"),
}));
vi.mock("./flows/ingest-document/recovery", () => ({
  startRecovery: (
    _r: unknown,
    _s: unknown,
    opts: { leases?: { owner: string }; owns?: (id: string) => boolean },
  ) => {
    owned.push(opts.owns);
    calls.push(`startRecovery:${opts.leases?.owner}`);
    return { stop: note("recovery.stop"), idle: async () => {} };
  },
}));
let hydrateFails = false;
vi.mock("./erasure/compliance", () => ({
  hydrateSubjectIndex: async () => {
    calls.push("hydrateIndex");
    if (hydrateFails) throw new RangeError("u_6a1f0c52-1111-4222-8333-444455556666");
    return 0;
  },
}));
const gcStarts: { everyMs: number }[] = [];
vi.mock("./storage/lineageGc", () => ({
  startLineageGc: (_deps: unknown, everyMs: number) => {
    gcStarts.push({ everyMs });
    return { stop: async () => void calls.push("lineageGc.stop") };
  },
}));
vi.mock("./documents/executionIds", () => ({
  repairStoredExecutionIds: async () => {
    calls.push("repairIds");
    return repairIds();
  },
}));
vi.mock("./storage/pgLineageGc", () => ({ lineageGcDeps: () => ({}) }));
vi.mock("./documents/sweeper", () => ({
  startSweeper: () => {
    calls.push("startSweeper");
    return { stop: async () => void calls.push("sweeper.stop") };
  },
}));

let warmIds: () => Promise<number> = async () => 0;
let repairIds: () => Promise<number> = async () => 0;

function parts(
  over: Partial<BootIngestParts> = {},
  statusBoot?: () => Promise<void>,
  activityBoot?: () => Promise<void>,
) {
  const built = {
    app: {
      runtime: { closeHeartbeat: async () => void calls.push("closeHeartbeat") },
      close: async () => void calls.push("closeApp"),
    },
    store: { purgeExpiredSessions: async () => void calls.push("purgeSessions") },
    throttle: { purge: async () => void calls.push("purgeThrottle") },
    starts: { idle: async () => void calls.push("startsIdle") },
    status: {
      boot: statusBoot ?? (async () => void calls.push("bootStatus")),
      close: async () => void calls.push("closeStatus"),
    },
    activity: {
      boot: activityBoot ?? (async () => void calls.push("bootActivity")),
      close: async () => void calls.push("closeActivity"),
    },
    ids: { warm: () => warmIds() },
    vectors: {},
    readiness: {
      beginShutdown: note("readiness.beginShutdown"),
      close: async () => void calls.push("closeReadiness"),
    },
    events: { closeAll: note("events.closeAll") },
    titles: { idle: async () => void calls.push("titlesIdle") },
    turns: { idle: async () => void calls.push("turnsIdle") },
    visuals: {
      sweep: async (signal?: AbortSignal) => {
        calls.push("visuals.sweep");
        swept.push(signal);
        return 0;
      },
      idle: async () => void calls.push("visualsIdle"),
    },
    chatStreams: { closeAll: note("chatStreams.closeAll") },
    detachStatusFeed: note("detach"),
  };
  return {
    built,
    ingest: {},
    durable: {
      storage: { eventStore: {}, leaseStore: {} },
      close: async () => void calls.push("closeDurable"),
    },
    pool: { end: async () => void calls.push("endPool") },
    recoveryOwner: "owner-1",
    ...over,
  } as unknown as BootIngestParts;
}

/** `parts()` for a build whose visuals role is on. */
function withVisuals(over: Partial<BootIngestParts> = {}) {
  const p = parts(over);
  (p.built as unknown as { visualsOn: boolean }).visualsOn = true;
  return p;
}

/** `parts()` for an app that has the subject index (an erasure-wired build). */
function withIndex(over: Partial<BootIngestParts> = {}) {
  const p = parts(over);
  const app = p.built.app as unknown as { subjectIndex: object; start: () => void };
  app.subjectIndex = { subjects: () => [] };
  app.start = () => void calls.push("appStart");
  (p.durable as unknown as { raw: object }).raw = { eventStore: {} };
  return p;
}

beforeEach(() => {
  warmIds = async () => 0;
  repairIds = async () => 0;
  calls.length = 0;
  owned.length = 0;
  swept.length = 0;
  gcStarts.length = 0;
  hydrateFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recoveryOwns", () => {
  it("re-drives a turn visualize execution and still refuses an unrelated one", () => {
    const u = "11111111-1111-4111-8111-111111111111";
    const c = "22222222-2222-4222-8222-222222222222";
    expect(recoveryOwns(`u_${u}:visualize-turn-${c}-6`)).toBe(true);
    expect(recoveryOwns(`u_${u}:visualize-turn-${c}-6-r2`)).toBe(true);
    expect(recoveryOwns(`u_${u}:suggest-tags-${c}-r1`)).toBe(true);
    expect(recoveryOwns(`u_${u}:suggest-tags-${c}`)).toBe(false);
    expect(recoveryOwns(`u_${u}:something-else`)).toBe(false);
    const handle = "a".repeat(26);
    const token = "q".repeat(52);
    expect(recoveryOwns(`h_${handle}:ingest-${token}.2`)).toBe(true);
    expect(recoveryOwns(`h_${handle}:visualize-${token}.2-r1`)).toBe(true);
    expect(recoveryOwns(`h_${handle}:visualize-turn-${token}-6-r2`)).toBe(true);
    expect(recoveryOwns(`h_${handle}:suggest-tags-${token}-r1`)).toBe(true);
    expect(recoveryOwns(`h_${handle}:chat-title-${token}`)).toBe(true);
    expect(recoveryOwns(`h_${handle}.c-${token}~2`)).toBe(true);
    expect(recoveryOwns(`h_${handle}:something-else`)).toBe(false);
  });
});

describe("bootIngest: the lineage content collector", () => {
  it("starts none when the interval is 0 or unset, even with background work on", async () => {
    await bootIngest(parts({ lineageGcIntervalMs: 0 }));
    await bootIngest(parts());
    expect(gcStarts).toEqual([]);
  });

  it("starts it with the interval, and stops it on shutdown", async () => {
    const boot = await bootIngest(withVisuals({ lineageGcIntervalMs: 86_400_000 }));
    expect(gcStarts).toEqual([{ everyMs: 86_400_000 }]);
    await boot.stop();
    expect(calls).toContain("lineageGc.stop");
  });

  it("starts none for a one-shot script (background off)", async () => {
    await bootIngest(withVisuals({ lineageGcIntervalMs: 86_400_000, background: false }));
    expect(gcStarts).toEqual([]);
  });

  it("starts none while the visuals role is off: there is nothing in the lineage to collect", async () => {
    await bootIngest(parts({ lineageGcIntervalMs: 86_400_000 }));
    expect(gcStarts).toEqual([]);
  });
});

describe("bootIngest", () => {
  it("verifies, boots status, primes the decoy, listens, then starts recovery and the sweepers", async () => {
    await bootIngest(parts({ listen: async () => void calls.push("listen") }));
    expect(calls.slice(0, 6)).toEqual([
      "verifyVectors",
      "bootStatus",
      "repairIds",
      "bootActivity",
      "primeDecoy",
      "listen",
    ]);
    expect(calls[6]).toBe("startRecovery:owner-1");
    expect(calls.slice(7)).toEqual(expect.arrayContaining(["startSweeper"]));
    expect(calls.indexOf("startSweeper")).toBeGreaterThan(6);
  });

  it("sweeps the ready documents for visuals right after recovery starts, and aborts that sweep at stop", async () => {
    const handle = await bootIngest(parts({ listen: async () => void calls.push("listen") }));
    expect(calls.indexOf("visuals.sweep")).toBe(calls.indexOf("startRecovery:owner-1") + 1);
    const signal = swept[0];
    expect(signal?.aborted).toBe(false);
    await handle.stop();
    expect(signal?.aborted).toBe(true);
    // Recovery re-drives the visuals flow too.
    const owns = owned[0];
    const u = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
    const d = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
    expect(owns?.(`u_${u}:visualize-${d}.2`)).toBe(true);
    expect(owns?.(`u_${u}:ingest-${d}.2`)).toBe(true);
  });

  it("starts recovery and the sweepers without a listen step", async () => {
    await bootIngest(parts());
    expect(calls.slice(0, 6)).toEqual([
      "verifyVectors",
      "bootStatus",
      "repairIds",
      "bootActivity",
      "primeDecoy",
      "startRecovery:owner-1",
    ]);
    expect(calls).toContain("startSweeper");
  });

  it("background: false starts recovery but no sweeper or session sweep, and stops cleanly", async () => {
    const boot = await bootIngest(parts({ background: false }));
    expect(calls).toContain("startRecovery:owner-1");
    expect(calls).not.toContain("startSweeper");
    expect(calls).not.toContain("purgeSessions");
    await boot.stop();
    expect(calls).toContain("recovery.stop");
    expect(calls).not.toContain("sweeper.stop");
    expect(calls.at(-1)).toBe("endPool");
  });

  it("a failed listen cleans up and never starts recovery or the sweepers", async () => {
    await expect(
      bootIngest(
        parts({
          listen: async () => {
            throw new RangeError("EADDRINUSE");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toEqual([
      "verifyVectors",
      "bootStatus",
      "repairIds",
      "bootActivity",
      "primeDecoy",
      "closeIngest",
      "closeApp",
      "closeDurable",
      "endPool",
    ]);
  });

  it("a failed status boot cleans up and never listens", async () => {
    const listen = vi.fn(async () => {});
    await expect(
      bootIngest(
        parts({ listen }, async () => {
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow(/ingest status failed to boot/);
    expect(listen).not.toHaveBeenCalled();
    expect(calls).toEqual(["verifyVectors", "closeIngest", "closeApp", "closeDurable", "endPool"]);
  });

  it("a failing chat-activity boot is logged by class and does not stop serving", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const listen = vi.fn(async () => {});
    await bootIngest(
      parts({ listen }, undefined, async () => {
        throw new RangeError("u_secret");
      }),
    );
    expect(listen).toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      "chat activity failed to boot; serving without it",
      "RangeError",
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain("u_secret");
  });

  it("stop() closes the activity model even when the status close throws", async () => {
    const built = parts();
    built.built.status.close = async () => {
      throw new Error("x");
    };
    const handle = await bootIngest(built);
    calls.length = 0;
    await handle.stop().catch(() => undefined);
    expect(calls).toContain("closeActivity");
  });

  it("stop() stops the background work, drains the server, then runs the close sequence, once", async () => {
    const handle = await bootIngest(
      parts({
        drainServer: async (then) => {
          calls.push("drainServer");
          await then();
        },
      }),
    );
    calls.length = 0;
    await Promise.all([handle.stop(), handle.stop()]);
    expect(calls).toEqual([
      "readiness.beginShutdown",
      "recovery.stop",
      "sweeper.stop",
      "events.closeAll",
      "chatStreams.closeAll",
      "drainServer",
      "startsIdle",
      "titlesIdle",
      "turnsIdle",
      "visualsIdle",
      "closeIngest",
      "closeHeartbeat",
      "detach",
      "closeStatus",
      "closeActivity",
      "closeApp",
      "closeDurable",
      "closeReadiness",
      "endPool",
    ]);
  });

  it("with a shutdown delay it flips readiness at once and serves on, then drains only after the delay", async () => {
    vi.useFakeTimers();
    try {
      const handle = await bootIngest(
        parts({
          shutdownDelayMs: 5_000,
          drainServer: async (then) => {
            calls.push("drainServer");
            await then();
          },
        }),
      );
      calls.length = 0;
      const stopped = handle.stop();
      await vi.advanceTimersByTimeAsync(4_999);
      // Readiness is already 503, but nothing else has begun: the listener, streams and sweepers are untouched.
      expect(calls).toEqual(["readiness.beginShutdown"]);
      await vi.advanceTimersByTimeAsync(1);
      await stopped;
      expect(calls.slice(0, 6)).toEqual([
        "readiness.beginShutdown",
        "recovery.stop",
        "sweeper.stop",
        "events.closeAll",
        "chatStreams.closeAll",
        "drainServer",
      ]);
      expect(calls.at(-1)).toBe("endPool");
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovery owns ingest and chat executions (conversation, title) and nothing else", async () => {
    await bootIngest(parts());
    const owns = owned[0];
    const U = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
    const C = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
    expect(owns?.(`u_${U}:ingest-${C}`)).toBe(true);
    expect(owns?.(`u_${U}.c-${C}`)).toBe(true);
    expect(owns?.(`u_${U}:chat-title-${C}`)).toBe(true);
    expect(owns?.(`u_${U}:other-${C}`)).toBe(false);
  });

  it("stop() closes the chat right after the ingest steps and before the heartbeat; a build without chat is unchanged", async () => {
    const base = parts();
    const withChat = parts({
      built: {
        ...(base.built as object),
        chat: { close: async () => void calls.push("closeChat") },
      },
    } as unknown as Partial<BootIngestParts>);
    const handle = await bootIngest(withChat);
    calls.length = 0;
    await handle.stop();
    expect(calls.filter((c) => /^close(Ingest|Chat|Heartbeat)$/.test(c))).toEqual([
      "closeIngest",
      "closeChat",
      "closeHeartbeat",
    ]);
    expect(calls.filter((c) => c === "closeChat")).toHaveLength(1);
  });

  it("stop() still closes the stores when the server drain fails, and reports the failure", async () => {
    const handle = await bootIngest(
      parts({
        drainServer: async (then) => {
          try {
            throw new RangeError("drain");
          } finally {
            await then();
          }
        },
      }),
    );
    calls.length = 0;
    await expect(handle.stop()).rejects.toBeInstanceOf(RangeError);
    expect(calls.at(-1)).toBe("endPool");
  });

  it("hydrates the subject index after the models boot and before the decoy and the bind", async () => {
    await bootIngest(withIndex({ listen: async () => void calls.push("listen") }));
    expect(calls.slice(0, 8)).toEqual([
      "verifyVectors",
      "bootStatus",
      "repairIds",
      "bootActivity",
      "hydrateIndex",
      "appStart",
      "primeDecoy",
      "listen",
    ]);
  });

  it("starts the app (its timers) only after the index is hydrated, and not at all if hydration fails", async () => {
    await bootIngest(withIndex());
    expect(calls.indexOf("hydrateIndex")).toBeLessThan(calls.indexOf("appStart"));
    calls.length = 0;
    hydrateFails = true;
    await expect(bootIngest(withIndex())).rejects.toThrow();
    expect(calls).not.toContain("appStart");
  });

  it("logs counts only when the index is hydrated", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await bootIngest(withIndex());
    expect(info).toHaveBeenCalledWith("subject index hydrated", { subjects: 0, executions: 0 });
  });

  it("a failed hydration cleans up, logs the class only, and never listens or starts recovery", async () => {
    hydrateFails = true;
    const logged = vi.spyOn(console, "error");
    await expect(
      bootIngest(withIndex({ listen: async () => void calls.push("listen") })),
    ).rejects.toThrow(/^subject index failed to boot$/);
    expect(logged).toHaveBeenCalledWith("subject index failed", "RangeError");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("u_6a1f0c52");
    expect(calls).toEqual(
      expect.arrayContaining(["closeIngest", "closeApp", "closeDurable", "endPool"]),
    );
    expect(calls).not.toContain("listen");
    expect(calls).not.toContain("startRecovery:owner-1");
  });

  it("skips hydration for an app built without the erasure wiring", async () => {
    await bootIngest(parts());
    expect(calls).not.toContain("hydrateIndex");
    expect(calls).not.toContain("appStart");
  });
});

describe("bootIngest: the id key cache", () => {
  it("is warmed before the status model boots, so before recovery, the fold or any observer", async () => {
    warmIds = async () => {
      calls.push("warmIds");
      return 3;
    };
    await bootIngest(parts());
    expect(calls.indexOf("warmIds")).toBeGreaterThan(-1);
    expect(calls.indexOf("warmIds")).toBeLessThan(calls.indexOf("bootStatus"));
  });

  it("is warmed before the status boot, the chat-activity catch-up, the subject index hydrate and the first start of the runtime", async () => {
    warmIds = async () => {
      calls.push("warmIds");
      return 3;
    };
    await bootIngest(withIndex({ listen: async () => void calls.push("listen") }));
    const warm = calls.indexOf("warmIds");
    for (const later of ["bootStatus", "bootActivity", "hydrateIndex", "appStart", "listen"])
      expect(warm, later).toBeLessThan(calls.indexOf(later));
    expect(warm).toBeLessThan(calls.findIndex((c) => c.startsWith("startRecovery")));
  });

  it("a failed warm-up cleans up with the fixed label, never serves and never starts recovery", async () => {
    warmIds = async () => {
      throw new Error("key store down: u_secret");
    };
    await expect(bootIngest(parts())).rejects.toThrow("id keys failed to boot");
    expect(calls).not.toContain("bootStatus");
    expect(calls).toContain("closeApp");
  });

  it("repairs the stored execution ids after the status model has caught up and before recovery or the sweeps start", async () => {
    repairIds = async () => 2;
    await bootIngest(parts());
    expect(calls.indexOf("repairIds")).toBeGreaterThan(calls.indexOf("bootStatus"));
    expect(calls.indexOf("repairIds")).toBeLessThan(
      calls.findIndex((c) => c.startsWith("startRecovery")),
    );
    expect(calls.indexOf("repairIds")).toBeLessThan(calls.indexOf("startSweeper"));
  });

  it("a failed repair cleans up with the fixed label, never starts recovery, and never prints an id", async () => {
    repairIds = async () => {
      throw new Error("db down: u_secret");
    };
    await expect(bootIngest(parts())).rejects.toThrow("stored execution ids failed to boot");
    expect(calls.some((c) => c.startsWith("startRecovery"))).toBe(false);
    expect(calls).toContain("closeApp");
  });

  it("stop() removes the process-wide id cache as the very last closer, so the next stack in the same process starts cold", async () => {
    opaqueIds.install({} as never);
    const booted = await bootIngest(parts());
    let installedAtPoolEnd: unknown = "unset";
    const p = parts();
    (p.pool as unknown as { end: () => Promise<void> }).end = async () => {
      installedAtPoolEnd = opaqueIds.current();
      calls.push("endPool");
    };
    opaqueIds.install({} as never);
    const second = await bootIngest(p);
    await second.stop();
    // Still installed while the pool ends, gone afterwards.
    expect(installedAtPoolEnd).toBeDefined();
    expect(opaqueIds.current()).toBeUndefined();
    await booted.stop();
    expect(opaqueIds.current()).toBeUndefined();
  });
});
