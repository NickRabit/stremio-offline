import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeError, ApiError, api , logDownloadUrl } from "./api";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const optionsOf = (call = 0) => fetchMock.mock.calls[call][1] as RequestInit;

describe("request", () => {
  it("returns the parsed body", async () => {
    fetchMock.mockResolvedValue(json([{ key: "alpha" }]));
    await expect(api.addons()).resolves.toEqual([{ key: "alpha" }]);
  });

  it("sends JSON by default", async () => {
    fetchMock.mockResolvedValue(json({}));
    await api.addAddon("https://addon.example/manifest.json", "both");
    expect(optionsOf().headers).toMatchObject({ "content-type": "application/json" });
    expect(optionsOf().body).toBe(JSON.stringify({ url: "https://addon.example/manifest.json", role: "both" }));
  });

  it("asks the library identity and match endpoints", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({})));
    await api.libraryIdentity("Foo/Bar");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/library/identity?path=Foo%2FBar");
    await api.matchLibraryItem({ path: "Foo", id: "tt1", type: "movie" });
    expect(optionsOf(1).method).toBe("POST");
    expect(optionsOf(1).body).toBe(JSON.stringify({ path: "Foo", id: "tt1", type: "movie" }));
    await api.startLibraryScan();
    expect(String(fetchMock.mock.calls[2][0])).toBe("/api/library/scan");
    expect(optionsOf(2).method).toBe("POST");
  });

  it("does not try to parse an empty response", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.deleteAddon("alpha")).resolves.toBeUndefined();
  });

  it("carries the status and code of a failure up to the caller", async () => {
    fetchMock.mockResolvedValue(json({ error: "Not signed in", code: "AUTH" }, 401));
    const error = await api.addons().catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: "Not signed in", status: 401, code: "AUTH" });
  });

  it("falls back to the status when the body carries no message", async () => {
    fetchMock.mockResolvedValue(new Response("<html>gateway</html>", { status: 502 }));
    await expect(api.addons()).rejects.toMatchObject({ message: "HTTP 502", status: 502, code: undefined });
  });

  it("turns a timeout into a 408, not an abort nobody can read", async () => {
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(api.addons()).rejects.toMatchObject({ status: 408 });
  });

  it("passes a network failure through untouched", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api.addons()).rejects.toThrow(TypeError);
  });

  it("gives every call a deadline", async () => {
    fetchMock.mockResolvedValue(json([]));
    await api.addons();
    expect(optionsOf().signal).toBeInstanceOf(AbortSignal);
  });
});

describe("query building", () => {
  const url = (call = 0) => fetchMock.mock.calls[call][0] as string;
  const catalog = { addonKey: "alpha", addonName: "Alpha", type: "movie", id: "top" };

  it("leaves out the parameters that were not given", async () => {
    fetchMock.mockResolvedValue(json([]));
    await api.catalog(catalog);
    expect(url()).toBe("/api/catalog?addon=alpha&type=movie&id=top");
  });

  it("includes the ones that were", async () => {
    fetchMock.mockResolvedValue(json([]));
    await api.catalog(catalog, "duna", 25, "sci-fi");
    expect(url()).toBe("/api/catalog?addon=alpha&type=movie&id=top&search=duna&skip=25&genre=sci-fi");
  });

  it("escapes identifiers that would otherwise break the path", async () => {
    fetchMock.mockResolvedValue(json({}));
    await api.meta("series", "tt123:1:2", "cs");
    expect(url()).toBe("/api/meta/series/tt123%3A1%3A2?language=cs");
  });

  it("adds the addon filter to streams only when one is picked", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json([])));
    await api.streams("movie", "tt1");
    await api.streams("movie", "tt1", "alpha");
    expect(url(0)).toBe("/api/streams/movie/tt1");
    expect(url(1)).toBe("/api/streams/movie/tt1?addon=alpha");
  });

  it("builds a catalogue-scoped search query", async () => {
    fetchMock.mockResolvedValue(json({ items: [], cursor: "", hasMore: false, sources: 0 }));
    await api.search("dune", { type: "series", cursor: "next", addonKey: "alpha", catalogType: "series", catalogId: "popular:2026" });
    expect(url()).toBe("/api/search?query=dune&type=series&cursor=next&addon=alpha&catalogType=series&catalogId=popular%3A2026");
  });

  it("omits unused search scope parameters", async () => {
    fetchMock.mockResolvedValue(json({ items: [], cursor: "", hasMore: false, sources: 0 }));
    await api.search("dune");
    expect(url()).toBe("/api/search?query=dune");
  });
});

