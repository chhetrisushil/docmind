import { describe, expect, it } from "vitest";
import { SurfaceName, UiHydrateRequest, UiHydrateResponse, UiViewResponse, ViewName } from "./ui";

const req = {
  experienceId: "docmind.library",
  versionHash: "sha256:abc",
  handle: "documents",
  params: {},
};

describe("the UI plane contracts", () => {
  it("names six views and two surfaces", () => {
    expect(ViewName.options).toEqual([
      "library",
      "library-empty",
      "detail",
      "sessions",
      "chat",
      "sources",
    ]);
    expect(SurfaceName.options).toEqual(["web", "terminal"]);
  });
  it("accepts a hydrate request of 1 to 32 loads with scalar params, and refuses nested params, an unknown view and an empty or oversized batch", () => {
    expect(UiHydrateRequest.safeParse({ view: "library", requests: [req] }).success).toBe(true);
    expect(
      UiHydrateRequest.safeParse({
        view: "library",
        requests: [{ ...req, params: { status: "ready", n: 3, q: null } }],
      }).success,
    ).toBe(true);
    for (const bad of [
      { view: "library", requests: [{ ...req, params: { a: { b: 1 } } }] },
      { view: "nope", requests: [req] },
      { view: "library", requests: [] },
      { view: "library", requests: Array.from({ length: 33 }, () => req) },
    ])
      expect(UiHydrateRequest.safeParse(bad).success).toBe(false);
  });
  it("accepts a view response and refuses one without an inventory or with a bad priority", () => {
    const ok = {
      view: "library",
      surface: "web",
      experienceId: "docmind.library",
      versionHash: "sha256:abc",
      blueprint: { _tag: "Blueprint" },
      inventory: {
        experienceId: "docmind.library",
        versionHash: "sha256:abc",
        handles: [{ handle: "documents", priority: "P0", params: ["status"], revision: "r" }],
      },
      fingerprint: { restrictedHandles: [], restrictedProjectionNodes: [], placeholderNodes: [] },
    };
    expect(UiViewResponse.safeParse(ok).success).toBe(true);
    expect(UiViewResponse.safeParse({ ...ok, inventory: undefined }).success).toBe(false);
    expect(
      UiViewResponse.safeParse({
        ...ok,
        inventory: { ...ok.inventory, handles: [{ ...ok.inventory.handles[0], priority: "P9" }] },
      }).success,
    ).toBe(false);
  });
  it("a hydrate response is an array of results", () => {
    expect(UiHydrateResponse.parse({ results: [{ state: "ready", value: 1 }] })).toEqual({
      results: [{ state: "ready", value: 1 }],
    });
    expect(UiHydrateResponse.safeParse({ results: "x" }).success).toBe(false);
  });
});
