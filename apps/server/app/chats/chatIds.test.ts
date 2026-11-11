import { describe, expect, it } from "vitest";
import { deterministicUser } from "../opaqueIds/testing";
import { legacyBuilders, opaqueBuilders } from "./chatIds";

const U = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const C = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const HANDLE_RE = /^[a-z2-7]{25}[aeimquy4]$/;
const TOKEN = "[a-z2-7]{51}[aq]";

describe("legacyBuilders", () => {
  const b = legacyBuilders(U, C);
  it("builds the four old shapes", () => {
    expect(b.format).toBe("legacy");
    expect(b.conversationId()).toBe(`u_${U}.c-${C}`);
    expect(b.titleExecutionId()).toBe(`u_${U}:chat-title-${C}`);
    expect(b.turnExecutionId(7)).toBe(`u_${U}:visualize-turn-${C}-7`);
    expect(b.turnExecutionId(7, 2)).toBe(`u_${U}:visualize-turn-${C}-7-r2`);
    expect(b.turnExperienceId(7)).toBe(`turnvisuals-${U}-${C}-7`);
  });
  it.each([
    ["an upper-case chat", () => legacyBuilders(U, C.toUpperCase()).conversationId()],
    ["a generation suffix", () => legacyBuilders(U, `${C}~1`).conversationId()],
    ["ord 0", () => legacyBuilders(U, C).turnExecutionId(0)],
    ["rerun 1000", () => legacyBuilders(U, C).turnExecutionId(7, 1000)],
  ])("refuses %s", (_name, build) => {
    expect(build).toThrow(RangeError);
  });
});

describe("opaqueBuilders", () => {
  const user = deterministicUser(U);
  const b = opaqueBuilders(user, C);
  it("builds the four new shapes: the handle and a 52-character token, no uuid", () => {
    expect(b.format).toBe("opaque");
    expect(user.handle).toMatch(HANDLE_RE);
    const conv = new RegExp(`^h_${user.handle}\\.c-${TOKEN}$`);
    expect(b.conversationId()).toMatch(conv);
    expect(b.titleExecutionId()).toMatch(new RegExp(`^h_${user.handle}:chat-title-${TOKEN}$`));
    expect(b.turnExecutionId(7)).toMatch(
      new RegExp(`^h_${user.handle}:visualize-turn-${TOKEN}-7$`),
    );
    expect(b.turnExecutionId(7, 2)).toMatch(
      new RegExp(`^h_${user.handle}:visualize-turn-${TOKEN}-7-r2$`),
    );
    expect(b.turnExperienceId(7)).toMatch(new RegExp(`^turnvisuals-${user.handle}-${TOKEN}-7$`));
    for (const id of [b.conversationId(), b.titleExecutionId(), b.turnExperienceId(7)]) {
      expect(id).not.toContain(U);
      expect(id).not.toContain(C);
    }
  });
  it("uses one token per chat in every family and is deterministic", () => {
    const token = (id: string) => new RegExp(TOKEN).exec(id)?.[0];
    expect(token(b.conversationId())).toBe(token(b.titleExecutionId()));
    expect(token(b.conversationId())).toBe(token(b.turnExecutionId(1)));
    expect(token(b.conversationId())).toBe(token(b.turnExperienceId(1)));
    expect(opaqueBuilders(user, C).conversationId()).toBe(b.conversationId());
  });
  it("is a valid Loom conversation id and a generation keeps it valid, under the byte limit", () => {
    expect(b.conversationId()).toHaveLength(83);
    expect(`${b.conversationId()}~999999999`).toHaveLength(93);
    for (const id of [
      b.conversationId(),
      b.titleExecutionId(),
      b.turnExecutionId(999_999_999_999_999, 999),
    ])
      expect(Buffer.byteLength(id)).toBeLessThan(140);
  });
});
