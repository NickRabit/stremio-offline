import assert from "node:assert/strict";
import test from "node:test";
import type { FoundFile } from "./library.js";
import { libraryPath, type LibraryRecord } from "./libraries.js";
import { titleUnits, type LibraryMetaRecord } from "./library-match.js";
import { localCopyRecords } from "./local-copy-index.js";
import { localCopies } from "./local-sources.js";

const library: LibraryRecord = {
  id: "lib_00000001",
  name: "Films",
  type: "movie",
  root: "/media/films",
  enabled: true,
  order: 0,
  addedAt: "2024-01-01T00:00:00.000Z",
  writeArtwork: false,
};

const found = (relative: string, size: number): FoundFile => ({
  relative: libraryPath(library.id, relative),
  size,
  modified: "2026-01-01T00:00:00.000Z",
});

test("the local-copy index preserves copies and scans its source object once", async () => {
  const files = [
    found("Collection/Heat/Heat 1080p.mkv", 900),
    found("Collection/Heat/Heat 720p.mkv", 500),
    found("Collection/Other/Other.mkv", 400),
  ];
  const units = titleUnits(files, "movie");
  const records: Record<string, LibraryMetaRecord> = {
    [libraryPath(library.id, "Collection")]: { type: "movie", id: "tt1", source: "scan" },
    [libraryPath(library.id, "Collection/Other")]: { type: "movie", id: "tt2", source: "scan" },
  };
  for (let index = 0; index < 5000; index += 1) {
    records[libraryPath(library.id, `Unrelated/${index}`)] = { type: "series", id: `ttx${index}`, source: "scan" };
  }
  const expected = localCopies({ type: "movie", id: "tt1", files, units, records, libraries: [library] });

  let scans = 0;
  const measured = new Proxy(records, {
    ownKeys(target) {
      scans += 1;
      return Reflect.ownKeys(target);
    },
  });
  const first = await localCopyRecords(measured, "movie", "tt1");
  assert.deepEqual(localCopies({
    type: "movie", id: "tt1", titleIds: first.titleIds, files, units, records: first.records, libraries: [library],
  }), expected);
  assert.equal(scans, 1, "the first lookup builds the identity index");

  const second = await localCopyRecords(measured, "movie", "tt1");
  assert.deepEqual(second, first);
  assert.equal(scans, 1, "another lookup reuses the index for the same qualifiedMeta object");
});
