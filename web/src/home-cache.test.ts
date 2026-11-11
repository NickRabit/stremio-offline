import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homeCatalogRowId } from "../../server/src/home";
import type { HomeCard, HomeOrderEntry } from "../../server/src/home";
import type { HomeRows, HomeRowState } from "./home-state";
import { clearHomeCache, HOME_CACHE_FORMAT, HOME_CACHE_MAX_BYTES, HOME_CACHE_PREFIX, readHomeCache, writeHomeCache } from "./home-cache";

const at = "2026-01-01T00:00:00.000Z";
const movie = homeCatalogRowId("cinemeta", "movie", "top");
const card: HomeCard = {
  kind: "resume-file", key: "file:a", title: "A", path: "Films/A.mkv",
  progress: { position: 1, duration: 4 }, updatedAt: at, forgetKeys: ["file:a"],
};
const samples: HomeCard[] = [
  { kind: "remote", key: "remote:1", title: "R", provider: "jellyfin", libraryId: "rlib", libraryName: "Server", itemId: "i1", itemType: "movie", updatedAt: at },
  card,
  { kind: "resume-catalogue", key: "movie:tt1", title: "C", type: "movie", id: "tt1", name: "C", updatedAt: at, forgetKeys: ["movie:tt1"] },
  { kind: "completed", key: "c", title: "Done", path: "Films/D.mkv", completedAt: at },
  { kind: "favorite", key: "f", path: "Films/F", itemKind: "folder", label: "Fav" },
  { kind: "favorite-catalogue", key: "series:tt2", type: "series", id: "tt2", name: "Show" },
  { kind: "recent", key: "r", path: "Films/R.mkv", label: "Recent", addedAt: at, libraryId: "lib" },
  { kind: "episode", key: "e", followId: "f", type: "series", metaId: "tt2", name: "Show", released: at, season: 2, episode: 4 },
  { kind: "discovery", key: "d", type: "movie", id: "tt3", name: "Disc", title: "Disc" },
  { kind: "tonight", key: "t", path: "Films/T.mkv", itemKind: "file", label: "Tonight", libraryId: "lib" },
  { kind: "confirm", key: "s", libraryId: "lib", library: "Films", label: "guess.mkv", path: "Films/guess.mkv", candidate: { name: "Real" } },
];
const ok = (items: HomeCard[]): HomeRowState => ({ status: "ok", items, hasMore: false, partial: false, request: 4 });
const rows = (items: HomeCard[] = [card]): HomeRows => ({
  resume: ok(items),
  [movie]: ok([]),
  recent: { ...ok([]), status: "loading" },
});
const order: HomeOrderEntry[] = [{ id: "resume" }, { id: movie, title: "Cinemeta · Top" }];
const stored = (account = "alice") => localStorage.getItem(`${HOME_CACHE_PREFIX}${account}`);
const plant = (items: unknown[]) => {
  localStorage.setItem(`${HOME_CACHE_PREFIX}alice`, JSON.stringify({
    format: HOME_CACHE_FORMAT, order: [{ id: "resume" }], rows: { resume: { items, hasMore: false, partial: false } },
  }));
};

beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); });

