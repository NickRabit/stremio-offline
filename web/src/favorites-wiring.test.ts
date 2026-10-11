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

  it("keeps the compact bar at five slots by folding Favourites into More", () => {
    // The rule is docs/home-spec.md and e2e/tests/layout/invariants.spec.ts: the compact chrome
    // shows exactly Home, Catalogue, Library, Downloads and More.
    expect(app).toContain('secondary icon={<Star/>} label={t("nav.favorites")}');
    expect(app).toContain('{ key: "favorites", icon: <Star/>');
    expect(app).toMatch(/moreActive = [^;]*view === "favorites"/);
  });

  it("re-reads the Favourites list when the player closes", () => {
    expect(app).toContain('if (view === "favorites") void loadFavorites(favoritesFilter, 0);');
  });

  it("removed the catalogue's My list picker row", () => {
    expect(app).not.toContain("catalog.myList");
    expect(app).not.toContain("VIRTUAL.watchlist");
  });
});

describe("one Continue watching section in the shell", () => {
  const app = source("./App.tsx");

  it("puts a Continue watching destination in the sidebar and renders its view", () => {
    expect(app).toContain('label={t("nav.resume")}');
    expect(app).toContain('view === "resume" && <ResumeView');
  });

  it("keeps the compact bar at five slots by folding Continue watching into More", () => {
    expect(app).toContain('secondary icon={<History/>} label={t("nav.resume")}');
    expect(app).toContain('{ key: "resume", icon: <History/>');
    expect(app).toMatch(/moreActive = [^;]*view === "resume"/);
  });

  it("removed the catalogue's Continue watching picker row and the library shelf", () => {
    expect(app).not.toContain("VIRTUAL.resume");
    expect(app).not.toContain("catalogResume");
    expect(app).not.toContain("LibraryShelf");
    expect(app).not.toContain("chooseLibraryShelf");
    expect(app).not.toContain('t("library.onlyFavorites")');
  });

  it("removed the library's own resume list and every entry point into it", () => {
    expect(app).not.toContain('":resume"');
    expect(app).not.toContain("resumeLibrary");
    expect(app).not.toContain("NewEpisodesRow");
    expect(source("./api.ts")).not.toContain("resumeLibrary");
    expect(source("./views.ts")).not.toContain(":resume");
    expect(source("./types.ts")).not.toMatch(/ExtraView =[^;]*:resume/);
  });
});
