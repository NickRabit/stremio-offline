import { beforeEach, expect, it } from "vitest";
import { offeredLibraries, ruleTarget, targetPreview } from "./save-target";
import { setLocale } from "./i18n";
import type { AddonDownloadSettings, LibraryType, LibraryView } from "./types";

beforeEach(() => setLocale("en"));

const library = (id: string, name: string, type: LibraryType, extra: Partial<LibraryView> = {}): LibraryView => ({
  id, name, type, root: `/media/${name}`, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: true, autoScanMetadata: true, unreachable: false, readOnly: false, defaultMovie: false, defaultSeries: false,
  titles: 0, files: 0, bytes: 0, ...extra,
});

const settings = (movie: Partial<AddonDownloadSettings["movie"]>, series: Partial<AddonDownloadSettings["series"]>): AddonDownloadSettings => ({
  movie: { subfolder: "", layout: "structured", ...movie },
  series: { subfolder: "", layout: "structured", ...series },
});

it("offers only the libraries a title of this kind can be written to", () => {
  const libraries = [
    library("lib_a", "Films", "movie"),
    library("lib_b", "Shows", "series"),
    library("lib_c", "Mixed", "mixed"),
    library("lib_d", "Off", "movie", { enabled: false }),
    library("lib_e", "Read only", "movie", { readOnly: true }),
    library("lib_f", "Away", "movie", { unreachable: true }),
  ];

  expect(offeredLibraries(libraries, "movie").map((item) => item.id)).toEqual(["lib_a", "lib_c"]);
  expect(offeredLibraries(libraries, "series").map((item) => item.id)).toEqual(["lib_b", "lib_c"]);
});

it("names the library a rule would use, falling back to the default-flagged one", () => {
  const libraries = [library("lib_a", "Films", "movie"), library("lib_b", "Downloads", "mixed", { defaultMovie: true })];

  expect(ruleTarget(settings({ subfolder: "Kino", layout: "flat" }, {}), "movie", libraries))
    .toEqual({ libraryId: "lib_b", subfolder: "Kino", layout: "flat" });
  expect(ruleTarget(settings({ libraryId: "lib_a" }, {}), "movie", libraries))
    .toEqual({ libraryId: "lib_a", subfolder: "", layout: "structured" });
  expect(ruleTarget(undefined, "series", libraries)).toEqual({ subfolder: "", layout: "structured" });
});

it("draws the folder chain a title lands in for each layout and kind", () => {
  const libraries = [library("lib_a", "Films", "movie"), library("lib_b", "Shows", "series")];

  expect(targetPreview({ libraryId: "lib_a", subfolder: "Kino", layout: "structured" }, libraries, "Dune", "movie"))
    .toEqual(["Films", "Kino", "Dune"]);
  expect(targetPreview({ libraryId: "lib_a", subfolder: "Kino", layout: "flat" }, libraries, "Dune", "movie"))
    .toEqual(["Films", "Kino"]);
  expect(targetPreview({ libraryId: "lib_b", subfolder: "", layout: "structured" }, libraries, "Friends", "series", 1))
    .toEqual(["Shows", "Friends", "01 serie"]);
  expect(targetPreview({ libraryId: "lib_b", subfolder: "", layout: "flat" }, libraries, "Friends", "series", 3))
    .toEqual(["Shows"]);
  expect(targetPreview({ libraryId: "lib_missing", subfolder: "", layout: "structured" }, libraries, "Dune", "movie")[0])
    .toBe("Default library");
});
