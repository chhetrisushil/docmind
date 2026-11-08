import { createChatLitRegistry } from "@loom-ui/renderer-lit/chat";
import { describe, expect, it } from "vitest";

describe("the pinned loom-ui draws host content under a chat entry", () => {
  it("defines lu-chat with a chatAccessories property, and the registry takes the option", () => {
    const accessories = { render: () => null };
    expect(() => createChatLitRegistry({ chatAccessories: accessories })).not.toThrow();
    const lu = customElements.get("lu-chat") as unknown as
      | { elementProperties: Map<string, unknown> }
      | undefined;
    expect(lu?.elementProperties.has("chatAccessories")).toBe(true);
  });
});
