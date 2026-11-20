import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "./errors.js";
import {
  parsePattern,
  planRenames,
  renderPattern,
  type RenameCandidate,
  type RenamePlanInput,
} from "./library-rename-plan.js";

const pattern = "{title} ({year})";
const candidate = (overrides: Partial<RenameCandidate> = {}): RenameCandidate => ({
  key: "lib_00000001/Films/Heat.mkv",
  folder: "lib_00000001/Films",
  name: "Heat.mkv",
  isFile: true,
  kind: "movie",
  fields: { title: "Heat", year: 1995 },
  ...overrides,
});

const input = (candidates: RenameCandidate[], overrides: Partial<RenamePlanInput> = {}): RenamePlanInput => ({
  candidates,
  moviePattern: parsePattern(pattern),
  episodePattern: parsePattern("{title} - S{season:2}E{episode:2}"),
  siblings: new Map(candidates.map((item) => [item.folder, candidates.map((row) => row.name)])),
  caseInsensitive: () => false,
  sidecarsOf: () => [],
  busy: new Set(),
  ...overrides,
});

test("pattern parsing keeps literals and accepts only the four fields with bounded padding", () => {
  assert.deepEqual(parsePattern("Film {title} {year} S{season:2}E{episode:4}").parts, [
    { kind: "literal", value: "Film " },
    { kind: "field", value: "title" },
    { kind: "literal", value: " " },
    { kind: "field", value: "year" },
    { kind: "literal", value: " S" },
    { kind: "field", value: "season", width: 2 },
    { kind: "literal", value: "E" },
    { kind: "field", value: "episode", width: 4 },
  ]);
  for (const invalid of ["{director}", "{title", "{season:0}", "{season:5}", "{title:2x}", "{{title}"]) {
    assert.throws(() => parsePattern(invalid), (error: AppError) => error.messageKey === "err.renamePatternInvalid");
  }
});

test("rendering pads values and reports every missing field without treating zero as absent", () => {
  const parsed = parsePattern("{title} S{season:3}E{episode:2} ({year})");
  assert.deepEqual(renderPattern(parsed, { title: "Pilot", season: 0, episode: 7, year: 2024 }), {
    value: "Pilot S000E07 (2024)",
    missing: [],
  });
  assert.deepEqual(renderPattern(parsed, { title: "Pilot", season: 2 }), {
    value: "Pilot S002E ()",
    missing: ["episode", "year"],
  });
});

test("a rename keeps a file extension and a folder has none", () => {
  const rows = planRenames(input([
    candidate(),
    candidate({
      key: "lib_00000001/Films/Thief", folder: "lib_00000001/Films", name: "Thief", isFile: false,
      fields: { title: "Thief", year: 1981 },
    }),
  ], {
    siblings: new Map([["lib_00000001/Films", ["Heat.mkv", "Thief"]]]),
  }));
  assert.deepEqual(rows.map(({ status, to, isFile }) => ({ status, to, isFile })), [
    { status: "rename", to: "Heat (1995).mkv", isFile: true },
    { status: "rename", to: "Thief (1981)", isFile: false },
  ]);
});

test("every refusal has its own status in isolation", async (t) => {
  await t.test("unidentified", () => {
    assert.equal(planRenames(input([candidate({ kind: "unknown", fields: {} })])).at(0)?.status, "unidentified");
  });
  await t.test("missing", () => {
    const row = planRenames(input([candidate({ fields: { title: "Heat" } })])).at(0);
    assert.equal(row?.status, "missing");
    assert.deepEqual(row?.missing, ["year"]);
    assert.equal(row?.to, undefined);
  });
  await t.test("invalid", () => {
    assert.equal(planRenames(input([candidate({ fields: { title: "../Bad", year: 1995 } })])).at(0)?.status, "invalid");
  });
  await t.test("busy", () => {
    assert.equal(planRenames(input([candidate()], { busy: new Set([candidate().key]) })).at(0)?.status, "busy");
  });
  await t.test("same", () => {
    const row = planRenames(input([candidate({ name: "Heat (1995).mkv" })], {
      siblings: new Map([["lib_00000001/Films", ["Heat (1995).mkv"]]]),
    })).at(0);
    assert.equal(row?.status, "same");
  });
  await t.test("collision", () => {
    const row = planRenames(input([candidate()], {
      siblings: new Map([["lib_00000001/Films", ["Heat.mkv", "Heat (1995).mkv"]]]),
    })).at(0);
    assert.equal(row?.status, "collision");
  });
  await t.test("duplicate", () => {
    const rows = planRenames(input([
      candidate({ name: "One.mkv" }),
      candidate({ key: "lib_00000001/Films/Two.mkv", name: "Two.mkv" }),
    ], { siblings: new Map([["lib_00000001/Films", ["One.mkv", "Two.mkv"]]]) }));
    assert.deepEqual(rows.map((row) => row.status), ["duplicate", "duplicate"]);
  });
  await t.test("chain", () => {
    const first = candidate({ key: "lib_00000001/Films/A.mkv", name: "A.mkv", fields: { title: "B", year: 1995 } });
    const second = candidate({ key: "lib_00000001/Films/B.mkv", name: "B.mkv", fields: { title: "A", year: 1995 } });
    const rows = planRenames(input([first, second], {
      siblings: new Map([["lib_00000001/Films", ["A.mkv", "B.mkv"]]]),
      moviePattern: parsePattern("{title}"),
    }));
    assert.deepEqual(rows.map((row) => row.status), ["chain", "chain"]);
  });
});

test("case folding permits one case-only rename and rejects only folded duplicates", () => {
  const caseOnly = planRenames(input([
    candidate({ name: "Heat.mkv", fields: { title: "HEAT", year: 1995 } }),
  ], {
    siblings: new Map([["lib_00000001/Films", ["Heat.mkv"]]]),
    caseInsensitive: () => true,
  }));
  assert.equal(caseOnly[0]?.status, "rename");

  const names = [
    candidate({ key: "lib_00000001/Films/One.mkv", name: "One.mkv", fields: { title: "Heat", year: 1995 } }),
    candidate({ key: "lib_00000001/Films/Two.mkv", name: "Two.mkv", fields: { title: "HEAT", year: 1995 } }),
  ];
  const siblings = new Map([["lib_00000001/Films", ["One.mkv", "Two.mkv"]]]);
  assert.deepEqual(planRenames(input(names, { siblings, caseInsensitive: () => true })).map((row) => row.status), ["duplicate", "duplicate"]);
  assert.deepEqual(planRenames(input(names, { siblings, caseInsensitive: () => false })).map((row) => row.status), ["rename", "rename"]);
});

test("a subtitle target already occupied refuses the video row", () => {
  const row = planRenames(input([candidate({ fields: { title: "Thief", year: 1995 } })], {
    siblings: new Map([["lib_00000001/Films", ["Heat.mkv", "Heat.en.srt", "Thief (1995).en.srt"]]]),
    sidecarsOf: () => ["Heat.en.srt"],
  })).at(0);
  assert.equal(row?.status, "collision");
  assert.equal(row?.sidecars, 1);
});
