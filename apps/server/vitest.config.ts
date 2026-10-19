import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // @loom/* publish require-only `exports`; resolve them the same way under Vite.
  resolve: {
    conditions: ["node", "require", "default"],
    // The auth test kit imports vitest, which cannot be require()d from the CommonJS build, so
    // tests load it from source.
    // The vector-pg kit and the package entry must share one module graph, or VectorDimensionError
    // would be two classes (the CommonJS build and the source), so the entry loads from source too.
    alias: [
      {
        find: "@docmind/auth/testing",
        replacement: resolve(__dirname, "../../packages/auth/src/testing.ts"),
      },
      {
        find: "@docmind/embeddings/testing",
        replacement: resolve(__dirname, "../../packages/embeddings/src/testing/fakeOllama.ts"),
      },
      {
        find: "@docmind/vector-pg/testing",
        replacement: resolve(__dirname, "../../packages/vector-pg/src/testing/conformance.ts"),
      },
      {
        find: /^@docmind\/vector-pg$/,
        replacement: resolve(__dirname, "../../packages/vector-pg/src/index.ts"),
      },
    ],
  },
  // Suites share cluster-wide state (the docmind_app role), so test files run one at a time.
  test: {
    environment: "node",
    fileParallelism: false,
    setupFiles: ["./vitest.setup.ts"],
    server: {
      deps: {
        external: [/@loom\//, /[\\/]loom[\\/]/],
        // Loom's conformance kits are ESM with extensionless imports, so Vite must load them.
        inline: [/@loom\/conformance/, /[\\/]conformance[\\/]dist/],
      },
    },
  },
});
