import { defineConfig } from "vitest/config";

export default defineConfig({
  // @loom/* publish require-only `exports`; resolve them the same way under Vite.
  resolve: { conditions: ["node", "require", "default"] },
  test: {
    environment: "node",
    server: {
      deps: {
        external: [/@loom\//, /[\\/]loom[\\/]/],
        // Loom's conformance kits are ESM with extensionless imports, so Vite must load them.
        inline: [/@loom\/conformance/, /[\\/]conformance[\\/]dist/],
      },
    },
  },
});
