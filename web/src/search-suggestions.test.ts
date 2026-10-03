import { describe, expect, it } from "vitest";
import { CandidatePool, suggest } from "./search-suggestions";

const meta = (id: string, name: string, type = "movie") => ({ id, name, type });

describe("CandidatePool", () => {
  it("keeps the newest entries within its limit", () => {
    const pool = new CandidatePool(3);
    pool.add([meta("1", "A"), meta("2", "B"), meta("3", "C"), meta("4", "D")]);
    expect(pool.list().map((entry) => entry.name)).toEqual(["D", "C", "B"]);
  });

  it("moves a title seen again to the front", () => {
    const pool = new CandidatePool();
    pool.add([meta("1", "A"), meta("2", "B")]);
    pool.add([meta("1", "A")]);
    expect(pool.list().map((entry) => entry.name)).toEqual(["A", "B"]);
  });

  it("forgets the addon once a title has come from two of them", () => {
    const pool = new CandidatePool();
    pool.add([meta("1", "A")], "alpha");
    pool.add([meta("1", "A")], "beta");
    expect(pool.list()[0].addonKey).toBeUndefined();
  });

  it("skips entries without a name", () => {
    const pool = new CandidatePool();
    pool.add([{ id: "1", type: "movie" }]);
    expect(pool.list()).toEqual([]);
  });

  it("empties on clear", () => {
    const pool = new CandidatePool();
    pool.add([meta("1", "A")]);
    pool.clear();
    expect(pool.list()).toEqual([]);
  });
});

describe("suggest", () => {
  const recent = [{ query: "Matrix" }, { query: "Pelíšky" }, { query: "matrix" }, { query: "Marvel" }];

  it("offers up to eight recent searches for an empty draft", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ query: `q${index}` }));
    expect(suggest({ draft: "", recent: many, candidates: [] })).toHaveLength(8);
  });

  it("puts at most three matching recent searches before titles", () => {
    const candidates = Array.from({ length: 10 }, (_, index) => ({ id: String(index), type: "movie", name: `Ma title ${index}` }));
    const rows = suggest({ draft: "ma", recent, candidates });
    expect(rows).toHaveLength(8);
    expect(rows.slice(0, 2)).toEqual([{ kind: "recent", text: "Matrix" }, { kind: "recent", text: "Marvel" }]);
    expect(rows.slice(2).every((row) => row.kind === "title")).toBe(true);
  });

  it("matches without diacritics", () => {
    const rows = suggest({ draft: "pelis", recent, candidates: [{ id: "1", type: "movie", name: "Pelíšky" }] });
    expect(rows).toEqual([{ kind: "recent", text: "Pelíšky" }, { kind: "title", text: "Pelíšky" }]);
  });

  it("filters titles by type and by the scoped addon", () => {
    const candidates = [
      { id: "1", type: "movie", name: "Dune", addonKey: "alpha" },
      { id: "2", type: "series", name: "Dune: Prophecy", addonKey: "alpha" },
      { id: "3", type: "movie", name: "Dune Part Two", addonKey: "beta" },
      { id: "4", type: "movie", name: "Dune 1984" },
    ];
    expect(suggest({ draft: "dune", recent: [], candidates, type: "movie" }).map((row) => row.text)).toEqual(["Dune", "Dune Part Two", "Dune 1984"]);
    expect(suggest({ draft: "dune", recent: [], candidates, addonKey: "alpha" }).map((row) => row.text)).toEqual(["Dune", "Dune: Prophecy"]);
  });

  it("ranks titles by how well they match and drops duplicate names", () => {
    const candidates = [
      { id: "1", type: "movie", name: "The Matrix Reloaded" },
      { id: "2", type: "movie", name: "Matrix" },
      { id: "3", type: "series", name: "Matrix" },
    ];
    expect(suggest({ draft: "matrix", recent: [], candidates }).map((row) => row.text)).toEqual(["Matrix", "The Matrix Reloaded"]);
  });

  it("offers nothing for a punctuation-only draft", () => {
    expect(suggest({ draft: "!!", recent, candidates: [{ id: "1", type: "movie", name: "!!" }] })).toEqual([]);
  });
});
