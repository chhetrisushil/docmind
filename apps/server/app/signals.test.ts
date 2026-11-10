import { describe, expect, it, vi } from "vitest";
import { createStopGate } from "./signals";

function gate() {
  const deps = { exit: vi.fn(), forceExitAfter: vi.fn(), log: vi.fn() };
  return { deps, gate: createStopGate(deps) };
}

describe("createStopGate", () => {
  // The container smoke test (infra/smoke-image.sh) accepts 0 or 143 for a stop during boot: exit 1 means a failed
  // boot, and a SIGTERM that lands after the handlers are registered but during setup must not read as one.
  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)(
    "exits at once on a %s during setup with the signal's status (%i), never 1, with a fixed log line",
    (signal, code) => {
      const { deps, gate: g } = gate();
      g.onSignal(signal);
      expect(deps.exit).toHaveBeenCalledTimes(1);
      expect(deps.exit).toHaveBeenCalledWith(code);
      expect(deps.log).toHaveBeenCalledWith("docmind server stopped during startup");
      expect(deps.forceExitAfter).not.toHaveBeenCalled();
    },
  );

  it("defers the ordered stop to the end of the boot, arming the deadline from the signal", () => {
    const { deps, gate: g } = gate();
    const stop = vi.fn();
    g.booting(60_000);
    g.onSignal();
    g.onSignal();
    expect(deps.exit).not.toHaveBeenCalled();
    expect(deps.forceExitAfter).toHaveBeenCalledTimes(1);
    expect(deps.forceExitAfter).toHaveBeenCalledWith(60_000);
    expect(stop).not.toHaveBeenCalled();
    g.running(stop);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("runs the stop on a signal once running, and not before one arrives", () => {
    const { deps, gate: g } = gate();
    const stop = vi.fn();
    g.booting(60_000);
    g.running(stop);
    expect(stop).not.toHaveBeenCalled();
    g.onSignal();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(deps.exit).not.toHaveBeenCalled();
  });
});
