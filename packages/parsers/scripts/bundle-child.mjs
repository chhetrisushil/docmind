// Bundles the parse child into one self-contained CommonJS file (M3b D3). The child runs under
// `node --permission` with read access to this file's directory only, so it must not resolve
// anything at run time: every dependency is inlined. The input is tsc's output, so the bundle and the
// unit tests see the same compiled code.
import { build } from "esbuild";

await build({
  entryPoints: ["dist/runner/childMain.js"],
  outfile: "dist/child/child.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
});
