import { describe, expect, it } from "vitest";
import { jpegBytes, pngBytes, webpL, webpLossy, webpX } from "./imageFixtures";
import { imageSize } from "./imageSize";

describe("imageSize", () => {
  it("reads PNG, JPEG and the three WebP flavours", () => {
    expect(imageSize(pngBytes(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    expect(imageSize(jpegBytes(400, 300), "image/jpeg")).toEqual({ width: 400, height: 300 });
    expect(imageSize(webpX(1024, 768), "image/webp")).toEqual({ width: 1024, height: 768 });
    expect(imageSize(webpL(321, 123), "image/webp")).toEqual({ width: 321, height: 123 });
    expect(imageSize(webpLossy(500, 250), "image/webp")).toEqual({ width: 500, height: 250 });
  });

  it("returns null for every truncated prefix of each header", () => {
    const cases: [Uint8Array, string][] = [
      [pngBytes(640, 480), "image/png"],
      [jpegBytes(400, 300), "image/jpeg"],
      [webpX(1024, 768), "image/webp"],
      [webpL(321, 123), "image/webp"],
      [webpLossy(500, 250), "image/webp"],
    ];
    for (const [bytes, mime] of cases) {
      const full = imageSize(bytes, mime);
      for (let n = 0; n < bytes.length; n++) {
        const got = imageSize(bytes.subarray(0, n), mime);
        if (got !== null) expect(got).toEqual(full); // a prefix that still holds the whole size field is fine
      }
      expect(imageSize(bytes.subarray(0, 8), mime)).toBeNull();
    }
    // the size fields themselves
    expect(imageSize(pngBytes(640, 480).subarray(0, 23), "image/png")).toBeNull();
    expect(imageSize(jpegBytes(400, 300).subarray(0, 25), "image/jpeg")).toBeNull();
    expect(imageSize(webpX(1024, 768).subarray(0, 29), "image/webp")).toBeNull();
  });

  it("returns null for a JPEG with no SOF, and for a mime that does not match the bytes", () => {
    const noSof = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xd9]);
    expect(imageSize(noSof, "image/jpeg")).toBeNull();
    expect(imageSize(pngBytes(1, 1), "image/jpeg")).toBeNull();
    expect(imageSize(jpegBytes(1, 1), "image/png")).toBeNull();
    expect(imageSize(pngBytes(1, 1), "image/gif")).toBeNull();
  });
});
