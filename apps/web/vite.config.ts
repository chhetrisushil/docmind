import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// @docmind/contracts is CommonJS; the browser takes its TypeScript source instead.
const contracts = fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@docmind/contracts": contracts },
    // loom-ui's elements and ours must share one Lit.
    dedupe: ["lit"],
  },
  server: {
    port: 5173,
    // Same origin as the page, so the server's origin guard and the session cookie work unchanged.
    proxy: {
      "/api": { target: process.env.DOCMIND_API ?? "http://127.0.0.1:3000", changeOrigin: false },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      // `node:crypto` in the bundle means a Node-only loom-ui entry (the main entry of @loom-ui/core or the root of
      // @loom-ui/hydration) was imported by mistake: fail the build instead of shipping a broken page.
      onwarn(warning, handler) {
        if (/externalized for browser compatibility/.test(warning.message)) {
          throw new Error(`the web bundle must be browser-clean: ${warning.message}`);
        }
        handler(warning);
      },
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    setupFiles: ["./src/testing/setup.ts"],
    // loom-ui and Loom's runtimes are linked built ESM with extensionless specifiers: Vite must transform them.
    server: { deps: { inline: [/\/loom-ui\//, /\/loom\/packages\//] } },
  },
});
