/** The download-library rows a layout baseline is taken against.
 *
 * `library-identify.spec.ts` copies these files in for the chromium journeys.
 * `layout/seed.spec.ts` queues a download of the movie first, the way
 * `downloads.spec.ts` does, and only then copies the same files in beside it.
 * The two lists are this one on purpose: a journey that grows a folder the
 * seed does not, or the other way around, moves the screenshots without a
 * failing assertion.
 */
export const fixtureLibraryTitles = [
  { folder: "Zkušební film (2024)", files: ["Zkušební film.mkv"], id: "tt-e2e-movie", type: "movie" as const },
  { folder: "Zkušební seriál", files: ["Zkušební seriál S01E01.mkv", "Zkušební seriál S01E02.mkv"], id: "tt-e2e-series", type: "series" as const },
];
