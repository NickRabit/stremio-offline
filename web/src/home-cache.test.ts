import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { version } from "../package.json";
import { homeCatalogRowId } from "../../server/src/home";
import type { HomeCard, HomeOrderEntry } from "../../server/src/home";
import type { HomeRows, HomeRowState } from "./home-state";
import { clearHomeCache, HOME_CACHE_MAX_BYTES, HOME_CACHE_PREFIX, readHomeCache, writeHomeCache } from "./home-cache";

const at = "2026-01-01T00:00:00.000Z";
const movie = homeCatalogRowId("cinemeta", "movie", "top");
const card: HomeCard = {
  kind: "resume-file", key: "file:a", title: "A", path: "Films/A.mkv",
  progress: { position: 1, duration: 4 }, updatedAt: at, forgetKeys: ["file:a"],
};
const ok = (items: HomeCard[]): HomeRowState => ({ status: "ok", items, hasMore: false, partial: false, request: 4 });
const rows = (items: HomeCard[] = [card]): HomeRows => ({
  resume: ok(items),
  [movie]: ok([]),
  recent: { ...ok([]), status: "loading" },
});
const order: HomeOrderEntry[] = [{ id: "resume" }, { id: movie, title: "Cinemeta · Top" }];
const stored = (account = "alice") => localStorage.getItem(`${HOME_CACHE_PREFIX}${account}`);

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

  it("ignores another app version", () => {
    writeHomeCache("alice", order, rows());
    const value = JSON.parse(stored()!);
    localStorage.setItem(`${HOME_CACHE_PREFIX}alice`, JSON.stringify({ ...value, version: `${version}-other` }));
    expect(readHomeCache("alice")).toBeNull();
  });

  it("ignores unreadable JSON and a card without a key", () => {
    localStorage.setItem(`${HOME_CACHE_PREFIX}alice`, "{");
    expect(readHomeCache("alice")).toBeNull();

    localStorage.setItem(`${HOME_CACHE_PREFIX}alice`, JSON.stringify({
      version, order: [{ id: "resume" }], rows: { resume: { items: [{ kind: "resume-file" }], hasMore: false, partial: false } },
    }));
    expect(readHomeCache("alice")).toBeNull();
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
