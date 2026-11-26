import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberedRootCount, rememberedRoots, rememberRoots, resetRememberedRoots } from "./remote-roots-memory";
import type { RemoteLibrary } from "./types";

const library = (id: string): RemoteLibrary => ({
  id,
  connectionId: "connection",
  remoteId: id,
  name: id,
  type: "movie",
  enabled: true,
  order: 0,
  showOnHome: true,
  showInContinueWatching: true,
  provider: "jellyfin",
  capabilities: {
    rename: false,
    move: false,
    delete: false,
    identify: false,
    writeArtwork: false,
    downloadToLibrary: false,
    downloadToDevice: false,
  },
});

beforeEach(() => {
  resetRememberedRoots();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remote roots memory", () => {
  it("uses the in-memory count over the stored count", () => {
    rememberRoots("alice", [library("one"), library("two")]);
    localStorage.setItem("remote-roots:alice", "1");

    expect(rememberedRootCount("alice")).toBe(2);
  });

  it("uses storage when the account has no in-memory list", () => {
    localStorage.setItem("remote-roots:alice", "3");

    expect(rememberedRoots("alice")).toBeNull();
    expect(rememberedRootCount("alice")).toBe(3);
  });

  it("remembers nothing for an unknown account", () => {
    rememberRoots("", [library("one")]);

    expect(rememberedRoots("")).toBeNull();
    expect(rememberedRootCount("")).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("does not write storage when the stored count is unchanged", () => {
    localStorage.setItem("remote-roots:alice", "2");
    const setItem = vi.spyOn(localStorage, "setItem");

    rememberRoots("alice", [library("one"), library("two")]);

    expect(setItem).not.toHaveBeenCalled();
  });

  it("ignores storage failures", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });

    expect(rememberedRootCount("alice")).toBe(0);
    expect(() => rememberRoots("alice", [library("one")])).not.toThrow();
    expect(rememberedRoots("alice")).toHaveLength(1);
  });
});
