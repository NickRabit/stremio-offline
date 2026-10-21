import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8080" } },
  define: { "process.env": "{}", global: "globalThis" },
  test: { environment: "jsdom", include: ["src/**/*.test.ts", "src/**/*.test.tsx"], restoreMocks: true, setupFiles: ["src/test-setup.ts"] },
});
