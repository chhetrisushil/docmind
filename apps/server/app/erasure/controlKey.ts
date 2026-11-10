import { hkdfSync } from "node:crypto";
import type { Kek } from "@docmind/keystore-pg";

/** HKDF info of Loom's erasure control-stream key; distinct from every other derivation (`docmind-id-v1`, `docmind-tag-v1`, `docmind-entity-v1`). */
export const ERASURE_CONTROL_INFO = "docmind-erasure-control-v1";

/** What Loom's `controlStreamKey` and `previousControlStreamKeys` take. */
export interface ControlStreamKeys {
  current: Buffer;
  previous: Buffer[];
}

/** 32 bytes of HKDF-SHA256 over one KEK (no salt). Secret: it keys the digest that stands for a subject on Loom's plaintext control stream. */
export function deriveControlKey(kek: Kek["key"]): Buffer {
  return Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), ERASURE_CONTROL_INFO, 32));
}

/**
 * The control-stream keys of a server's KEKs (current first, then the ones being retired). They are derived, not configured:
 * the KEK is already a stable deployment secret that never reaches the database. A KEK rotation moves `current`; the previous
 * KEK's key stays listed (as `previousControlStreamKeys`) for as long as the previous KEK is, which recognises the rows it wrote.
 */
export function erasureControlKeys(
  keks: readonly [Kek, ...Kek[]] | readonly Kek[],
): ControlStreamKeys {
  const [current, ...previous] = keks;
  if (!current) throw new Error("erasure control keys need a KEK");
  return {
    current: deriveControlKey(current.key),
    previous: previous.map((k) => deriveControlKey(k.key)),
  };
}
