import { randomUUID } from "node:crypto";
import { ExecutionDeniedError } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { buildApp } from "../config";
import { ingestExecutionId, ingestStartInput, loomIngest } from "./ingest";

const identity = () => ({ tenantId: randomUUID(), userId: randomUUID() });
const appWith = (documentExists: () => Promise<boolean>) =>
  buildApp({ kind: "memory" }, undefined, { ingest: { documentExists } });

describe("ingest start input", () => {
  it("is exactly the three ids, validated, and names the execution without content", () => {
    const who = identity();
    const documentId = randomUUID();
    expect(ingestStartInput(who, documentId)).toEqual({ ...who, documentId });
    expect(ingestExecutionId(who.userId, documentId)).toBe(`u_${who.userId}:ingest-${documentId}`);
  });

  it("canonicalizes the document id to lower case and refuses a non-uuid", () => {
    const who = identity();
    const documentId = randomUUID();
    expect(ingestStartInput(who, documentId.toUpperCase()).documentId).toBe(documentId);
    expect(ingestExecutionId(who.userId, documentId.toUpperCase())).toBe(
      ingestExecutionId(who.userId, documentId),
    );
    expect(() => ingestStartInput(who, "tax-return.pdf")).toThrow();
  });
});

describe("loomIngest", () => {
  it("starts an execution once per document and reports the second start as already started", async () => {
    const app = appWith(async () => true);
    const port = loomIngest(app.runtime);
    const who = identity();
    const documentId = randomUUID();
    const handle = await port.start(who, documentId);
    expect(handle?.executionId).toBe(ingestExecutionId(who.userId, documentId));
    expect((await handle?.waitForCompletion())?.status).toBe("completed");
    expect(await port.start(who, documentId)).toBeNull();
    expect(await port.start(who, documentId.toUpperCase())).toBeNull(); // same document
    await app.close();
  });

  it("cancels a flow that is still running; the step in flight then finds nothing to do", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = appWith(async () => {
      await gate;
      return false; // the document was deleted meanwhile
    });
    const port = loomIngest(app.runtime);
    const who = identity();
    const documentId = randomUUID();
    const handle = await port.start(who, documentId);
    await port.cancel(who, documentId);
    release();
    await expect(handle?.waitForCompletion()).rejects.toThrow(/cancel/i);
    expect(handle?.getState().status).toBe("cancelled");
    await app.close();
  });

  it("treats cancel as idempotent: unknown, finished and repeated cancels all succeed", async () => {
    const app = appWith(async () => true);
    const port = loomIngest(app.runtime);
    const who = identity();
    await expect(port.cancel(who, randomUUID())).resolves.toBeUndefined(); // never started
    const documentId = randomUUID();
    await (await port.start(who, documentId))?.waitForCompletion();
    await expect(port.cancel(who, documentId)).resolves.toBeUndefined(); // already completed
    await expect(port.cancel(who, documentId)).resolves.toBeUndefined(); // and again
    await app.close();
  });

  it("does not let another actor or tenant cancel the execution", async () => {
    const app = appWith(async () => true);
    const port = loomIngest(app.runtime);
    const owner = identity();
    const documentId = randomUUID();
    const handle = await port.start(owner, documentId);
    // Waited out first: a denied cancel on a still-running execution races its journal (see report).
    await handle?.waitForCompletion();
    const id = ingestExecutionId(owner.userId, documentId);
    for (const principal of [
      { tenant: owner.tenantId, actor: randomUUID() },
      { tenant: randomUUID(), actor: owner.userId },
    ]) {
      await expect(app.runtime.cancel(id, "x", { principal })).rejects.toBeInstanceOf(
        ExecutionDeniedError,
      );
    }
    await app.close();
  });
});
