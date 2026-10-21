import { createHmac } from "node:crypto";
import type { SurfaceName, ViewName } from "@docmind/contracts";
import { type CompileResult, compile } from "@loom-ui/core";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  type HandleInventory,
  handleInventory,
} from "@loom-ui/hydration";
import type { Blueprint } from "@loom/blueprint-runtime";
import { DOCMIND_CATALOG, SURFACES } from "./catalog";
import { EXPERIENCES } from "./views";

export interface ViewPayload {
  view: ViewName;
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

export const VIEW_NAMES = Object.keys(EXPERIENCES) as ViewName[];

/** The sealed, compiled view per (name, surface) with its handle inventory: built once, content-free, the same for everyone. */
export function createViewPayloads(o: ViewsOptions) {
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
  return {
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
