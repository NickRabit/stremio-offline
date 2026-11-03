// Node 25 and later define their own globalThis.localStorage and sessionStorage, which are
// undefined unless the process runs with --localstorage-file. They hide jsdom's storage (in
// Vitest's jsdom environment `window` is globalThis, so it is hidden there too); jsdom's own
// window, which Vitest exposes as `jsdom`, still has it, and it is put back from there.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
for (const name of ["localStorage", "sessionStorage"] as const) {
  if (globalThis[name] === undefined && dom?.window[name]) {
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
  }
}

import { loadHls } from "./hls-loader";
import { LOCALES, loadCatalog } from "./i18n";

// Components under test switch language and attach streams, and expect the next render to do
// either at once rather than after a chunk has arrived.
await Promise.all([...LOCALES.map(loadCatalog), loadHls()]);
