import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { catalogueRef, clearTitleEnrichment, loadTitleGallery, useTitleEnrichment, type CatalogueRef, type TitleSource } from "./title-enrichment";
import type { SiteLink, Trailer } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const imdb: SiteLink[] = [{ site: "imdb", url: "https://www.imdb.com/title/tt1" }];
const trailer: Trailer = { youtubeId: "abcdefghijk", provider: "tmdb" };

let root: Root;
let host: HTMLDivElement;
const calls: string[] = [];
let meta: (url: URL) => Response | Promise<Response>;
let links: (url: URL) => Response | Promise<Response>;
let trailerAnswer: (url: URL) => Response | Promise<Response>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearTitleEnrichment();
  calls.length = 0;
  meta = () => json({ id: "x", type: "movie", name: "X", background: "/meta-backdrop.jpg" });
  links = () => json({ links: imdb });
  trailerAnswer = () => json({ trailer });
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url.pathname);
    if (url.pathname.startsWith("/api/meta/")) return Promise.resolve(meta(url));
    if (url.pathname.startsWith("/api/library/links")) return Promise.resolve(links(url));
    if (url.pathname.startsWith("/api/library/trailer")) return Promise.resolve(trailerAnswer(url));
    if (url.pathname.startsWith("/api/links/")) return Promise.resolve(links(url));
    if (url.pathname.startsWith("/api/trailer/")) return Promise.resolve(trailerAnswer(url));
    return Promise.resolve(json({}, 404));
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
const output = () => JSON.parse(host.querySelector("output")!.textContent!) as { links: number; trailer: string | null; background: string | null };

function Harness({ source, metaRef, language }: { source: TitleSource | null; metaRef: CatalogueRef | null; language: string }) {
  const value = useTitleEnrichment(source, metaRef, language);
  return <output>{JSON.stringify({ links: value.links.length, trailer: value.trailer?.youtubeId ?? null, background: (value.meta?.background as string | undefined) ?? null })}</output>;
}

const render = async (props: { source: TitleSource | null; metaRef: CatalogueRef | null; language?: string }) => {
  await act(async () => { root.render(<Harness language="en" {...props}/>); });
  await flush();
};

describe("catalogueRef", () => {
  it("takes a real IMDb id first, for a movie or a series only", () => {
    expect(catalogueRef("movie", { imdb: "tt12345" })).toEqual({ type: "movie", id: "tt12345" });
    expect(catalogueRef("series", { imdb: "tt9", tmdb: "5" })).toEqual({ type: "series", id: "tt9" });
    expect(catalogueRef("episode", { imdb: "tt9" })).toBeNull();
    expect(catalogueRef("season", { imdb: "tt9" })).toBeNull();
  });

  it("falls back to a numeric TMDB id and refuses anything that is not one", () => {
    expect(catalogueRef("movie", { imdb: "ttm1", tmdb: "550" })).toEqual({ type: "movie", id: "tmdb:550" });
    expect(catalogueRef("series", { tmdb: "1399" })).toEqual({ type: "series", id: "tmdb:1399" });
    expect(catalogueRef("movie", { imdb: "123", tmdb: "abc" })).toBeNull();
    expect(catalogueRef("movie", {})).toBeNull();
    expect(catalogueRef("movie", undefined)).toBeNull();
  });
});

describe("useTitleEnrichment", () => {
  it("reads the links, the trailer and the catalogue facts for a local path", async () => {
    await render({ source: { kind: "local", path: "Films/Heat.mkv" }, metaRef: { type: "movie", id: "tt1" } });
    expect(output()).toEqual({ links: 1, trailer: "abcdefghijk", background: "/meta-backdrop.jpg" });
    expect(calls.filter((path) => path === "/api/library/links")).toHaveLength(1);
    expect(calls.filter((path) => path === "/api/library/trailer")).toHaveLength(1);
    expect(calls.filter((path) => path.startsWith("/api/meta/"))).toHaveLength(1);
  });

  it("reads a catalogue identity through api.meta, api.links and api.trailer", async () => {
    await render({ source: { kind: "catalogue", ref: { type: "series", id: "tmdb:1399" } }, metaRef: { type: "series", id: "tmdb:1399" } });
    expect(calls.some((path) => path === "/api/meta/series/tmdb%3A1399")).toBe(true);
    expect(calls.some((path) => path === "/api/links/series/tmdb%3A1399")).toBe(true);
    expect(output().trailer).toBe("abcdefghijk");
  });

  it("asks nothing at all without a title, so a listing row never fetches", async () => {
    await render({ source: null, metaRef: null });
    expect(calls).toEqual([]);
    expect(output()).toEqual({ links: 0, trailer: null, background: null });
  });

  it("reads one title once per session, whatever number of times it is asked for", async () => {
    const source: TitleSource = { kind: "local", path: "Films/Heat.mkv" };
    await render({ source, metaRef: null });
    await render({ source, metaRef: null });
    await render({ source, metaRef: null });
    expect(calls.filter((path) => path === "/api/library/links")).toHaveLength(1);
    expect(calls.filter((path) => path === "/api/library/trailer")).toHaveLength(1);
  });

  it("keeps a best effort outcome: a failed read leaves that part empty", async () => {
    links = () => json({ error: "no" }, 500);
    trailerAnswer = () => json({ error: "no" }, 500);
    await render({ source: { kind: "local", path: "Films/Heat.mkv" }, metaRef: null });
    expect(output()).toEqual({ links: 0, trailer: null, background: null });
  });

  it("shows links while the trailer is still pending", async () => {
    const held = deferred<Response>();
    trailerAnswer = () => held.promise;
    await render({ source: { kind: "local", path: "Heat.mkv" }, metaRef: null });
    expect(output().links).toBe(1);
    expect(output().trailer).toBeNull();
    await act(async () => { held.resolve(json({ trailer })); });
    await flush();
    expect(output().trailer).toBe("abcdefghijk");
  });

  it("drops a late answer for a title the reader already left", async () => {
    const held = deferred<Response>();
    links = (url) => url.searchParams.get("path") === "A.mkv"
      ? held.promise
      : json({ links: [{ site: "imdb", url: "/b1" }, { site: "tmdb", url: "/b2" }] });
    await render({ source: { kind: "local", path: "A.mkv" }, metaRef: null });
    await render({ source: { kind: "local", path: "B.mkv" }, metaRef: null });
    expect(output().links).toBe(2);
    await act(async () => { held.resolve(json({ links: [{ site: "imdb", url: "/a1" }, { site: "imdb", url: "/a2" }, { site: "imdb", url: "/a3" }] })); });
    await flush();
    expect(output().links).toBe(2);
  });
});


describe("loadTitleGallery", () => {
  it("loads alternative pictures only on explicit open and shares the cached request", async () => {
    meta = () => json({ images: [{ url: "/alternate.jpg", shape: "wide", kind: "background" }] });
    expect(calls).toEqual([]);
    const ref: CatalogueRef = { type: "movie", id: "tt1" };
    const [first, second] = await Promise.all([loadTitleGallery(ref, "en"), loadTitleGallery(ref, "en")]);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ url: "/alternate.jpg", kind: "background", shape: "wide" });
    await loadTitleGallery(ref, "en");
    expect(calls).toEqual(["/api/meta/movie/tt1"]);
  });

  it("leaves existing gallery pictures usable when alternative artwork fails", async () => {
    meta = () => json({ error: "Unavailable" }, 503);
    expect(await loadTitleGallery({ type: "movie", id: "tt1" }, "en")).toEqual([]);
  });
});
