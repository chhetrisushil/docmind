import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, loadBlobRoot, loadLimits } from "./limits";

describe("loadLimits", () => {
  it("uses the spec defaults when nothing is set", () => {
    expect(loadLimits({})).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS.maxFileBytes).toBe(50 * 1024 * 1024);
    expect(loadLimits({ DOCMIND_TENANT_MAX_DOCUMENTS: "  " })).toEqual(DEFAULT_LIMITS);
  });

  it("reads overrides", () => {
    expect(
      loadLimits({
        DOCMIND_MAX_UPLOAD_BYTES: "1000",
        DOCMIND_TENANT_MAX_BYTES: "5000",
        DOCMIND_TENANT_MAX_DOCUMENTS: "3",
        DOCMIND_MAX_CONCURRENT_UPLOADS: "1",
      }),
    ).toEqual({
      maxFileBytes: 1000,
      tenantMaxBytes: 5000,
      tenantMaxDocuments: 3,
      maxConcurrentUploadsPerUser: 1,
    });
  });

  it("names the variable, never the value, when one is invalid", () => {
    for (const bad of ["0", "-5", "1.5", "abc", "1e3", "99999999999999999999"]) {
      let message = "";
      try {
        loadLimits({ DOCMIND_TENANT_MAX_BYTES: bad });
      } catch (err) {
        message = String(err);
      }
      expect(message, bad).toContain("DOCMIND_TENANT_MAX_BYTES must be a positive integer");
      expect(message).not.toContain(bad);
    }
  });

  it("refuses a per-file limit above 256 MiB", () => {
    expect(() => loadLimits({ DOCMIND_MAX_UPLOAD_BYTES: String(257 * 1024 * 1024) })).toThrow(
      /DOCMIND_MAX_UPLOAD_BYTES must be at most/,
    );
  });
});

describe("loadBlobRoot", () => {
  it("is absolute whether or not it is configured", () => {
    expect(isAbsolute(loadBlobRoot({}))).toBe(true);
    expect(isAbsolute(loadBlobRoot({ DOCMIND_BLOB_DIR: "relative/blobs" }))).toBe(true);
    expect(loadBlobRoot({ DOCMIND_BLOB_DIR: "/var/lib/docmind" })).toBe("/var/lib/docmind");
  });
});
