import { expect, test } from "@playwright/test";
import { goToView } from "../nav";

test.afterEach(async ({ page }) => {
  await page.request.patch("/api/settings", { data: { uiLanguage: "cs" } });
});

const locales = [
  { code: "sk", tag: "sk-SK", home: "Domov", more: "Viac", nav: ["Katalóg", "Knižnica", "Sledované", "Stiahnuté", "Doplnky", "Nastavenia", "Štatistiky"] },
  { code: "de", tag: "de-DE", home: "Startseite", more: "Mehr", nav: ["Katalog", "Bibliothek", "Gefolgt", "Downloads", "Add-ons", "Einstellungen", "Statistiken"] },
  { code: "es", tag: "es-ES", home: "Inicio", more: "Más", nav: ["Catálogo", "Biblioteca", "Siguiendo", "Descargas", "Complementos", "Configuración", "Estadísticas"] },
  { code: "fr", tag: "fr-FR", home: "Accueil", more: "Plus", nav: ["Catalogue", "Bibliothèque", "Suivis", "Téléch.", "Modules", "Paramètres", "Statistiques"] },
  { code: "it", tag: "it-IT", home: "Home", more: "Altro", nav: ["Catalogo", "Libreria", "Seguiti", "Download", "Add-on", "Impostazioni", "Statistiche"] },
  { code: "pl", tag: "pl-PL", home: "Start", more: "Więcej", nav: ["Katalog", "Biblioteka", "Obserwowane", "Pobrane", "Dodatki", "Ustawienia", "Statystyki"] },
  { code: "pt-BR", tag: "pt-BR", home: "Início", more: "Mais", nav: ["Catálogo", "Biblioteca", "Seguindo", "Downloads", "Complementos", "Configurações", "Estatísticas"] },
  { code: "ru", tag: "ru-RU", home: "Главная", more: "Ещё", nav: ["Каталог", "Библиотека", "Отслеживаемые", "Загрузки", "Дополнения", "Настройки", "Статистика"] },
];

for (const locale of locales) {
  test(`${locale.code} navigation and screens fit the mobile viewport`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-locales", "the dedicated mobile locale project runs this check");
    await page.goto("/");
    // Settings sits behind More at this width; the page is still in Czech here.
    await goToView(page, "Nastavení");
    await page.locator(".language-section select").first().selectOption(locale.code);
    await expect(page.locator("html")).toHaveAttribute("lang", locale.tag);

    for (const view of [locale.home, ...locale.nav]) {
      await goToView(page, view, locale.more);
      const dimensions = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        navLabels: [...document.querySelectorAll<HTMLElement>(".sidebar nav button")].map((button) => {
          const label = button.querySelector<HTMLElement>("span");
          if (!label) return null;
          const buttonBox = button.getBoundingClientRect();
          const labelBox = label.getBoundingClientRect();
          return { label: label.textContent, fits: label.scrollWidth <= label.clientWidth + 1
            && labelBox.left >= buttonBox.left - 1 && labelBox.right <= buttonBox.right + 1 };
        }).filter((entry): entry is { label: string | null; fits: boolean } => entry !== null),
      }));
      expect(dimensions.scroll, `${locale.code} ${view} overflows the mobile viewport`).toBeLessThanOrEqual(dimensions.client + 1);
      expect(dimensions.navLabels.filter(({ fits }) => !fits), `${locale.code} navigation labels overflow`).toEqual([]);
    }
  });
}