describe("opaque media contracts", () => {
  it("sends only the source ID for inspection and downloads", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({})));
    const stream = { sourceId: "opaque", kind: "remote" as const, playable: true, title: "Movie" };
    await api.inspect(stream);
    await api.download("Movie", stream);
    await api.prepareDeviceDownload({ stream, path: "old-input" });
    expect(JSON.parse(String(optionsOf(0).body))).toEqual({ sourceId: "opaque" });
    expect(JSON.parse(String(optionsOf(1).body))).toEqual({ title: "Movie", sourceId: "opaque" });
    expect(JSON.parse(String(optionsOf(2).body))).toEqual({ sourceId: "opaque" });
  });
});

describe("settings", () => {
  it("sends a Real-Debrid token without putting it on the query string", async () => {
    fetchMock.mockResolvedValue(json({ realDebridConfigured: true }));
    await api.updateSettings({ realDebridToken: "rd-secret" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/settings");
    expect(JSON.parse(String(optionsOf().body))).toEqual({ realDebridToken: "rd-secret" });
  });
});

describe("describeError", () => {
  it("translates a failure the server tagged with a key", async () => {
    fetchMock.mockResolvedValue(json({ error: "The addon was not found.", messageKey: "err.addonNotFound" }, 400));
    const error = await api.addons().catch((value) => value);
    expect(describeError(error)).toBe("The addon was not found.");
  });

  it("translates a restricted-mode 403", async () => {
    fetchMock.mockResolvedValue(json({ error: "This instance is in restricted mode.", messageKey: "err.restricted" }, 403));
    const error = await api.exportSettings().catch((value) => value);
    expect(error).toMatchObject({ status: 403, messageKey: "err.restricted" });
    expect(describeError(error)).toBe("This instance is in restricted mode.");
  });

  it("falls back to the server's own text for a key it does not know", async () => {
    fetchMock.mockResolvedValue(json({ error: "Something new broke.", messageKey: "err.notShippedYet" }, 400));
    const error = await api.addons().catch((value) => value);
    expect(describeError(error)).toBe("Something new broke.");
  });

  it("fills the values the server sent along", async () => {
    fetchMock.mockResolvedValue(json({ error: "Too many failed attempts. Try again in 30 s.", messageKey: "err.tooManyAttempts", vars: { seconds: 30 } }, 429));
    const error = await api.addons().catch((value) => value);
    expect(describeError(error)).toBe("Too many failed attempts. Try again in 30 s.");
  });
});

describe("logDownloadUrl", () => {
  it("downloads the whole log when nothing is filtered", () => {
    expect(logDownloadUrl()).toBe("/api/logs");
    expect(logDownloadUrl({ tail: 0, level: "", hours: 0, search: "" })).toBe("/api/logs");
  });

  it("carries what the viewer is looking at, so the file matches the screen", () => {
    expect(logDownloadUrl({ tail: 500, level: "WARN", hours: 24, search: "seek" }))
      .toBe("/api/logs?tail=500&level=WARN&hours=24&q=seek");
  });

  it("escapes a search that would otherwise break the address", () => {
    expect(logDownloadUrl({ search: "a&b c" })).toBe("/api/logs?q=a%26b%20c");
  });
});
