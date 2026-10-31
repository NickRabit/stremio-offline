import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The wiring lives in the shell component, which is not mounted in a unit test: the guards
 *  below read the source so the two removed entry points cannot creep back in unnoticed. */
const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("one Favourites section in the shell", () => {
  const app = source("./App.tsx");

  it("puts a Favourites destination in the sidebar and renders its view", () => {
    expect(app).toContain('label={t("nav.favorites")}');
    expect(app).toMatch(/view === "favorites" && <FavoritesView/);
  });

  it("carries the media-server stars in the one grid and never as a second shelf", () => {
    expect(app).not.toContain("RemotePersonalShelf");
    expect(app).not.toContain("remote-personal");
    expect(app).toContain("onOpenRemote=");
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

describe("one star per title in the shell", () => {
  const app = source("./App.tsx");

  it("sends a favourite bound to a title to the one catalogue detail", () => {
    expect(app).toContain("onOpenTitle={openFavoriteTitle}");
    expect(app).toMatch(/const openFavoriteTitle = \(item: FavoriteLibraryItem\) => \{[\s\S]*?openCatalogueDetail\(\{ type: item\.title\.type, id: item\.title\.id/);
  });

  it("reads the other side of a star again after either side is toggled", () => {
    // A library star writes the title's own star too, so the watchlist is read again with it.
    expect(app).toMatch(/await api\.setFavorite\(itemPath, favorite\);[\s\S]*?setWatchlist\(await api\.watchlist\(\)\)/);
    // A catalogue star clears or writes the library's stars, so the listing on screen is read again.
    expect(app).toMatch(/await api\.setWatchlist\(\{[\s\S]*?\n[\s\S]*?setWatchlist\(await api\.watchlist\(\)\);\n[\s\S]*?await loadBrowse\(browsePath\)/);
  });

  it("fills the player's star from the title a library file plays as", () => {
    expect(app).toMatch(/localStream\?\.localPath \? libraryFavorites\.includes\(localStream\.localPath\) \|\| Boolean\(playingCatalogue && inWatchlist\(playingCatalogue\.type, playingCatalogue\.id\)\)/);
    expect(app).toMatch(/const starred = libraryFavorites\.includes\(path\) \|\| Boolean\(playingCatalogue && inWatchlist\(playingCatalogue\.type, playingCatalogue\.id\)\);/);
  });
});

describe("one click rule in the shell", () => {
  const app = source("./App.tsx");

  it("plays a catalogue card by what wrote it: a media-server version, a file, or the detail's own row", () => {
    expect(app).toMatch(/card\.kind === "resume-catalogue"\) \{[\s\S]{0,600}?entry\?\.remote[\s\S]{0,200}?openRemoteCard\(entry\.remote, true\)[\s\S]{0,200}?if \(card\.path\) void playLocal\(card\.title, card\.path, card\.poster, card\.season != null\)/);
    expect(app).toMatch(/resume: \{ \.\.\.\(resumeKeyOf\(card\.key\)/);
  });

  it("opens the catalogue detail a resume file is bound to, at its episode", () => {
    expect(app).toMatch(/card\.kind === "resume-file"\) \{[\s\S]{0,120}?if \(!card\.identity\) return;[\s\S]{0,400}?openCatalogueDetail\(\{ type: card\.identity\.type, id: card\.identity\.id, name: card\.title/);
  });

  it("opens the catalogue detail a Home favourite is bound to", () => {
    expect(app).toMatch(/card\.kind === "favorite"\) \{[\s\S]{0,120}?if \(!card\.title\) return;[\s\S]{0,200}?openCatalogueDetail\(\{ type: card\.title\.type, id: card\.title\.id, name: card\.label/);
  });

  it("forgets a merged media-server card on both sides of the merge", () => {
    expect(app).toMatch(/const forgetResume = \(card: HomeCard\) => \{[\s\S]{0,400}?api\.saveRemoteState\(card\.libraryId, card\.itemId, \{ position: 0, duration: 0 \}\)/);
    expect(app).toMatch(/card\.forgetKeys\?\.length \? api\.forgetManyProgress\(card\.forgetKeys\)/);
  });
});

describe("a star and a follow name the add-on the title came from", () => {
  const app = source("./App.tsx");

  it("sends the add-on with a new star", () => {
    expect(app).toContain("...(favorite && addonKey ? { addonKey } : {}), favorite });");
  });

  it("picks the add-on as the playback position picks it", () => {
    expect(app).toContain("void toggleWatchlist(selected, panelAddonKey(selectedStream?.addonKey))");
    expect(app).toContain("void toggleWatchlist(item, panelAddonKey())");
    expect(app).toContain("detailPlaying.stream.addonKey);");
    expect(app).toContain("progressAddonKey={localStream ? undefined : detailPlaying ? detailPlaying.stream.addonKey : playerSubject?.panel ? panelAddonKey(selectedStream?.addonKey)");
    expect(app).toMatch(/onToggleFavorite=\{\(\) => void toggleWatchlist\(\{ type: catalogueDetail\.type[\s\S]{0,280}?detailAddonKey\)\}/);
  });

  it("hands the add-on to the follow it creates", () => {
    expect(app).toContain("...(detailAddonKey ? { addonKey: detailAddonKey } : {}) })}><Bell/>");
    expect(app).toContain("const addonKey = panelAddonKey(selectedStream?.addonKey); setFollowStart(addonKey ? { ...selected, addonKey } : selected);");
    expect(app).toContain("...(followStart.addonKey ? { addonKey: followStart.addonKey } : {}) }, onFollowed");
  });
});
