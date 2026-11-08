import { createChatLitRegistry } from "@loom-ui/renderer-lit/chat";
import { describe, expect, it } from "vitest";

// The pinned loom-ui carries the per-entry attachment point from loom-ui PR #125 (`chatAccessories`); a pin from before it fails here.
describe("the pinned loom-ui draws host content under a chat entry", () => {
  it("defines lu-chat with a chatAccessories property, and the registry takes the option", () => {
    const accessories = { render: () => null };
    expect(() => createChatLitRegistry({ chatAccessories: accessories })).not.toThrow();
    const lu = customElements.get("lu-chat") as unknown as
      | { elementProperties: Map<string, unknown> }
      | undefined;
    expect(lu).toBeDefined(); // lu-chat is registered (a missing element would otherwise read as "no property")
    expect(lu?.elementProperties.has("chatAccessories")).toBe(true);
  });
});
