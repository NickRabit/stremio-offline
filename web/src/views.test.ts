import { describe, expect, it } from "vitest";
import { prefsFor, scopeOf, withLibrary } from "./views";
import type { UserViews } from "./types";

const empty = (over: Partial<UserViews> = {}): UserViews =>
  ({ libraries: {}, extras: {}, downloads: { sort: "order", direction: "asc", status: "", dateField: "createdAt", pageSize: 20 }, ...over });

describe("scopeOf", () => {
  it("reads an empty path as the only library there is", () => {
    expect(scopeOf("", ["lib_aaaaaaaa"])).toEqual({ kind: "library", id: "lib_aaaaaaaa" });
  });

  it("reads an empty path with several libraries as the list, which stores nothing", () => {
    expect(scopeOf("", ["lib_aaaaaaaa", "lib_bbbbbbbb"])).toEqual({ kind: "none" });
  });

  it("lets a folder inside a library inherit that library", () => {
    expect(scopeOf("lib_aaaaaaaa/Season 1", ["lib_aaaaaaaa", "lib_bbbbbbbb"])).toEqual({ kind: "library", id: "lib_aaaaaaaa" });
  });

  it("lets a relative folder inherit the only library, the way a single-library install speaks", () => {
    expect(scopeOf("Films", ["lib_aaaaaaaa"])).toEqual({ kind: "library", id: "lib_aaaaaaaa" });
    expect(scopeOf("Films/Heat", ["lib_aaaaaaaa"])).toEqual({ kind: "library", id: "lib_aaaaaaaa" });
  });

  it("does not guess a library from a relative path when several are configured", () => {
    expect(scopeOf("Films", ["lib_aaaaaaaa", "lib_bbbbbbbb"])).toEqual({ kind: "none" });
  });

  it("reads the two extra folders as themselves", () => {
    expect(scopeOf(":resume", ["lib_aaaaaaaa"])).toEqual({ kind: "extra", id: ":resume" });
    expect(scopeOf(":favorites", ["lib_aaaaaaaa"])).toEqual({ kind: "extra", id: ":favorites" });
  });

  it("reads an unknown library id as no bucket when several are configured", () => {
    expect(scopeOf("lib_zzzzzzzz", ["lib_aaaaaaaa", "lib_bbbbbbbb"])).toEqual({ kind: "none" });
  });
});

describe("prefsFor", () => {
  it("defaults the resume folder to the last watched descending", () => {
    expect(prefsFor(empty(), scopeOf(":resume", []))).toMatchObject({ sort: "added", order: "desc" });
  });

  it("defaults a library to the name ascending", () => {
    expect(prefsFor(empty(), scopeOf("lib_aaaaaaaa", []))).toMatchObject({ sort: "name", order: "asc" });
  });

  it("prefers what the scope stored", () => {
    const views = empty({ extras: { ":favorites": { sort: "size", order: "desc", favoritesOnly: false, view: "list" } } });
    expect(prefsFor(views, scopeOf(":favorites", []))).toEqual({ sort: "size", order: "desc", favoritesOnly: false, view: "list" });
  });
});

describe("withLibrary", () => {
  it("does not clone a sibling library's prefs", () => {
    const views = empty({ libraries: { lib_bbbbbbbb: { sort: "added", order: "desc", favoritesOnly: true, view: "list" } } });
    const next = withLibrary(views, "lib_aaaaaaaa", { sort: "size", order: "desc", favoritesOnly: false, view: "grid" });
    expect(next.libraries["lib_bbbbbbbb"]).toBe(views.libraries["lib_bbbbbbbb"]);
    expect(next.libraries["lib_aaaaaaaa"]).toEqual({ sort: "size", order: "desc", favoritesOnly: false, view: "grid" });
  });
});
