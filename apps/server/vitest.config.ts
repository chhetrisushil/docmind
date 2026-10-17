import { defineConfig } from "vitest/config";

export default defineConfig({
  // @loom/* publish require-only `exports`; resolve them the same way under Vite.
  resolve: { conditions: ["node", "require", "default"] },
  // Suites share cluster-wide state (the docmind_app role), so test files run one at a time.
  test: {
    environment: "node",
    fileParallelism: false,
    server: { deps: { external: [/@loom\//, /[\\/]loom[\\/]/] } },
  },
});
