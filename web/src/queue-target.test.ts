import { expect, it } from "vitest";
import { queueDestination } from "./queue-target";
import type { LibraryView } from "./types";

const library = (id: string, name: string): LibraryView => ({
  id, name, type: "mixed", root: `/downloads/${name}`, enabled: true, order: 0,
  addedAt: "2026-09-01T00:00:00.000Z", writeArtwork: false, autoScanMetadata: true, unreachable: false, readOnly: false,
  defaultMovie: false, defaultSeries: false, titles: 0, files: 0, bytes: 0,
});

const libraries = [library("lib_ab12cd34", "Films"), library("lib_ef56ab78", "Series")];

it("names the library a queued file is going to, instead of showing its id", () => {
  expect(queueDestination("lib_ab12cd34/Dune/Dune.mkv", libraries))
    .toEqual({ library: "Films", path: "Dune/Dune.mkv" });
});

it("leaves a plain path alone, which is what a single-library install writes", () => {
  expect(queueDestination("Dune/Dune.mkv", libraries)).toEqual({ path: "Dune/Dune.mkv" });
});

it("shows an id that belongs to no library rather than swallowing it", () => {
  expect(queueDestination("lib_00000000/Dune.mkv", libraries)).toEqual({ path: "lib_00000000/Dune.mkv" });
});

it("a library id with nothing under it is not a destination worth splitting", () => {
  expect(queueDestination("lib_ab12cd34", libraries)).toEqual({ path: "lib_ab12cd34" });
});
