import { describe, expect, it } from "vitest";
import {
  USER_ID_PREFIXES,
  handleListerPrefixes,
  isOwnedBy,
  listerPrefixes,
  userPrefixes,
} from "./prefixes";

const U = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const H = "a".repeat(26);
const H2 = "e".repeat(26);

describe("handleListerPrefixes", () => {
  it("is the h_ half of listerPrefixes: the handle's prefix, and its flow and conversation forms", () => {
    const { exact, starts } = handleListerPrefixes(H);
    expect(exact).toBe(`h_${H}`);
    expect(starts).toEqual([`h_${H}:`, `h_${H}.c-`]);
    expect(listerPrefixes(U, H).exact).toContain(exact);
  });
});

describe("the user prefixes", () => {
  it("are the two ranges the walks cover", () => {
    expect([...USER_ID_PREFIXES]).toEqual(["u_", "h_"]);
  });

  it("userPrefixes is u_<uuid> always and h_<handle> once the user has a handle", () => {
    expect(userPrefixes(U)).toEqual([`u_${U}`]);
    expect(userPrefixes(U, null)).toEqual([`u_${U}`]);
    expect(userPrefixes(U, H)).toEqual([`u_${U}`, `h_${H}`]);
  });

  it("isOwnedBy takes the prefix itself, its : and .c- forms, and nothing that only looks like them", () => {
    for (const id of [
      `u_${U}`,
      `u_${U}:ingest-x`,
      `u_${U}.c-x`,
      `h_${H}`,
      `h_${H}:ingest-x`,
      `h_${H}.c-x~2`,
    ])
      expect(isOwnedBy(id, U, H)).toBe(true);
    for (const id of [`h_${H}`, `h_${H}:x`, `h_${H}.c-x`])
      expect(isOwnedBy(id, U, null)).toBe(false);
    for (const id of [
      `u_${OTHER}:x`,
      `h_${H2}:x`,
      `u_${U}x:y`,
      `h_${H}x`,
      `h_${H}-c-x`,
      `u_${U}.d-x`,
    ])
      expect(isOwnedBy(id, U, H)).toBe(false);
  });

  it("listerPrefixes names each prefix exactly and its : and .c- forms as starts", () => {
    expect(listerPrefixes(U)).toEqual({ exact: [`u_${U}`], starts: [`u_${U}:`, `u_${U}.c-`] });
    expect(listerPrefixes(U, H)).toEqual({
      exact: [`u_${U}`, `h_${H}`],
      starts: [`u_${U}:`, `u_${U}.c-`, `h_${H}:`, `h_${H}.c-`],
    });
  });
});
