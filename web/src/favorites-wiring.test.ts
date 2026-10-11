import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The wiring lives in the shell component, which is not mounted in a unit test: the guards
 *  below read the source so the two removed entry points cannot creep back in unnoticed. */
const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("one Favourites section in the shell", () => {
  const app = source("./App.tsx");

  it("puts a Favourites destination in the sidebar and renders its view", () => {
    expect(app).toContain('label={t("nav.favorites")}');
    expect(app).toContain('view === "favorites" && <FavoritesView');
  });

  it("removed the catalogue's My list picker row", () => {
    expect(app).not.toContain("catalog.myList");
    expect(app).not.toContain("VIRTUAL.watchlist");
  });

  it("removed the library's Favourites shelf entry and the favorites-only toggle", () => {
    const shelf = source("./LibraryShelf.tsx");
    expect(shelf).not.toContain("library.shelf.favorites");
    expect(shelf).not.toContain("onShowFavorites");
    expect(app).not.toContain('t("library.onlyFavorites")');
  });
});
