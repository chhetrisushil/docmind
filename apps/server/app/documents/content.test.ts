import { describe, expect, it } from "vitest";
import { decodeContentCursor, encodeContentCursor } from "./content";

describe("the content cursor", () => {
  it("round-trips an ordinal", () => {
    for (const n of [0, 1, 19, 20, 12345])
      expect(decodeContentCursor(encodeContentCursor(n))).toBe(n);
  });
  it.each([
    "",
    "!!!",
    "bm90IGEgY3Vyc29y",
    Buffer.from("o:-1").toString("base64url"),
    Buffer.from("o:01").toString("base64url"),
    Buffer.from("o:1.5").toString("base64url"),
    Buffer.from("o:1234567890").toString("base64url"),
    Buffer.from("x:5").toString("base64url"),
    "bzo1==", // padded: not what encodeContentCursor produces
    "b zo1", // the decoder would skip the space
    "bzo1\n",
    `${encodeContentCursor(5)}=`,
  ])("refuses %j", (c) => {
    expect(decodeContentCursor(c)).toBeNull();
  });
});
