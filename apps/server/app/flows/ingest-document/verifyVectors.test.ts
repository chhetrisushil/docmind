import { VectorSchemaError, VectorVersionError } from "@docmind/vector-pg";
import { describe, expect, it, vi } from "vitest";
import { StartupConfigError } from "../../startupError";
import { NIL_TENANT, PGVECTOR_TOO_OLD, VECTOR_MISMATCH, verifyVectors } from "./verifyVectors";

describe("verifyVectors", () => {
  it("verifies with the nil tenant and runs no cleanup on success", async () => {
    const verify = vi.fn(async () => {});
    const cleanup = vi.fn(async () => {});
    await verifyVectors({ verify }, [cleanup]);
    expect(verify).toHaveBeenCalledWith(NIL_TENANT);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("accepts a store without verify (the in-memory test seam)", async () => {
    await expect(verifyVectors({}, [])).resolves.toBeUndefined();
  });

  it("turns a dimension mismatch into a value-free StartupConfigError after cleanup", async () => {
    const cleanup = vi.fn(async () => {});
    const verify = async () => {
      throw new VectorSchemaError(768);
    };
    const err = await verifyVectors({ verify }, [cleanup]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StartupConfigError);
    expect((err as Error).message).toBe(VECTOR_MISMATCH);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not map a plain Error that merely carries the same text", async () => {
    const plain = new Error("chunks.embedding is not vector(768)");
    const err = await verifyVectors({ verify: async () => Promise.reject(plain) }, []).catch(
      (e: unknown) => e,
    );
    expect(err).toBe(plain);
    expect(err).not.toBeInstanceOf(StartupConfigError);
  });

  it("keeps any other failure as it is (class-only reporting) after cleanup", async () => {
    const cleanup = vi.fn(async () => {});
    const boom = new TypeError("connect to postgres://u:secret@host failed");
    const err = await verifyVectors({ verify: async () => Promise.reject(boom) }, [cleanup]).catch(
      (e: unknown) => e,
    );
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(StartupConfigError);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("turns an old pgvector into a StartupConfigError after cleanup", async () => {
    const cleanup = vi.fn(async () => {});
    const verify = async () => {
      throw new VectorVersionError();
    };
    const err = await verifyVectors({ verify }, [cleanup]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StartupConfigError);
    expect((err as Error).message).toBe(PGVECTOR_TOO_OLD);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
