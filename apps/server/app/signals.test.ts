import { describe, expect, it, vi } from "vitest";
import { createStopGate } from "./signals";

function gate() {
  const deps = { exit: vi.fn(), forceExitAfter: vi.fn(), log: vi.fn() };
  return { deps, gate: createStopGate(deps) };
}

describe("createStopGate", () => {
  it("exits non-zero at once on a signal during setup, with a fixed log line", () => {
    const { deps, gate: g } = gate();
    g.onSignal();
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(deps.log).toHaveBeenCalledWith("docmind server stopped during startup");
    expect(deps.forceExitAfter).not.toHaveBeenCalled();
  });

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
