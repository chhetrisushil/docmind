import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupConfigError, reportStartupFailure } from "./startupError";

const ID = "u_6a1f0c52-1111-4222-8333-444455556666";
afterEach(() => vi.restoreAllMocks());

describe("reportStartupFailure", () => {
  it("prints a StartupConfigError's message", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    reportStartupFailure(new StartupConfigError("DATABASE_URL is not set"));
    expect(logged).toHaveBeenCalledWith(
      "docmind server failed to start:",
      "DATABASE_URL is not set",
    );
  });

  it("prints only the class of any other error, even one carrying an id", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    reportStartupFailure(new RangeError(`execution ${ID} failed`));
    expect(logged).toHaveBeenCalledWith("docmind server failed to start", "RangeError");
    expect(JSON.stringify(logged.mock.calls)).not.toContain(ID);
  });
});
