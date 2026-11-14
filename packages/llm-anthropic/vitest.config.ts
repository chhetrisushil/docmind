import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Loom's conformance kits are ESM with extensionless imports, so Vite must load them.
    server: { deps: { inline: [/@loomwork\/conformance/] } },
  },
});
