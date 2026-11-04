import { beforeEach, describe, expect, it } from "vitest";
import { loadCatalog, setLocale } from "./i18n";
import { genreLabel } from "./genres";

describe("genreLabel", () => {
  beforeEach(async () => { await loadCatalog("cs"); setLocale("cs"); });

  it("translates the catalogue's English genres, whatever their case or spelling", () => {
    expect(["Action", "Biography", "Crime"].map(genreLabel)).toEqual(["Akční", "Životopisný", "Krimi"]);
    expect(genreLabel("science fiction")).toBe("Sci-fi");
    expect(genreLabel("Sci-Fi & Fantasy")).toBe("Sci-fi a fantasy");
    expect(genreLabel("Film-Noir")).toBe("Film noir");
  });

  it("leaves a genre it does not know as it came", () => {
    expect(genreLabel("Komedie")).toBe("Komedie");
    expect(genreLabel("Anime")).toBe("Anime");
  });
});
