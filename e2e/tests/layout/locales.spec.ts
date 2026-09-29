import { expect, test } from "@playwright/test";

const locales = [
  { code: "sk", tag: "sk-SK", nav: ["Katalóg", "Knižnica", "Sťahovanie", "Doplnky", "Nastavenia", "Štatistiky"] },
  { code: "de", tag: "de-DE", nav: ["Katalog", "Bibliothek", "Downloads", "Add-ons", "Einstellungen", "Statistiken"] },
  { code: "es", tag: "es-ES", nav: ["Catálogo", "Biblioteca", "Descargas", "Complementos", "Configuración", "Estadísticas"] },
  { code: "fr", tag: "fr-FR", nav: ["Catalogue", "Bibliothèque", "Téléch.", "Modules", "Paramètres", "Statistiques"] },
  { code: "it", tag: "it-IT", nav: ["Catalogo", "Libreria", "Download", "Add-on", "Impostazioni", "Statistiche"] },
  { code: "pl", tag: "pl-PL", nav: ["Katalog", "Biblioteka", "Pobrane", "Dodatki", "Ustawienia", "Statystyki"] },
  { code: "pt-BR", tag: "pt-BR", nav: ["Catálogo", "Biblioteca", "Downloads", "Complementos", "Configurações", "Estatísticas"] },
  { code: "ru", tag: "ru-RU", nav: ["Каталог", "Библиотека", "Загрузки", "Дополнения", "Настройки", "Статистика"] },
];

for (const locale of locales) {
  test(`${locale.code} navigation and screens fit the mobile viewport`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-locales", "the dedicated mobile locale project runs this check");
    await page.goto("/");
    await page.locator(".sidebar nav button").nth(4).click();
    await page.locator(".language-section select").first().selectOption(locale.code);
    await expect(page.locator("html")).toHaveAttribute("lang", locale.tag);

    for (const view of locale.nav) {
      await page.getByRole("button", { name: view, exact: true }).click();
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
