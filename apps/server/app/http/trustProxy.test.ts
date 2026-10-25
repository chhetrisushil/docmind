import { describe, expect, it } from "vitest";
import { StartupConfigError } from "../startupError";
import { loadTrustProxy } from "./trustProxy";

describe("loadTrustProxy", () => {
  it("is off by default, with one hop", () => {
    expect(loadTrustProxy({})).toEqual({ trustProxy: false, hops: 1 });
    expect(loadTrustProxy({ DOCMIND_TRUST_PROXY: "false" })).toEqual({
      trustProxy: false,
      hops: 1,
    });
  });

  it("trusts exactly 'true', as before, with one hop unless told otherwise", () => {
    expect(loadTrustProxy({ DOCMIND_TRUST_PROXY: "true" })).toEqual({ trustProxy: true, hops: 1 });
    expect(loadTrustProxy({ DOCMIND_TRUST_PROXY: "1" }).trustProxy).toBe(false);
  });

  it("reads the hop count", () => {
    expect(
      loadTrustProxy({ DOCMIND_TRUST_PROXY: "true", DOCMIND_TRUST_PROXY_HOPS: "2" }).hops,
    ).toBe(2);
  });

  it.each(["0", "-1", "1.5", "two", "33", "1e1"])("refuses %s hops", (bad) => {
    expect(() =>
      loadTrustProxy({ DOCMIND_TRUST_PROXY: "true", DOCMIND_TRUST_PROXY_HOPS: bad }),
    ).toThrow(StartupConfigError);
  });

  it("refuses a hop count without DOCMIND_TRUST_PROXY=true, naming both variables", () => {
    for (const env of [
      { DOCMIND_TRUST_PROXY_HOPS: "2" },
      { DOCMIND_TRUST_PROXY: "false", DOCMIND_TRUST_PROXY_HOPS: "2" },
    ]) {
      expect(() => loadTrustProxy(env)).toThrow(
        new StartupConfigError("DOCMIND_TRUST_PROXY_HOPS needs DOCMIND_TRUST_PROXY=true"),
      );
    }
  });
});