describe("home cache", () => {
  it("round-trips the order, rows with cards and answered empty rows, dropping unanswered ones", () => {
    writeHomeCache("alice", order, rows());
    const cached = readHomeCache("alice")!;
    expect(cached.order).toEqual(order);
    expect(cached.rows.resume?.items).toEqual([card]);
    expect(cached.rows[movie]).toMatchObject({ status: "ok", items: [], settled: true });
    expect(cached.rows.recent).toBeUndefined();
    expect(cached.rows.resume).toMatchObject({ status: "ok", request: 0, settled: true });
  });

  it("keeps accounts apart", () => {
    writeHomeCache("alice", order, rows());
    expect(readHomeCache("bob")).toBeNull();
  });

  it("reads a written Home even when the stored payload also carries a version", () => {
    writeHomeCache("alice", order, rows());
    const value = JSON.parse(stored()!);
    expect(value.format).toBe(HOME_CACHE_FORMAT);
    expect(value).not.toHaveProperty("version");
    localStorage.setItem(`${HOME_CACHE_PREFIX}alice`, JSON.stringify({ ...value, version: "0.0.1" }));
    expect(readHomeCache("alice")?.rows.resume?.items).toEqual([card]);
  });

  it("ignores another format", () => {
    writeHomeCache("alice", order, rows());
    const value = JSON.parse(stored()!);
    localStorage.setItem(`${HOME_CACHE_PREFIX}alice`, JSON.stringify({ ...value, format: HOME_CACHE_FORMAT + 1 }));
    expect(readHomeCache("alice")).toBeNull();
  });

  it("ignores an old-style payload with no format", () => {
    localStorage.setItem(`${HOME_CACHE_PREFIX}alice`, JSON.stringify({
      version: "0.0.1", order, rows: { resume: { items: [card], hasMore: false, partial: false } },
    }));
    expect(readHomeCache("alice")).toBeNull();
  });

  it("ignores unreadable JSON and a card without a key", () => {
    localStorage.setItem(`${HOME_CACHE_PREFIX}alice`, "{");
    expect(readHomeCache("alice")).toBeNull();

    localStorage.setItem(`${HOME_CACHE_PREFIX}alice`, JSON.stringify({
      format: HOME_CACHE_FORMAT, order: [{ id: "resume" }], rows: { resume: { items: [{ kind: "resume-file" }], hasMore: false, partial: false } },
    }));
    expect(readHomeCache("alice")).toBeNull();
  });

  it("returns null when a stored card fails validation", () => {
    plant([{ ...card, kind: "unknown" }]);
    expect(readHomeCache("alice")).toBeNull();
    plant([{ ...card, kind: "constructor" }]);
    expect(readHomeCache("alice")).toBeNull();
    plant([{ ...card, poster: { url: "x" } }]);
    expect(readHomeCache("alice")).toBeNull();
    plant([{ ...card, season: "2" }]);
    expect(readHomeCache("alice")).toBeNull();

    const { progress: _progress, ...withoutProgress } = card;
    plant([withoutProgress]);
    expect(readHomeCache("alice")).toBeNull();

    plant([{ ...card, progress: { position: "1", duration: 4 } }]);
    expect(readHomeCache("alice")).toBeNull();

    const episode = samples.find((item) => item.kind === "episode")!;
    const { season: _season, ...withoutSeason } = episode;
    plant([withoutSeason]);
    expect(readHomeCache("alice")).toBeNull();

    const confirm = samples.find((item) => item.kind === "confirm")!;
    const { candidate: _candidate, ...withoutCandidate } = confirm;
    plant([withoutCandidate]);
    expect(readHomeCache("alice")).toBeNull();

    const remote = samples.find((item) => item.kind === "remote")!;
    const { itemId: _itemId, ...withoutItemId } = remote;
    plant([withoutItemId]);
    expect(readHomeCache("alice")).toBeNull();
  });

  it("round-trips one valid card of each kind", () => {
    expect(new Set(samples.map((item) => item.kind)).size).toBe(11);
    for (const item of samples) {
      writeHomeCache("alice", order, rows([item]));
      expect(readHomeCache("alice")?.rows.resume?.items, item.kind).toEqual([item]);
    }
  });

  it("clears every Home entry and leaves the rest", () => {
    writeHomeCache("alice", order, rows());
    writeHomeCache("bob", order, rows());
    localStorage.setItem("player-volume", "0.5");
    clearHomeCache();
    expect(stored("alice")).toBeNull();
    expect(stored("bob")).toBeNull();
    expect(localStorage.getItem("player-volume")).toBe("0.5");
  });

  it("does not write a payload over the limit", () => {
    writeHomeCache("alice", order, rows([{ ...card, title: "x".repeat(HOME_CACHE_MAX_BYTES) } as HomeCard]));
    expect(stored()).toBeNull();
  });
});
