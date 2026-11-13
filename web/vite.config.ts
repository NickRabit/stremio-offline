import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import { localePreloadSource } from "./src/i18n/locale-preload.ts";

/** File stem under web/src/i18n → catalogue locale. English ships in the main chunk. */
const CATALOGUE_LOCALES: Record<string, string> = {
  cs: "cs",
  sk: "sk",
  de: "de",
  es: "es",
  fr: "fr",
  it: "it",
  pl: "pl",
  ptBR: "pt-BR",
  ru: "ru",
};

const localeOfFacade = (facadeModuleId: string): string | undefined => {
  const normalized = facadeModuleId.replaceAll("\\", "/");
  for (const [file, locale] of Object.entries(CATALOGUE_LOCALES)) {
    if (normalized.endsWith(`/web/src/i18n/${file}.ts`)) return locale;
  }
  return undefined;
};

/** Classic script, before the module in <head>. No inline script: the page's CSP is script-src 'self'. */
const insertPreloadScript = (html: string, fileName: string): string => {
  const tag = `<script src="/${fileName}" async></script>`;
  const headStart = html.indexOf("<head");
  const headEnd = html.indexOf("</head>");
  if (headStart === -1 || headEnd < headStart) return html;
  const scriptAt = html.slice(headStart, headEnd).indexOf("<script");
  const at = scriptAt === -1 ? headEnd : headStart + scriptAt;
  return `${html.slice(0, at)}${tag}${html.slice(at)}`;
};

function localePreloadPlugin(): Plugin {
  return {
    name: "locale-preload",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      const found = new Map<string, string>();
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk" || !item.facadeModuleId) continue;
        const locale = localeOfFacade(item.facadeModuleId);
        if (!locale) continue;
        found.set(locale, item.fileName);
      }
      const missing = Object.entries(CATALOGUE_LOCALES)
        .filter(([, locale]) => !found.has(locale))
        .map(([file]) => file);
      if (missing.length > 0) this.error(`Missing language chunks for: ${missing.join(", ")}`);

      const chunks: Record<string, string> = {};
      for (const locale of Object.values(CATALOGUE_LOCALES)) {
        const fileName = found.get(locale);
        if (fileName) chunks[locale] = `/${fileName}`;
      }
      const referenceId = this.emitFile({
        type: "asset",
        name: "locale-preload.js",
        source: localePreloadSource(chunks),
      });
      const emitted = this.getFileName(referenceId);
      const html = bundle["index.html"];
      if (!html || html.type !== "asset") this.error("index.html is missing from the bundle");
      const source = typeof html.source === "string" ? html.source : new TextDecoder().decode(html.source);
      html.source = insertPreloadScript(source, emitted);
    },
  };
}

export default defineConfig({
  plugins: [react(), localePreloadPlugin()],
  // Vite 8's default target is "baseline widely available" (Chrome 111, Safari 16.4). The web
  // app keeps Vite 6's floor instead: TV browsers on Chromium 80-something and older iPads open
  // it, and these targets also keep the -webkit-/-moz- prefixes the stylesheet writes on purpose.
  // The desktop renderer runs in Electron's current Chromium and keeps the default.
  build: { outDir: "dist", emptyOutDir: true, target: ["es2020", "chrome87", "firefox78", "safari14"] },
  server: { proxy: { "/api": "http://localhost:8080" } },
  define: { "process.env": "{}", global: "globalThis" },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    restoreMocks: true,
    setupFiles: ["src/test-setup.ts"],
    testTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/test-setup.ts", "src/i18n/{cs,de,en,es,fr,it,pl,ptBR,ru,sk}.ts"],
      reporter: ["text-summary", "html", "json", "json-summary", "lcovonly"],
      reportsDirectory: "../coverage/web",
    },
  },
});
