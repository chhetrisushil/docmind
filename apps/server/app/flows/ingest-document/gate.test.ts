import { describe, expect, it } from "vitest";
import { IngestAbortedError } from "./errors";
import { IngestGate } from "./gate";

/** A task the test finishes by hand, and a record of when it started. */
function manual(log: string[], name: string) {
  let finish!: () => void;
  const done = new Promise<void>((r) => {
    finish = r;
  });
  return {
    task: async () => {
      log.push(name);
      await done;
      return name;
    },
    finish,
  };
}

/** Lets queued microtasks (the scheduler starts a task a few ticks after `schedule`) run; no timer. */
const drain = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("IngestGate", () => {
  it("caps one tenant at tenantConcurrency while another tenant still gets a slot", async () => {
    const gate = new IngestGate({ concurrency: 4, tenantConcurrency: 2 });
    const log: string[] = [];
    const a = [1, 2, 3].map((i) => manual(log, `a${i}`));
    const b1 = manual(log, "b1");
    const runs = [
      ...a.map((m) => gate.run("A", undefined, m.task)),
      gate.run("B", undefined, b1.task),
    ];
    await drain();
    expect([...log].sort()).toEqual(["a1", "a2", "b1"]); // a3 waits on A's cap, not on the global cap
    a[0]?.finish();
    await runs[0];
    await drain();
    expect(log).toContain("a3");
    for (const m of [...a, b1]) m.finish();
    expect(await Promise.all(runs)).toEqual(["a1", "a2", "a3", "b1"]);
  });

  it("caps the process at concurrency and shares freed slots round-robin across tenants", async () => {
    const gate = new IngestGate({ concurrency: 1, tenantConcurrency: 1 });
    const log: string[] = [];
    const tasks = [
      ["A", "a1"],
      ["A", "a2"],
      ["B", "b1"],
    ].map(([t, n]) => ({ t: t as string, m: manual(log, n as string) }));
    const runs = tasks.map(({ t, m }) => gate.run(t, undefined, m.task));
    await drain();
    expect(log).toEqual(["a1"]);
    tasks[0]?.m.finish();
    await runs[0];
    tasks[2]?.m.finish();
    await runs[2]; // b1 ran before a2: B had a waiting task and A had just run
    tasks[1]?.m.finish();
    await runs[1];
    expect(log).toEqual(["a1", "b1", "a2"]);
  });

  it("rejects a waiting run with IngestAbortedError when its signal aborts, and frees nothing it never held", async () => {
    const gate = new IngestGate({ concurrency: 1, tenantConcurrency: 1 });
    const log: string[] = [];
    const first = manual(log, "first");
    const running = gate.run("A", undefined, first.task);
    const ac = new AbortController();
    const waiting = gate.run("A", ac.signal, async () => "never");
    ac.abort();
    await expect(waiting).rejects.toBeInstanceOf(IngestAbortedError);
    expect(gate.waiting).toBe(0);
    first.finish();
    await running;
    expect(gate.active).toBe(0);
  });

  it("rejects at once when the signal is already aborted", async () => {
    const gate = new IngestGate({ concurrency: 1, tenantConcurrency: 1 });
    await expect(gate.run("A", AbortSignal.abort(), async () => 1)).rejects.toBeInstanceOf(
      IngestAbortedError,
    );
  });

  it("rejects a run queued in the fair scheduler when its signal aborts", async () => {
    const gate = new IngestGate({ concurrency: 1, tenantConcurrency: 1 });
    const log: string[] = [];
    const first = manual(log, "first");
    const running = gate.run("A", undefined, first.task);
    const ac = new AbortController();
    const queued = gate.run("B", ac.signal, async () => "never"); // B's tenant slot is free: it waits on the process cap
    ac.abort();
    await expect(queued).rejects.toBeInstanceOf(IngestAbortedError);
    first.finish();
    await running;
    expect(log).toEqual(["first"]);
  });

  it("releases both slots when the task throws", async () => {
    const gate = new IngestGate({ concurrency: 1, tenantConcurrency: 1 });
    await expect(
      gate.run("A", undefined, async () => {
        throw new TypeError("x");
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await gate.run("A", undefined, async () => 7)).toBe(7);
    expect(gate.active).toBe(0);
  });
});
