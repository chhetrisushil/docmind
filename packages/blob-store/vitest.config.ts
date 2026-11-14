import { defineConfig } from "vitest/config";

export default defineConfig({
  // @loomwork/* publish require-only `exports`; resolve them the same way under Vite.
  resolve: { conditions: ["node", "require", "default"] },
  test: {
    environment: "node",
    server: {
      deps: {
        // loom only: loom-ui shares the scope as @loomwork/ui-*.
        external: [/@loomwork\/(?!ui-)/, /[\\/]loom[\\/]/],
        // Loom's conformance kits are ESM with extensionless imports, so Vite must load them.
        inline: [/@loomwork\/conformance/, /[\\/]conformance[\\/]dist/],
      },
    },
  },
});
