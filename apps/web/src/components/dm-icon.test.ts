import { describe, expect, it } from "vitest";
import "./dm-icon";
import { ICONS } from "./icons";

const mount = async (attrs: Record<string, string>) => {
  const el = document.createElement("dm-icon");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el;
};

describe("dm-icon", () => {
  it("draws an svg, hidden from assistive tech unless it has a label", async () => {
    const decorative = await mount({ name: "check" });
    expect(decorative.shadowRoot?.querySelector("svg")).not.toBeNull();
    expect(decorative.getAttribute("aria-hidden")).toBe("true");
    expect(decorative.hasAttribute("role")).toBe(false);
    const labelled = await mount({ name: "check", label: "Done" });
    expect(labelled.getAttribute("role")).toBe("img");
    expect(labelled.getAttribute("aria-label")).toBe("Done");
    expect(labelled.hasAttribute("aria-hidden")).toBe(false);
  });

  it("draws nothing for an unknown name instead of throwing", async () => {
    const el = await mount({ name: "no-such-icon" });
    expect(el.shadowRoot?.querySelector("svg")).toBeNull();
  });

  it("ships every icon the mocks use as an inline svg without scripts", () => {
    for (const [name, svg] of Object.entries(ICONS)) {
      expect(svg.startsWith("<svg"), name).toBe(true);
      expect(/<script|onload=|href=/i.test(svg), name).toBe(false);
    }
    expect(Object.keys(ICONS).length).toBeGreaterThanOrEqual(30);
  });
});
