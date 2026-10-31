import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLocale } from "./i18n";
import { clearTitleExtras, setTitleExtrasClock, useTitleExtras } from "./title-extras";
import type { TitleExtras } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const answer = (name: string): TitleExtras => ({
  people: [{ name, role: "cast" }],
  related: [],
  source: "tmdb",
});

let root: Root;
let host: HTMLDivElement;
const calls: string[] = [];
const pending = new Map<string, ReturnType<typeof deferred<Response>>>();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  clearTitleExtras();
  calls.length = 0;
  pending.clear();
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(`${url.pathname}${url.search}`);
    const gate = pending.get(url.pathname);
    if (gate) return gate.promise;
    const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
    return Promise.resolve(json(answer(id)));
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setTitleExtrasClock(() => Date.now());
  setLocale("en");
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });

function Harness({ type, id }: { type?: string; id?: string }) {
  const value = useTitleExtras(type, id);
  return createElement("output", null, JSON.stringify({
    loading: value.loading,
    name: value.extras?.people[0]?.name ?? null,
  }));
}

const output = () => JSON.parse(host.querySelector("output")!.textContent!) as { loading: boolean; name: string | null };

const render = async (type?: string, id?: string) => {
  await act(async () => { root.render(createElement(Harness, { type, id })); });
  await flush();
};

describe("useTitleExtras", () => {
  it("reads a movie once per session and serves the next mount from the cache", async () => {
    await render("movie", "tt1");
    expect(output()).toEqual({ loading: false, name: "tt1" });
    expect(calls).toEqual(["/api/meta/movie/tt1/extras?language=en"]);
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await render("movie", "tt1");
    expect(output()).toEqual({ loading: false, name: "tt1" });
    expect(calls).toEqual(["/api/meta/movie/tt1/extras?language=en"]);
  });

  it("does not cache a failure, so the next mount asks again", async () => {
    const failed: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      failed.push(new URL(String(input), "http://localhost").pathname);
      return Promise.resolve(json({ error: "no" }, 500));
    }));
    await render("series", "tt9");
    expect(output()).toEqual({ loading: false, name: null });
    expect(failed).toEqual(["/api/meta/series/tt9/extras"]);
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    calls.length = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(url.pathname);
      return Promise.resolve(json(answer("Ada")));
    }));
    await render("series", "tt9");
    expect(calls).toEqual(["/api/meta/series/tt9/extras"]);
    expect(output()).toEqual({ loading: false, name: "Ada" });
  });

  it("ignores a reply for a title that is no longer current", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(url.pathname);
      return url.pathname.endsWith("/tt1/extras") ? first.promise : second.promise;
    }));
    await render("movie", "tt1");
    expect(output().loading).toBe(true);
    await render("movie", "tt2");
    await act(async () => { first.resolve(json(answer("Late"))); });
    await flush();
    expect(output()).toEqual({ loading: true, name: null });
    await act(async () => { second.resolve(json(answer("Current"))); });
    await flush();
    expect(output()).toEqual({ loading: false, name: "Current" });
  });

  it("asks nothing for a missing id or a type that is not a movie or a series", async () => {
    await render(undefined, undefined);
    await render("episode", "tt1:1:1");
    await render("movie", "");
    expect(calls).toEqual([]);
    expect(output()).toEqual({ loading: false, name: null });
  });

  it("keeps an addon answer for ten minutes and any other answer for an hour", async () => {
    let clock = 1_000_000;
    setTitleExtrasClock(() => clock);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(`${url.pathname}${url.search}`);
      const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      return Promise.resolve(json({ ...answer(id), source: id === "addon" ? "addon" : "tmdb" }));
    }));
    await render("movie", "addon");
    await render("movie", "catalogue");
    expect(calls).toEqual([
      "/api/meta/movie/addon/extras?language=en",
      "/api/meta/movie/catalogue/extras?language=en",
    ]);

    clock += 10 * 60 * 1000 - 1;
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    calls.length = 0;
    await render("movie", "addon");
    await render("movie", "catalogue");
    expect(calls).toEqual([]);

    clock += 1;
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    calls.length = 0;
    await render("movie", "addon");
    expect(calls).toEqual(["/api/meta/movie/addon/extras?language=en"]);
    calls.length = 0;
    await render("movie", "catalogue");
    expect(calls).toEqual([]);

    clock = 1_000_000 + 60 * 60 * 1000;
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    calls.length = 0;
    await render("movie", "catalogue");
    expect(calls).toEqual(["/api/meta/movie/catalogue/extras?language=en"]);
  });

  it("forgets every language when the cache is cleared", async () => {
    await render("movie", "tt1");
    await act(async () => { setLocale("cs"); });
    await flush();
    await act(async () => { setLocale("en"); });
    await flush();
    expect(calls).toEqual([
      "/api/meta/movie/tt1/extras?language=en",
      "/api/meta/movie/tt1/extras?language=cs",
    ]);
    clearTitleExtras();
    calls.length = 0;
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await render("movie", "tt1");
    await act(async () => { setLocale("cs"); });
    await flush();
    expect(calls).toEqual([
      "/api/meta/movie/tt1/extras?language=en",
      "/api/meta/movie/tt1/extras?language=cs",
    ]);
  });

  it("does not store a reply that arrives after the cache was cleared", async () => {
    const late = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => late.promise));
    await render("movie", "tt1");
    expect(output().loading).toBe(true);
    clearTitleExtras();
    await act(async () => { late.resolve(json(answer("Too late"))); });
    await flush();
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    calls.length = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(`${url.pathname}${url.search}`);
      return Promise.resolve(json(answer("Fresh")));
    }));
    await render("movie", "tt1");
    expect(calls).toEqual(["/api/meta/movie/tt1/extras?language=en"]);
    expect(output()).toEqual({ loading: false, name: "Fresh" });
  });
});
