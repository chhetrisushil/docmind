import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // @loom/* publish require-only `exports`; resolve them the same way under Vite.
  resolve: {
    conditions: ["node", "require", "default"],
    // The auth test kit imports vitest, which cannot be require()d from the CommonJS build, so
    // tests load it from source.
    alias: { "@docmind/auth/testing": resolve(__dirname, "../../packages/auth/src/testing.ts") },
  },
  // Suites share cluster-wide state (the docmind_app role), so test files run one at a time.
  test: {
    environment: "node",
    fileParallelism: false,
    server: { deps: { external: [/@loom\//, /[\/]loom[\/]/] } },
  },
});
