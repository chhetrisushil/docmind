import { createHmac } from "node:crypto";
import type { SurfaceName, ViewName } from "@docmind/contracts";
import { type CompileResult, type Experience, compile } from "@loom-ui/core";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  type HandleInventory,
  handleInventory,
} from "@loom-ui/hydration";
import type { Blueprint } from "@loom/blueprint-runtime";
import { DOCMIND_CATALOG, SURFACES } from "./catalog";
import { EXPERIENCES } from "./views";
import { OWNER_READ, TURN_READ, mergedCatalog } from "./visuals";

export interface ViewPayload {
  view: ViewName | "turn";
  surface: SurfaceName;
  experienceId: string;
  versionHash: string;
  blueprint: Blueprint;
  inventory: HandleInventory;
  fingerprint: CompileResult["fingerprint"];
}
export interface ViewsOptions {
  /** 16 or more bytes: keys the aliases loom-ui gives restricted nodes (DocMind has none, but the key is not optional in production). */
  placeholderKey: string;
  /** A server secret: keys each handle's revision, so a client cannot confirm a guessed provider. */
  revisionKey: string;
  /** The hook the server logs through: a handle and a finding CODE, never a message. */
  onFinding?(handle: string, code: string): void;
}

/** Compiled per-document payloads kept at once (each is keyed by the experience's version hash). */
const DETAIL_CACHE_SIZE = 256;

/** A model-derived per-document experience that does not compile. Carries finding CODES only. */
export class DetailCompileError extends Error {
  constructor(readonly codes: readonly string[]) {
    super(`document detail does not compile: ${codes.join(",")}`);
    this.name = "DetailCompileError";
  }
}

export const VIEW_NAMES = Object.keys(EXPERIENCES) as ViewName[];

/** The sealed, compiled view per (name, surface) with its handle inventory: built once, content-free, the same for everyone.
 * (The per-document detail compiled on demand below is NOT content-free: its labels come from the model; the LRU keeps them in memory until eviction.) */
export function createViewPayloads(o: ViewsOptions) {
  for (const [name, key] of [
    ["placeholderKey", o.placeholderKey],
    ["revisionKey", o.revisionKey],
  ] as const)
    if (typeof key !== "string" || Buffer.byteLength(key) < 16)
      throw new Error(`${name} must be at least 16 bytes`);
  const revisionOf = (handle: string, fingerprint: string): string =>
    createHmac("sha256", o.revisionKey).update(`${handle}\0${fingerprint}`).digest("hex");
  const cache = new Map<string, ViewPayload>();
  for (const surface of SURFACES)
    for (const view of VIEW_NAMES) {
      const exp = EXPERIENCES[view];
      const compiled = compile(exp, {
        surface,
        catalog: DOCMIND_CATALOG,
        hydrationProjectionId: HYDRATION_PROJECTION_ID,
        hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
        viewer: {},
        placeholderKey: o.placeholderKey,
      });
      if (!compiled.ok || compiled.findings.length > 0)
        throw new Error(
          `experience ${view} does not compile for ${surface}: ${compiled.findings.map((f) => f.code).join(",")}`,
        );
      cache.set(`${surface}:${view}`, {
        view,
        surface,
        experienceId: exp.experienceId,
        versionHash: exp.versionHash,
        blueprint: compiled.blueprint,
        inventory: handleInventory(exp, { revisionOf }).inventory,
        fingerprint: compiled.fingerprint,
      });
    }
  // The per-document detail depends on the model's visuals, so it is compiled on demand and kept in a small LRU.
  const details = new Map<string, ViewPayload>();
  const compileOwned = (
    experience: Experience,
    surface: SurfaceName,
    view: "detail" | "turn",
    read: typeof OWNER_READ | typeof TURN_READ,
  ): ViewPayload => {
    const key = `${surface}:${view}:${experience.versionHash}`;
    const hit = details.get(key);
    if (hit) {
      details.delete(key);
      details.set(key, hit);
      return hit;
    }
    const compiled = compile(experience, {
      surface,
      catalog: mergedCatalog(),
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
      viewer: read.viewer,
      audience: read.audience,
      declaredToolClasses: read.declaredToolClasses,
      placeholderKey: o.placeholderKey,
    });
    if (!compiled.ok) throw new DetailCompileError(compiled.findings.map((f) => f.code));
    const payload: ViewPayload = {
      view,
      surface,
      experienceId: experience.experienceId,
      versionHash: experience.versionHash,
      blueprint: compiled.blueprint,
      inventory: handleInventory(experience, {
        revisionOf,
        viewer: read.viewer,
        audience: read.audience,
        declaredToolClasses: read.declaredToolClasses,
      }).inventory,
      fingerprint: compiled.fingerprint,
    };
    details.set(key, payload);
    if (details.size > DETAIL_CACHE_SIZE) details.delete(details.keys().next().value as string);
    return payload;
  };
  const compileDetail = (e: Experience, s: SurfaceName) => compileOwned(e, s, "detail", OWNER_READ);
  const compileTurn = (e: Experience, s: SurfaceName) => compileOwned(e, s, "turn", TURN_READ);
  return {
    compileDetail,
    compileTurn,
    names: VIEW_NAMES as readonly ViewName[],
    surfaces: SURFACES as readonly SurfaceName[],
    payload(name: ViewName, surface: SurfaceName): ViewPayload {
      const p = cache.get(`${surface}:${name}`);
      if (!p) throw new Error("unknown view or surface");
      return p;
    },
    revisionOf,
  };
}
