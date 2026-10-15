import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { NativeAddonSources } from "./NativeAddonSources";
import { useNativeAddonSources, type NativeAddonSourcesState } from "./use-native-addon-sources";
import { setLocale } from "./i18n";
import type { CatalogueRef } from "./title-enrichment";
import type { Stream } from "./types";

const identity: CatalogueRef = { type: "movie", id: "tt5000" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stream = (sourceId: string, name: string, size?: string): Stream =>
  ({ sourceId, kind: "remote", playable: true, addonKey: "a", addonName: "Alpha", name, ...(size ? { title: `💾 ${size}` } : {}) });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

let root: Root;
let host: HTMLDivElement;
let latest: NativeAddonSourcesState | null = null;
let sourceReply: (url: URL, init?: RequestInit) => Response | Promise<Response>;
let streamsReply: (url: URL, init?: RequestInit) => Response | Promise<Response>;
const calls = { sources: [] as URL[], streams: [] as URL[] };
const signals: Array<AbortSignal | null | undefined> = [];

function Harness({ scope, identity: ref }: { scope: string; identity: CatalogueRef | null }) {
  const state = useNativeAddonSources({ scope, identity: ref });
  latest = state;
  return ref ? <NativeAddonSources key={scope} state={state}/> : null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  latest = null;
  calls.sources = []; calls.streams = []; signals.length = 0;
  sourceReply = () => json([{ key: "a", name: "Alpha" }, { key: "b", name: "Beta" }]);
  streamsReply = () => json([stream("s1", "One")]);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    signals.push(init?.signal);
    if (url.pathname.startsWith("/api/stream-sources/")) { calls.sources.push(url); return Promise.resolve(sourceReply(url, init)); }
    if (url.pathname.startsWith("/api/streams/")) { calls.streams.push(url); return Promise.resolve(streamsReply(url, init)); }
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
const renderHarness = async (over: { scope?: string; identity?: CatalogueRef | null } = {}) => {
  await act(async () => root.render(<Harness scope={over.scope ?? "one"} identity={over.identity === undefined ? identity : over.identity}/>));
  await flush();
};
const click = async (element: Element | null) => { await act(async () => { (element as HTMLElement).click(); }); await flush(); };
const toggle = () => host.querySelector<HTMLButtonElement>(".addon-sources-toggle");
const providerButton = (name: string) => {
  const row = [...host.querySelectorAll<HTMLElement>(".addon-provider")].find((node) => node.querySelector(".addon-provider-name")?.textContent === name);
  return row?.querySelector<HTMLButtonElement>("button") ?? null;
};

describe("useNativeAddonSources", () => {
  it("asks nothing until the viewer opens the addon action", async () => {
    await renderHarness();
    expect(calls.sources).toHaveLength(0);
    expect(calls.streams).toHaveLength(0);
    await click(toggle());
    expect(calls.sources).toHaveLength(1);
    expect(calls.sources[0]!.pathname).toBe("/api/stream-sources/movie/tt5000");
    expect(calls.streams).toHaveLength(0);
  });

  it("offers no action and reads nothing for an item it cannot name", async () => {
    await renderHarness({ identity: null });
    expect(toggle()).toBeNull();
    expect(calls.sources).toHaveLength(0);
  });

  it("reads only the provider the viewer chose, never the unfiltered endpoint", async () => {
    await renderHarness();
    await click(toggle());
    expect(host.querySelector(".addon-provider-name")!.textContent).toBe("Alpha");
    expect(calls.streams).toHaveLength(0);
    await click(providerButton("Alpha"));
    expect(calls.streams).toHaveLength(1);
    expect(calls.streams[0]!.searchParams.get("addon")).toBe("a");
    expect(latest!.streams.map((row) => row.sourceId)).toEqual(["s1"]);
  });

  it("deduplicates a repeated press and ranks the answer by the size the addon reported", async () => {
    const held = deferred<Response>();
    streamsReply = () => held.promise;
    await renderHarness();
    await click(toggle());
    act(() => { latest!.load("a"); latest!.load("a"); });
    await flush();
    expect(calls.streams).toHaveLength(1);
    await act(async () => { held.resolve(json([stream("s1", "720p", "1 GB"), stream("s2", "1080p", "3 GB"), stream("s2", "duplicate", "9 GB"), stream("", "unregistered", "90 GB")])); });
    await flush();
    expect(latest!.streams.map((row) => row.sourceId)).toEqual(["s2", "s1"]);
  });

  it("keeps a loaded provider when the panel is closed and reopened without asking again", async () => {
    await renderHarness();
    await click(toggle());
    await click(providerButton("Alpha"));
    expect(calls.streams).toHaveLength(1);
    await click(toggle());
    expect(host.querySelectorAll(".addon-provider")).toHaveLength(0);
    await click(toggle());
    expect(calls.sources).toHaveLength(1);
    expect(calls.streams).toHaveLength(1);
    expect(providerButton("Alpha")).toBeNull();
    expect(latest!.streams.map((row) => row.sourceId)).toEqual(["s1"]);
  });

  it("keeps each provider's own error, retry and empty state", async () => {
    streamsReply = (url) => url.searchParams.get("addon") === "a"
      ? json({ error: "Alpha is down" }, 502)
      : json([]);
    await renderHarness();
    await click(toggle());
    await click(providerButton("Alpha"));
    await click(providerButton("Beta"));
    const alpha = [...host.querySelectorAll<HTMLElement>(".addon-provider")].find((node) => node.textContent?.includes("Alpha"))!;
    const beta = [...host.querySelectorAll<HTMLElement>(".addon-provider")].find((node) => node.textContent?.includes("Beta"))!;
    expect(alpha.textContent).toContain("Alpha is down");
    expect(beta.textContent).toContain("No active source addon has a stream for this title.");
    expect(calls.streams).toHaveLength(2);
    streamsReply = () => json([stream("s9", "Back")]);
    await click(providerButton("Alpha"));
    expect(calls.streams).toHaveLength(3);
    expect(latest!.streams.map((row) => row.sourceId)).toEqual(["s9"]);
  });

  it("shows the empty state when no addon offers the title at all", async () => {
    sourceReply = () => json([]);
    await renderHarness();
    await click(toggle());
    expect(host.textContent).toContain("No addons offer sources for this title.");
    expect(calls.streams).toHaveLength(0);
  });

  it("drops a late answer and aborts the read when the scope changes", async () => {
    const held = deferred<Response>();
    sourceReply = () => held.promise;
    await renderHarness({ scope: "one" });
    await click(toggle());
    await renderHarness({ scope: "two" });
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => { held.resolve(json([{ key: "a", name: "Alpha" }])); });
    await flush();
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelectorAll(".addon-provider")).toHaveLength(0);
  });

  it("aborts a read in flight when the panel unmounts", async () => {
    const held = deferred<Response>();
    streamsReply = () => held.promise;
    await renderHarness();
    await click(toggle());
    await click(providerButton("Alpha"));
    expect(signals.at(-1)!.aborted).toBe(false);
    act(() => root.unmount());
    expect(signals.at(-1)!.aborted).toBe(true);
    root = createRoot(host);
  });

  it("never shows a slow old scope's rows, even when the fetch mock ignores abort", async () => {
    const held = deferred<Response>();
    streamsReply = () => held.promise;
    await renderHarness({ scope: "one" });
    await click(toggle());
    await click(providerButton("Alpha"));
    await renderHarness({ scope: "two" });
    await click(toggle());
    await act(async () => { held.resolve(json([stream("late", "Late")])); });
    await flush();
    expect(latest!.streams).toEqual([]);
    expect(host.querySelectorAll(".addon-provider")).toHaveLength(2);
  });

  it("refuses another scope's rows at render time, before the reset effect runs", async () => {
    await renderHarness({ scope: "one" });
    await click(toggle());
    await click(providerButton("Alpha"));
    expect(latest!.streams.map((row) => row.sourceId)).toEqual(["s1"]);
    act(() => {
      flushSync(() => { root.render(<Harness scope="two" identity={identity}/>); });
      // The render for the new scope answers with nothing already, without waiting for the effect.
      expect(latest!.providers).toBeNull();
      expect(latest!.streams).toEqual([]);
    });
    await flush();
  });

  it("keeps a new scope's provider read when the old one rejects, and still aborts it on unmount", async () => {
    const first = deferred<Response>();
    let reads = 0;
    streamsReply = () => { reads += 1; return reads === 1 ? first.promise : new Promise<Response>(() => {}); };
    await renderHarness({ scope: "one" });
    await click(toggle());
    await click(providerButton("Alpha"));
    await renderHarness({ scope: "two" });
    await click(toggle());
    await click(providerButton("Alpha"));
    const second = signals.at(-1)!;
    expect(second.aborted).toBe(false);
    // The old scope's rejection lands once the new scope's read is already pending: it must not
    // drop the new controller, or nothing would be left to abort on unmount.
    await act(async () => { first.resolve(json({ error: "gone" }, 502)); });
    await flush();
    expect(second.aborted).toBe(false);
    act(() => root.unmount());
    expect(second.aborted).toBe(true);
    root = createRoot(host);
  });
});
