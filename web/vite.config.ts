import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Vite 8's default target is "baseline widely available" (Chrome 111, Safari 16.4). The web
  // app keeps Vite 6's floor instead: TV browsers on Chromium 80-something and older iPads open
  // it, and these targets also keep the -webkit-/-moz- prefixes the stylesheet writes on purpose.
  // The desktop renderer runs in Electron's current Chromium and keeps the default.
  build: { outDir: "dist", emptyOutDir: true, target: ["es2020", "chrome87", "firefox78", "safari14"] },
  server: { proxy: { "/api": "http://localhost:8080" } },
  define: { "process.env": "{}", global: "globalThis" },
  test: { environment: "jsdom", include: ["src/**/*.test.ts", "src/**/*.test.tsx"], restoreMocks: true, setupFiles: ["src/test-setup.ts"] },
});
