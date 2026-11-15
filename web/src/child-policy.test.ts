import { afterEach, describe, expect, it } from "vitest";
import type { View } from "./App";
import { childRefuses, childSession, childViewAllowed, setChildSession } from "./child-policy";

afterEach(() => setChildSession(null));

const alwaysRefused = [
  ["GET", "/api/downloads"],
  ["POST", "/api/downloads"],
  ["POST", "/api/downloads/bulk/prepare"],
  ["DELETE", "/api/downloads/job-1"],
  ["POST", "/api/device-download"],
  ["GET", "/api/device-download/ticket"],
  ["GET", "/api/library/folders"],
  ["GET", "/api/links/movie/tt1"],
  ["GET", "/api/library/links"],
  ["GET", "/api/trailer/movie/tt1"],
  ["GET", "/api/library/trailer"],
  ["GET", "/api/meta/movie/tt1/extras"],
  ["GET", "/api/person/123"],
  ["GET", "/api/follows/calendar-feed"],
  ["POST", "/api/follows/calendar-feed"],
  ["POST", "/api/follows/f-1/episodes/1%3A1/skip"],
  ["POST", "/api/follows/f-1/episodes/1%3A1/retry"],
  ["PATCH", "/api/settings"],
  ["PATCH", "/api/search/preferences"],
  ["PUT", "/api/follows/defaults"],
  ["PATCH", "/api/auth/password"],
  ["PATCH", "/api/auth/pin"],
  ["PUT", "/api/addons/order"],
  ["POST", "/api/auth/pair/inspect"],
  ["POST", "/api/auth/pair/approve"],
  ["POST", "/api/auth/pair/deny"],
] as const;

const catalogueOnly = [
  ["GET", "/api/catalogs"],
  ["GET", "/api/catalog"],
  ["GET", "/api/search"],
  ["GET", "/api/searchable"],
  ["POST", "/api/search/catalog"],
  ["DELETE", "/api/search/catalog/session-1"],
  ["GET", "/api/meta/movie/tt1"],
  ["GET", "/api/stream-sources/movie/tt1"],
  ["GET", "/api/streams/movie/tt1"],
  ["GET", "/api/subtitles/movie/tt1"],
  ["GET", "/api/addons"],
  ["GET", "/api/watchlist"],
  ["POST", "/api/watchlist"],
  ["GET", "/api/source-profiles"],
  ["GET", "/api/follows"],
  ["POST", "/api/follows"],
  ["GET", "/api/follows/new-episodes"],
] as const;

const allowed = [
  ["GET", "/api/subtitle/x"],
  ["POST", "/api/playback/a/seek"],
  ["POST", "/api/library/favorite"],
  ["DELETE", "/api/device-transfers"],
  ["GET", "/api/progress"],
  ["GET", "/api/home"],
  ["GET", "/api/library"],
  ["GET", "/api/local-streams/movie/tt1"],
] as const;

describe("childRefuses", () => {
  it.each(alwaysRefused)("refuses %s %s with and without catalogue browsing", (method, path) => {
    expect(childRefuses(method, path, false)).toBe(true);
    expect(childRefuses(method, path, true)).toBe(true);
  });

  it.each(catalogueOnly)("refuses %s %s only without catalogue browsing", (method, path) => {
    expect(childRefuses(method, path, false)).toBe(true);
    expect(childRefuses(method, path, true)).toBe(false);
  });

  it.each(allowed)("leaves %s %s to the server", (method, path) => {
    expect(childRefuses(method, path, false)).toBe(false);
    expect(childRefuses(method, path, true)).toBe(false);
  });

  it("distinguishes the singular subtitle route from the addon subtitle list", () => {
    expect(childRefuses("GET", "/api/subtitle/x", false)).toBe(false);
    expect(childRefuses("GET", "/api/subtitles/movie/tt1", false)).toBe(true);
  });
});

describe("childViewAllowed", () => {
  const allowedViews: View[] = ["home", "library", "search"];
  const catalogueView: View[] = ["catalog"];
  const refusedViews: View[] = ["resume", "favorites", "following", "downloads", "stats", "addons", "settings"];

  it("allows the three always-available views in both catalogue states", () => {
    for (const view of allowedViews) {
      expect(childViewAllowed(view, false)).toBe(true);
      expect(childViewAllowed(view, true)).toBe(true);
    }
  });

  it("allows only the catalogue view behind the catalogue flag", () => {
    for (const view of catalogueView) {
      expect(childViewAllowed(view, false)).toBe(false);
      expect(childViewAllowed(view, true)).toBe(true);
    }
  });

  it("refuses every other view in both catalogue states", () => {
    for (const view of refusedViews) {
      expect(childViewAllowed(view, false)).toBe(false);
      expect(childViewAllowed(view, true)).toBe(false);
    }
  });
});

describe("childSession", () => {
  it("stores and clears the session the request layer reads", () => {
    setChildSession({ child: true, catalogue: true });
    expect(childSession()).toEqual({ child: true, catalogue: true });
    setChildSession(null);
    expect(childSession()).toBeNull();
  });
});
