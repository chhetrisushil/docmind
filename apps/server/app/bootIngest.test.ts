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
    events: { closeAll: note("events.closeAll") },
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

beforeEach(() => {
  calls.length = 0;
  owned.length = 0;
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
      "recovery.stop",
      "sweeper.stop",
      "events.closeAll",
      "chatStreams.closeAll",
      "drainServer",
      "startsIdle",
      "closeIngest",
      "closeHeartbeat",
      "detach",
      "closeStatus",
      "closeActivity",
      "closeApp",
      "closeDurable",
      "endPool",
    ]);
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
});
