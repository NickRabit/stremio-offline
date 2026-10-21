import { LOCALES, loadCatalog } from "./i18n";

// Components under test switch language and expect the next render to speak it at once.
await Promise.all(LOCALES.map(loadCatalog));
