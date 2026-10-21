import { loadHls } from "./hls-loader";
import { LOCALES, loadCatalog } from "./i18n";

// Components under test switch language and attach streams, and expect the next render to do
// either at once rather than after a chunk has arrived.
await Promise.all([...LOCALES.map(loadCatalog), loadHls()]);
