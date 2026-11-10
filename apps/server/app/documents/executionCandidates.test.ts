import { describe, expect, it } from "vitest";
import { legacyIds } from "../opaqueIds";
import { testOpaqueIds } from "../opaqueIds/testing";
import {
  documentLineageCandidates,
  existingUser,
  ingestCandidates,
  suggestTagsCandidates,
  visualizeCandidates,
} from "./executionCandidates";

const T = "00000000-0000-0000-0000-0000000000aa";
const U = "11111111-1111-4111-8111-111111111111";
const D = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("candidates", () => {
  it("are the old id alone for a user with no handle, and the old then the new id for one with a handle", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    expect(await existingUser(t.ids, { tenantId: T, userId: U })).toBeUndefined();
    expect(await t.keys.get(U)).toBeNull(); // looking did not mint a key
    expect(ingestCandidates(U, D, 2)).toEqual([legacyIds.ingest(U, D, 2)]);

    const user = await t.ids.ensureUser({ tenantId: T, userId: U });
    const found = await existingUser(t.ids, { tenantId: T, userId: U });
    expect(found?.handle).toBe(user.handle);
    expect(ingestCandidates(U, D, 2, found)).toEqual([
      legacyIds.ingest(U, D, 2),
      user.ingest(D, 2),
    ]);
    expect(visualizeCandidates(U, D, 3, undefined, found)).toEqual([
      legacyIds.visualize(U, D, 3),
      user.visualize(D, 3),
    ]);
    expect(visualizeCandidates(U, D, 3, 2, found)).toEqual([
      legacyIds.visualize(U, D, 3, 2),
      user.visualize(D, 3, 2),
    ]);
    expect(suggestTagsCandidates(U, D, 4, found)).toEqual([
      legacyIds.suggestTags(U, D, 4),
      user.suggestTags(D, 4),
    ]);
    expect(documentLineageCandidates(U, D, found)).toEqual([
      user.documentLineage(D),
      legacyIds.documentLineage(U, D),
    ]);
    expect(documentLineageCandidates(U, D)).toEqual([legacyIds.documentLineage(U, D)]);
  });

  it("a destroyed key is no user: nothing new-format can still be running", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    await t.ids.ensureUser({ tenantId: T, userId: U });
    await t.keys.destroy(U);
    t.ids.forget(U);
    expect(await existingUser(t.ids, { tenantId: T, userId: U })).toBeUndefined();
  });
});
