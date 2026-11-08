import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The lineage content collector (lineageGc.ts) erases every blob in `lineage_content` that the visuals `Lineage`
 * does not name, and scans NO Loom event store. That is complete only while the visuals Lineage is the sole user of
 * the store. This ratchet fails when any other code starts wiring content (a content-store decorator, a claim-check
 * or externalizing event store, a `SeenLog`, a second `Lineage`, or another consumer of the raw store), so whoever adds
 * one must first contribute its roots to the collector (`pgLineageGc.ts`) and then update this allowlist.
 */
// vitest runs with apps/server as the working directory.
const repo = resolve(process.cwd(), "../..");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|d)\.ts$/.test(name)) out.push(p);
  }
  return out;
};

// What would put content in Loom's store or read it back.
const CONTENT_WIRING =
  /\b(ContentResolvingEventStore|ContentTouchingSnapshotStore|claimCheck\w*|ClaimCheck\w*|SeenLog|createSeenLog|collectSeenRoots|collectSeenGarbage|new Lineage\(|PgContentStore|EncryptingContentStore|sealedLineageContent|rawLineageContent|lineageContent|lineage_content|externalize)\b/;

/** Files allowed to mention it, each with the reason. */
const ALLOWED: Record<string, string> = {
  "apps/server/app/storage/pgContentStore.ts": "the store itself",
  "apps/server/app/storage.ts": "sealedLineageContent: the sealing wrapper over it",
  "apps/server/app/storage/lineageGc.ts": "the collector",
  "apps/server/app/storage/pgLineageGc.ts": "the collector's binding",
  "apps/server/app/flows/visualize-document/lineage.ts":
    "THE visuals Lineage (the only `new Lineage(`)",
  "apps/server/app/compose.ts":
    "builds the store and the one Lineage over it, hands both to the collector",
  "apps/server/app/documents/testHarness.ts": "an in-memory stand-in for tests",
  "apps/server/app/bootIngest.ts": "starts the collector",
};

describe("who uses lineage_content", () => {
  const files = [
    ...walk(join(repo, "apps/server/app")),
    ...walk(join(repo, "apps/server/scripts")),
    ...readdirSync(join(repo, "packages")).flatMap((pkg) => {
      try {
        return walk(join(repo, "packages", pkg, "src"));
      } catch {
        return [];
      }
    }),
  ];

  it("is wired by the allowlisted files only (anything else must contribute roots to the collector first)", () => {
    const offenders = files
      .map((f) => relative(repo, f))
      .filter((rel) => CONTENT_WIRING.test(readFileSync(join(repo, rel), "utf8")))
      .filter((rel) => !(rel in ALLOWED) && !rel.startsWith("packages/blob-store/"));
    expect(offenders).toEqual([]);
  });

  it("has exactly one Lineage in the server, so one lineage pins() sees every line", () => {
    const makers = files
      .map((f) => relative(repo, f))
      .filter((rel) => /\bnew Lineage\(/.test(readFileSync(join(repo, rel), "utf8")));
    // (the test harness builds an in-memory one over an in-memory store, never over lineage_content)
    expect(makers).toEqual([
      "apps/server/app/documents/testHarness.ts",
      "apps/server/app/flows/visualize-document/lineage.ts",
    ]);
    const composed = readFileSync(join(repo, "apps/server/app/compose.ts"), "utf8");
    expect(composed.match(/\bvisualsLineage\(/g)).toHaveLength(1);
  });

  it("only the visuals lineage and the collector touch the raw store in compose", () => {
    const composed = readFileSync(join(repo, "apps/server/app/compose.ts"), "utf8");
    expect(composed.match(/\brawLineageContent\b/g)).toHaveLength(3); // built, sealed over, handed to the collector
    expect(composed.match(/new PgContentStore\(/g)).toHaveLength(1);
  });

  it("never wires Loom's own content plugin: no Loom execution cites this store", () => {
    const config = readFileSync(join(repo, "apps/server/app/config.ts"), "utf8");
    expect(config).not.toMatch(/plugin-content|claimCheck|contentStore/i);
  });
});
