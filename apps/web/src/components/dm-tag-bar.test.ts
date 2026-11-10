import { describe, expect, it } from "vitest";
import { unnamedControls } from "../testing/dom";
import { root, tag } from "../testing/tags";
import "./dm-tag-bar";

const TAGS = [tag(1, "Finance", 3), tag(2, "Legal", 1), tag(3, "Q3", 0)];

async function mount(props: Record<string, unknown> = {}) {
  const el = document.createElement("dm-tag-bar") as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  Object.assign(el, {
    tags: TAGS,
    selected: [],
    match: "any",
    count: null,
    managing: false,
    ...props,
  });
  document.body.append(el);
  await el.updateComplete;
  return el;
}
const chips = (el: Element) => [
  ...root(el).querySelectorAll<HTMLButtonElement>("button[data-tag]"),
];
const listen = (el: Element, name: string) => {
  const seen: unknown[] = [];
  el.addEventListener(name, (e) => seen.push((e as CustomEvent).detail));
  return seen;
};

describe("dm-tag-bar", () => {
  it("draws one toggle chip per tag with its count, and says which are pressed", async () => {
    const el = await mount({ selected: [TAGS[1]?.id] });
    expect(chips(el).map((b) => b.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Finance 3",
      "Legal 1",
      "Q3 0",
    ]);
    expect(chips(el).map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("toggling a chip reports the new selection with the current mode", async () => {
    const el = await mount({ selected: [TAGS[0]?.id], match: "all" });
    const seen = listen(el, "tag-selection");
    chips(el)[1]?.click();
    chips(el)[0]?.click();
    expect(seen).toEqual([
      { tags: [TAGS[0]?.id, TAGS[1]?.id], match: "all" },
      { tags: [], match: "all" },
    ]);
  });

  it("offers Any and All as a radio group, enabled from 2 selected tags", async () => {
    const one = await mount({ selected: [TAGS[0]?.id] });
    const group = root(one).querySelector("[role=radiogroup]");
    expect(group?.getAttribute("aria-label")).toBe("Match");
    const radios = (el: Element) => [
      ...root(el).querySelectorAll<HTMLInputElement>("input[type=radio]"),
    ];
    expect(radios(one).map((r) => [r.value, r.disabled, r.checked])).toEqual([
      ["any", true, true],
      ["all", true, false],
    ]);
    const two = await mount({ selected: [TAGS[0]?.id, TAGS[1]?.id], match: "all" });
    expect(radios(two).map((r) => [r.disabled, r.checked])).toEqual([
      [false, false],
      [false, true],
    ]);
    const seen = listen(two, "tag-selection");
    radios(two)[0]?.click();
    expect(seen).toEqual([{ tags: [TAGS[0]?.id, TAGS[1]?.id], match: "any" }]);
  });

  it("Clear empties the selection and is disabled when there is none", async () => {
    const empty = await mount();
    expect(root(empty).querySelector<HTMLButtonElement>("[data-clear]")?.disabled).toBe(true);
    const el = await mount({ selected: [TAGS[0]?.id], match: "all" });
    const seen = listen(el, "tag-selection");
    root(el).querySelector<HTMLButtonElement>("[data-clear]")?.click();
    expect(seen).toEqual([{ tags: [], match: "any" }]);
  });

  it("leaves the count to the page when nothing matches", async () => {
    const el = await mount({ selected: [TAGS[0]?.id], count: 0 });
    expect(root(el).querySelector("[role=status]")?.textContent?.trim()).toBe("");
  });

  it("stops at 10 selected tags: the others cannot be pressed, the pressed ones can be released", async () => {
    const many = Array.from({ length: 11 }, (_, i) => tag(i + 1, `t${i}`, 1));
    const el = await mount({ tags: many, selected: many.slice(0, 10).map((t) => t.id) });
    expect(chips(el).map((b) => b.disabled)).toEqual([...Array(10).fill(false), true]);
  });

  it("announces the result count politely, only while a filter is on", async () => {
    const el = await mount({ selected: [TAGS[0]?.id], count: 3 });
    const live = root(el).querySelector("[role=status]");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent?.trim()).toBe("3 documents match");
    (el as unknown as { count: number }).count = 1;
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(live?.textContent?.trim()).toBe("1 document matches");
    const none = await mount({ selected: [], count: 7 });
    expect(root(none).querySelector("[role=status]")?.textContent?.trim()).toBe("");
  });

  it("Manage tags toggles the panel and says whether it is open", async () => {
    const el = await mount({ managing: true });
    const button = root(el).querySelector<HTMLButtonElement>("[data-manage]");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    const seen = listen(el, "manage-toggle");
    button?.click();
    expect(seen).toHaveLength(1);
  });

  it("has no control without an accessible name", async () => {
    expect(
      unnamedControls(await mount({ selected: [TAGS[0]?.id, TAGS[1]?.id], managing: true })),
    ).toEqual([]);
  });
});
