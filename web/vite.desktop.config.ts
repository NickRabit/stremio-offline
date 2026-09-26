import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The desktop app's own pages -- welcome, splash, error, settings, toast -- built from the same
// components, styles and translations as the web interface, into the desktop workspace. They
// load over file://, so every asset path is relative. The server's bundle never contains them.
export default defineConfig({
  plugins: [react()],
  base: "./",
  // The web app's icons and manifest are for browsers; these pages need none of them.
  publicDir: false,
  define: { "process.env": "{}", global: "globalThis" },
  build: {
    outDir: "../desktop/renderer",
    emptyOutDir: true,
    rollupOptions: { input: "desktop.html" },
  },
});
