import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BootIngestParts, bootIngest } from "./bootIngest";

const calls: string[] = [];
const owned: (((id: string) => boolean) | undefined)[] = [];
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
vi.mock("./documents/sweeper", () => ({
  startSweeper: () => {
    calls.push("startSweeper");
    return { stop: async () => void calls.push("sweeper.stop") };
  },
}));

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
    vectors: {},
    readiness: {
      beginShutdown: note("readiness.beginShutdown"),
      close: async () => void calls.push("closeReadiness"),
    },
    events: { closeAll: note("events.closeAll") },
    titles: { idle: async () => void calls.push("titlesIdle") },
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
  calls.length = 0;
  owned.length = 0;
  hydrateFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("bootIngest", () => {
  it("verifies, boots status, primes the decoy, listens, then starts recovery and the sweepers", async () => {
    await bootIngest(parts({ listen: async () => void calls.push("listen") }));
    expect(calls.slice(0, 5)).toEqual([
      "verifyVectors",
      "bootStatus",
      "bootActivity",
      "primeDecoy",
      "listen",
    ]);
    expect(calls[5]).toBe("startRecovery:owner-1");
    expect(calls.slice(6)).toEqual(expect.arrayContaining(["startSweeper"]));
    expect(calls.indexOf("startSweeper")).toBeGreaterThan(5);
  });

  it("starts recovery and the sweepers without a listen step", async () => {
    await bootIngest(parts());
    expect(calls.slice(0, 5)).toEqual([
      "verifyVectors",
      "bootStatus",
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
    expect(calls.slice(0, 7)).toEqual([
      "verifyVectors",
      "bootStatus",
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
