import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useLibrarySources, librarySourceEntries, librarySourceRows, librarySourceChoices, ORIGIN_SOURCE, ADDONS_DISCOVERY, LIBRARIES_DISCOVERY, type LibrarySourcesOptions, type LibrarySourcesState, type LibrarySourceGroup } from "./library-sources";
import { setLocale } from "./i18n";
import type { CatalogueRef } from "./title-enrichment";
import type { RemoteLibrary, Stream } from "./types";

const catalogue: CatalogueRef = { type: "movie", id: "tt5000" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stream = (sourceId: string, over: Partial<Stream> = {}): Stream =>
  ({ sourceId, kind: "remote", playable: true, ...over });
const library = (id: string, name: string): RemoteLibrary => ({
  id, connectionId: "c", remoteId: id, name, type: "mixed", enabled: true, order: 0,
  showOnHome: false, showInContinueWatching: false, provider: "jellyfin",
  capabilities: { rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary: false, downloadToDevice: false },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
let providers: Handler;
let addonStreams: Handler;
let localCopies: Handler;
let remoteMatches: Handler;
let librariesReply: Handler;
const calls = { providers: [] as URL[], addon: [] as URL[], local: [] as URL[], remote: [] as URL[], libraries: [] as URL[] };
const seen: Array<{ path: string; signal: AbortSignal | null | undefined }> = [];

let root: Root;
let host: HTMLDivElement;
let latest: LibrarySourcesState | null = null;
const subscriberRoots = new Set<Root>();

function Harness(options: LibrarySourcesOptions) {
  latest = useLibrarySources(options);
  return null;
}

function ObservedHarness({ options: current, record }: {
  options: LibrarySourcesOptions;
  record: (state: LibrarySourcesState) => void;
}) {
  const state = useLibrarySources(current);
  record(state);
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  latest = null;
  calls.providers = []; calls.addon = []; calls.local = []; calls.remote = []; calls.libraries = []; seen.length = 0;
  providers = () => json([{ key: "a", name: "Alpha" }, { key: "b", name: "Beta" }]);
  addonStreams = (url) => json([stream(`addon-${url.searchParams.get("addon")}`)]);
  localCopies = () => json([stream("local-1", { kind: "library", localPath: "Films/One.mkv" })]);
  remoteMatches = (url) => json({ streams: [stream(`other-${url.pathname.split("/")[3]}`)] });
  librariesReply = () => json({ libraries: [library("rlib_a", "Origin"), library("rlib_b", "Second")] });
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    seen.push({ path, signal: init?.signal });
    if (path.startsWith("/api/stream-sources/")) { calls.providers.push(url); return Promise.resolve(providers(url, init)); }
    if (path.startsWith("/api/streams/")) { calls.addon.push(url); return Promise.resolve(addonStreams(url, init)); }
    if (/^\/api\/local-streams\/[^/]+\/[^/]+$/.test(path)) { calls.local.push(url); return Promise.resolve(localCopies(url, init)); }
    if (/^\/api\/remote-libraries\/[^/]+\/streams\/[^/]+\/[^/]+$/.test(path)) { calls.remote.push(url); return Promise.resolve(remoteMatches(url, init)); }
    if (path === "/api/remote-libraries") { calls.libraries.push(url); return Promise.resolve(librariesReply(url, init)); }
    return Promise.resolve(json({}, 404));
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  for (const subscriberRoot of subscriberRoots) act(() => subscriberRoot.unmount());
  subscriberRoots.clear();
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
const options = (over: Partial<LibrarySourcesOptions> = {}): LibrarySourcesOptions =>
  ({ scope: "one", open: false, catalogue, libraries: [library("rlib_a", "Origin"), library("rlib_b", "Second")], originLibraryId: "rlib_a", localCopies: true, ...over });
const render = async (over: Partial<LibrarySourcesOptions> = {}) => {
  await act(async () => { root.render(<Harness {...options(over)}/>); });
  await flush();
};
const mountSubscriber = () => {
  const subscriberHost = document.createElement("div");
  document.body.appendChild(subscriberHost);
  let subscriberRoot: Root | null = createRoot(subscriberHost);
  subscriberRoots.add(subscriberRoot);
  let state: LibrarySourcesState | null = null;
  return {
    latest: () => state,
    render: async (over: Partial<LibrarySourcesOptions> = {}) => {
      if (!subscriberRoot) throw new Error("Subscriber was unmounted");
      await act(async () => {
        subscriberRoot!.render(<ObservedHarness options={options(over)} record={(next) => { state = next; }}/>);
      });
      await flush();
    },
    unmount: () => {
      if (!subscriberRoot) return;
      act(() => subscriberRoot!.unmount());
      subscriberRoots.delete(subscriberRoot);
      subscriberRoot = null;
      subscriberHost.remove();
    },
  };
};
const groupsOf = (kind: LibrarySourceGroup["kind"]) => (latest?.groups ?? []).filter((group) => group.kind === kind);
const ids = (streams: Stream[]) => streams.map((row) => row.sourceId).sort();

describe("useLibrarySources", () => {
  it("reads nothing at all until the chooser opens", async () => {
    await render();
    expect(calls.providers).toHaveLength(0);
    expect(calls.addon).toHaveLength(0);
    expect(calls.local).toHaveLength(0);
    expect(calls.remote).toHaveLength(0);
    await render({ open: true });
    expect(calls.providers).toHaveLength(1);
  });

  it("reads every group at once: each addon by its own key, the viewer's copies, and no origin library", async () => {
    await render({ open: true });
    expect(calls.providers[0]!.pathname).toBe("/api/stream-sources/movie/tt5000");
    expect(calls.addon.map((url) => url.searchParams.get("addon")).sort()).toEqual(["a", "b"]);
    expect(calls.local.map((url) => url.pathname)).toEqual(["/api/local-streams/movie/tt5000"]);
    expect(calls.remote.map((url) => url.pathname)).toEqual(["/api/remote-libraries/rlib_b/streams/movie/tt5000"]);
    expect(ids(latest!.streams)).toEqual(["addon-a", "addon-b", "local-1", "other-rlib_b"]);
    expect(latest!.loading).toBe(false);
  });

  it("asks for one episode through its parent series, with no unfiltered addon call", async () => {
    await render({ open: true, catalogue: { type: "series", id: "tt7000:1:2" }, nameHint: "Show" });
    expect(calls.providers[0]!.pathname).toBe("/api/stream-sources/series/tt7000%3A1%3A2");
    expect(calls.addon.every((url) => url.searchParams.get("addon"))).toBe(true);
    expect(calls.remote[0]!.pathname).toBe("/api/remote-libraries/rlib_b/streams/series/tt7000%3A1%3A2");
    expect(calls.remote[0]!.searchParams.get("name")).toBe("Show");
  });

  it("discovers the libraries once when the caller holds none", async () => {
    await render({ open: true, libraries: null });
    expect(calls.libraries).toHaveLength(1);
    expect(calls.remote.map((url) => url.pathname)).toEqual(["/api/remote-libraries/rlib_b/streams/movie/tt5000"]);
  });

  it("reads the addons and the viewer's own copies while the library discovery is still out", async () => {
    const held = deferred<Response>();
    librariesReply = () => held.promise;
    await render({ open: true, libraries: null });
    // Two addons and the viewer's own copies answer without the library discovery holding them.
    expect(calls.addon.map((url) => url.searchParams.get("addon")).sort()).toEqual(["a", "b"]);
    expect(calls.local.map((url) => url.pathname)).toEqual(["/api/local-streams/movie/tt5000"]);
    expect(ids(latest!.streams)).toEqual(["addon-a", "addon-b", "local-1"]);
    // The lookup is out and says so, so the chooser can show that its libraries are on the way.
    const discovery = latest!.groups.find((group) => group.key === LIBRARIES_DISCOVERY)!;
    expect(discovery.kind).toBe("discovery");
    expect(discovery.status).toBe("loading");
    expect(latest!.loading).toBe(true);
    await act(async () => { held.resolve(json({ libraries: [library("rlib_a", "Origin"), library("rlib_b", "Second")] })); });
    await flush();
    expect(calls.remote.map((url) => url.pathname)).toEqual(["/api/remote-libraries/rlib_b/streams/movie/tt5000"]);
    expect(ids(latest!.streams)).toEqual(["addon-a", "addon-b", "local-1", "other-rlib_b"]);
    expect(latest!.loading).toBe(false);
  });

  it("shows a failed discovery, keeps every answered row, and retries only that lookup", async () => {
    const held = deferred<Response>();
    librariesReply = () => held.promise;
    await render({ open: true, libraries: null });
    // The addons and the viewer's own copies answered while the discovery was still out.
    expect(ids(latest!.streams)).toEqual(["addon-a", "addon-b", "local-1"]);
    await act(async () => { held.resolve(json({ error: "The library list is unavailable" }, 502)); });
    await flush();
    const discovery = latest!.groups.find((group) => group.key === LIBRARIES_DISCOVERY)!;
    expect(discovery.status).toBe("error");
    expect(discovery.error).toContain("The library list is unavailable");
    // The failure takes nothing away from the rows that did answer.
    expect(ids(latest!.streams)).toEqual(["addon-a", "addon-b", "local-1"]);
    expect(latest!.loading).toBe(false);
    librariesReply = () => json({ libraries: [library("rlib_a", "Origin"), library("rlib_b", "Second")] });
    await act(async () => { latest!.retry(LIBRARIES_DISCOVERY); });
    await flush();
    expect(calls.libraries).toHaveLength(2);
    // The groups that already answered are never read a second time.
    expect(calls.addon).toHaveLength(2);
    expect(calls.local).toHaveLength(1);
    expect(latest!.groups.find((group) => group.key === LIBRARIES_DISCOVERY)!.status).toBe("loaded");
    expect(calls.remote.map((url) => url.pathname)).toEqual(["/api/remote-libraries/rlib_b/streams/movie/tt5000"]);
  });

  it("shows a failed addon discovery and asks it again on its own", async () => {
    providers = () => json({ error: "The source list is unavailable" }, 502);
    await render({ open: true });
    const discovery = latest!.groups.find((group) => group.key === ADDONS_DISCOVERY)!;
    expect(discovery.status).toBe("error");
    expect(discovery.error).toContain("The source list is unavailable");
    expect(calls.addon).toHaveLength(0);
    expect(ids(latest!.streams)).toEqual(["local-1", "other-rlib_b"]);
    providers = () => json([{ key: "a", name: "Alpha" }]);
    await act(async () => { latest!.retry(ADDONS_DISCOVERY); });
    await flush();
    expect(calls.providers).toHaveLength(2);
    expect(calls.remote).toHaveLength(1);
    expect(ids(latest!.streams)).toEqual(["addon-a", "local-1", "other-rlib_b"]);
  });

  it("never asks a library the account cannot browse", async () => {
    await render({ open: true, libraries: [library("rlib_a", "Origin"), library("rlib_b", "Second"), { ...library("rlib_c", "Disabled"), enabled: false }] });
    expect(calls.remote.map((url) => url.pathname)).toEqual(["/api/remote-libraries/rlib_b/streams/movie/tt5000"]);
    expect(latest!.groups.some((group) => group.key === "remote:rlib_c")).toBe(false);
  });

  it("ranks the providers by their configured order, not by the order their answers landed", async () => {
    const release: Record<string, () => void> = {};
    addonStreams = (url) => new Promise<Response>((resolve) => {
      const key = url.searchParams.get("addon")!;
      release[key] = () => resolve(json([stream(`addon-${key}`, { addonName: key === "a" ? "Alpha" : "Beta" })]));
    });
    await render({ open: true });
    // Beta answers first; the plan keeps Alpha ahead of it, where the server's own order put it.
    await act(async () => { release.b!(); });
    await flush();
    await act(async () => { release.a!(); });
    await flush();
    const entries = librarySourceEntries([], "Local files", latest!.groups, (group) => group.name);
    const addons = entries.filter((entry) => entry.kind === "addon");
    expect(addons.map((entry) => entry.label)).toEqual(["Alpha", "Beta"]);
    expect(librarySourceRows(addons, "", "", "rule:balanced", "en").map((row) => row.sourceId)).toEqual(["addon-a", "addon-b"]);
    expect(librarySourceRows(addons, "", "", "addon", "en").map((row) => row.sourceId)).toEqual(["addon-a", "addon-b"]);
  });

  it("keeps at most two addon calls and two library matches out at once", async () => {
    const held: Array<() => void> = [];
    let addonLive = 0, addonPeak = 0, remoteLive = 0, remotePeak = 0;
    providers = () => json([{ key: "a", name: "Alpha" }, { key: "b", name: "Beta" }, { key: "c", name: "Gamma" }]);
    addonStreams = () => {
      addonLive += 1; addonPeak = Math.max(addonPeak, addonLive);
      return new Promise<Response>((done) => held.push(() => { addonLive -= 1; done(json([stream("row")])); }));
    };
    remoteMatches = () => {
      remoteLive += 1; remotePeak = Math.max(remotePeak, remoteLive);
      return new Promise<Response>((done) => held.push(() => { remoteLive -= 1; done(json({ streams: [] })); }));
    };
    const many = ["rlib_a", "rlib_b", "rlib_c", "rlib_d"].map((id) => library(id, id));
    await render({ open: true, libraries: many, originLibraryId: "rlib_a" });
    expect(addonPeak).toBeLessThanOrEqual(2);
    expect(remotePeak).toBeLessThanOrEqual(2);
    while (held.length) {
      const release = held.shift()!;
      await act(async () => { release(); });
      await flush();
    }
    expect(calls.addon).toHaveLength(3);
    expect(calls.remote).toHaveLength(3);
  });

  it("lets one failing group fail alone and asks only that one again", async () => {
    addonStreams = (url) => url.searchParams.get("addon") === "a" ? json({ error: "Alpha is down" }, 502) : json([stream("addon-b")]);
    remoteMatches = () => json({ error: "Second is offline" }, 502);
    await render({ open: true });
    const alpha = latest!.groups.find((group) => group.key === "addon:a")!;
    const beta = latest!.groups.find((group) => group.key === "addon:b")!;
    expect(alpha.status).toBe("error");
    expect(alpha.error).toContain("Alpha is down");
    expect(beta.status).toBe("loaded");
    expect(latest!.groups.find((group) => group.key === "remote:rlib_b")!.status).toBe("error");
    expect(latest!.groups.find((group) => group.key === "local")!.status).toBe("loaded");
    expect(latest!.loading).toBe(false);
    addonStreams = () => json([stream("back")]);
    await act(async () => { latest!.retry("addon:a"); });
    await flush();
    expect(latest!.groups.find((group) => group.key === "addon:a")!.streams.map((row) => row.sourceId)).toEqual(["back"]);
    expect(calls.addon.filter((url) => url.searchParams.get("addon") === "a")).toHaveLength(2);
    expect(calls.addon.filter((url) => url.searchParams.get("addon") === "b")).toHaveLength(1);
    expect(calls.remote).toHaveLength(1);
  });

  it("characterizes duplicated request fan-out for two open subscribers of one subject", async () => {
    const providerReplies = [deferred<Response>(), deferred<Response>()];
    let providerReply = 0;
    providers = () => providerReplies[providerReply++]!.promise;
    const first = mountSubscriber();
    const second = mountSubscriber();

    await first.render({ open: true });
    await second.render({ open: true });
    expect(calls.providers).toHaveLength(2);
    expect(calls.addon).toHaveLength(0);
    expect(calls.local).toHaveLength(2);
    expect(calls.remote).toHaveLength(2);
    expect(calls.libraries).toHaveLength(0);

    await act(async () => {
      for (const reply of providerReplies) reply.resolve(json([{ key: "a", name: "Alpha" }, { key: "b", name: "Beta" }]));
    });
    await flush();

    expect(calls.providers.map((url) => url.pathname)).toEqual([
      "/api/stream-sources/movie/tt5000",
      "/api/stream-sources/movie/tt5000",
    ]);
    expect(calls.addon).toHaveLength(4);
    expect(calls.addon.filter((url) => url.searchParams.get("addon") === "a")).toHaveLength(2);
    expect(calls.addon.filter((url) => url.searchParams.get("addon") === "b")).toHaveLength(2);
    expect(calls.local.map((url) => url.pathname)).toEqual([
      "/api/local-streams/movie/tt5000",
      "/api/local-streams/movie/tt5000",
    ]);
    expect(calls.remote.map((url) => url.pathname)).toEqual([
      "/api/remote-libraries/rlib_b/streams/movie/tt5000",
      "/api/remote-libraries/rlib_b/streams/movie/tt5000",
    ]);
    expect(ids(first.latest()!.streams)).toEqual(["addon-a", "addon-b", "local-1", "other-rlib_b"]);
    expect(ids(second.latest()!.streams)).toEqual(["addon-a", "addon-b", "local-1", "other-rlib_b"]);
  });

  it("keeps only the remaining subscriber's addon requests live when one unmounts", async () => {
    const addonReplies: Array<ReturnType<typeof deferred<Response>>> = [];
    addonStreams = () => {
      const reply = deferred<Response>();
      addonReplies.push(reply);
      return reply.promise;
    };
    const first = mountSubscriber();
    const second = mountSubscriber();

    await first.render({ open: true });
    await second.render({ open: true });
    const addonSignals = seen.filter((entry) => entry.path.startsWith("/api/streams/")).map((entry) => entry.signal!);
    expect(calls.addon).toHaveLength(4);
    expect(addonSignals).toHaveLength(4);

    first.unmount();
    expect(addonSignals.slice(0, 2).every((signal) => signal.aborted)).toBe(true);
    expect(addonSignals.slice(2).every((signal) => !signal.aborted)).toBe(true);

    await act(async () => {
      addonReplies[0]!.resolve(json([stream("aborted-a")]));
      addonReplies[1]!.resolve(json([stream("aborted-b")]));
      addonReplies[2]!.resolve(json([stream("remaining-a")]));
      addonReplies[3]!.resolve(json([stream("remaining-b")]));
    });
    await flush();

    expect(ids(second.latest()!.streams)).toEqual(["local-1", "other-rlib_b", "remaining-a", "remaining-b"]);
  });

  it("keeps every answered group when the chooser closes and opens again", async () => {
    await render({ open: true });
    expect(calls.addon).toHaveLength(2);
    await render({ open: false });
    await render({ open: true });
    expect(calls.providers).toHaveLength(1);
    expect(calls.addon).toHaveLength(2);
    expect(calls.local).toHaveLength(1);
    expect(calls.remote).toHaveLength(1);
    expect(ids(latest!.streams)).toEqual(["addon-a", "addon-b", "local-1", "other-rlib_b"]);
  });

  it("aborts every read of the old scope and never lets its late answer land", async () => {
    const held: Array<(response: Response) => void> = [];
    addonStreams = () => new Promise<Response>((done) => held.push(done));
    await render({ open: true });
    const inFlight = seen.filter((entry) => entry.path.startsWith("/api/streams/")).map((entry) => entry.signal!);
    expect(inFlight).toHaveLength(2);
    localCopies = () => json([]);
    remoteMatches = () => json({ streams: [] });
    await render({ open: true, scope: "two", catalogue: { type: "movie", id: "tt6000" } });
    expect(inFlight.every((signal) => signal.aborted)).toBe(true);
    const stale = held.shift()!;
    await act(async () => { stale(json([stream("late")])); });
    await flush();
    // The old scope's answer is dropped even though its fetch ignored the abort.
    expect(latest!.streams).toEqual([]);
    while (held.length) {
      const release = held.shift()!;
      await act(async () => { release(json([])); });
      await flush();
    }
    expect(latest!.streams).toEqual([]);
    expect(calls.addon.filter((url) => url.pathname.includes("tt6000"))).toHaveLength(2);
  });

  it("refuses another scope's rows before the reset effect has run", async () => {
    await render({ open: true });
    expect(ids(latest!.streams)).toEqual(["addon-a", "addon-b", "local-1", "other-rlib_b"]);
    act(() => {
      flushSync(() => { root.render(<Harness {...options({ open: true, scope: "two" })}/>); });
      expect(latest!.groups).toEqual([]);
      expect(latest!.streams).toEqual([]);
    });
    await flush();
  });

  it("aborts every read in flight when the detail unmounts", async () => {
    const held = deferred<Response>();
    addonStreams = () => held.promise;
    await render({ open: true });
    const inFlight = seen.filter((entry) => entry.path.startsWith("/api/streams/")).map((entry) => entry.signal!);
    expect(inFlight.length).toBe(2);
    act(() => root.unmount());
    expect(inFlight.every((signal) => signal.aborted)).toBe(true);
    root = createRoot(host);
  });

  it("asks no library at all when the title has no catalogue identity", async () => {
    await render({ open: true, catalogue: null });
    expect(calls.providers).toHaveLength(0);
    expect(calls.local).toHaveLength(0);
    expect(calls.remote).toHaveLength(0);
  });
});

describe("librarySourceRows", () => {
  const remote = (id: string, size: number) => stream(id, { provider: "jellyfin", libraryId: "l", behaviorHints: { videoSize: size } });
  const addon = (id: string, size: number) => stream(id, { addonKey: "a", addonName: "Alpha", title: `💾 ${size} GB` });
  const entries = librarySourceEntries([remote("native", 1_000_000_000)], "Local files", [
    { key: "local", kind: "local", name: "", status: "loaded", streams: [stream("copy", { kind: "library", localPath: "p", behaviorHints: { videoSize: 9_000_000_000 } })], error: "" },
    { key: "remote:l2", kind: "remote", name: "Second", provider: "emby", status: "loaded", streams: [remote("other", 4_000_000_000)], error: "" },
    { key: "addon:a", kind: "addon", name: "Alpha", status: "loaded", streams: [addon("add", 20)], error: "" },
    { key: "addon:b", kind: "addon", name: "Beta", status: "idle", streams: [], error: "" },
  ], (group) => group.name || "Local files");

  it("leads with the detail's own rows and keeps each class in its own order", () => {
    expect(librarySourceRows(entries, "", "", "rule:balanced", "en").map((row) => row.sourceId))
      .toEqual(["native", "copy", "other", "add"]);
  });

  it("keeps native and local rows first while interleaving remote and addon rows by rule rank", () => {
    const ranked = librarySourceEntries([remote("native", 1)], "Local files", [
      { key: "local", kind: "local", name: "", status: "loaded", streams: [stream("copy", { kind: "library", localPath: "p", rules: { balanced: { profileId: "balanced", status: "breaks", reasons: ["size"], rank: [0, 2, 0] } } })], error: "" },
      { key: "remote:l2", kind: "remote", name: "Second", provider: "emby", status: "loaded", streams: [stream("remote-mid", { provider: "jellyfin", rules: { balanced: { profileId: "balanced", status: "meets", reasons: [], rank: [1, 0, 1] } } })], error: "" },
      { key: "addon:a", kind: "addon", name: "Alpha", status: "loaded", streams: [
        stream("addon-last", { addonName: "Alpha", rules: { balanced: { profileId: "balanced", status: "breaks", reasons: ["language"], rank: [1, 2, 0] } } }),
        stream("addon-best", { addonName: "Alpha", rules: { balanced: { profileId: "balanced", status: "meets", reasons: [], rank: [1, 0, 0] } } }),
      ], error: "" },
    ], (group) => group.name || "Local files");
    expect(librarySourceRows(ranked, "", "", "rule:balanced", "en").map((row) => row.sourceId))
      .toEqual(["native", "copy", "addon-best", "remote-mid", "addon-last"]);
    expect(librarySourceRows(entries, "", "", "rule:balanced", "en").map((row) => row.sourceId))
      .toEqual(["native", "copy", "other", "add"]);
  });

  it("keeps native rows first but lets an explicit rule move a local copy last", () => {
    const ranked = librarySourceEntries([remote("native", 1_000_000_000)], "Local files", [
      { key: "local", kind: "local", name: "", status: "loaded", streams: [stream("copy", { kind: "library", localPath: "p", rules: { balanced: { profileId: "balanced", status: "meets", reasons: [], rank: [0, 0, 2] } } })], error: "" },
      { key: "addon:a", kind: "addon", name: "Alpha", status: "loaded", streams: [stream("addon", { addonName: "Alpha", rules: { balanced: { profileId: "balanced", status: "meets", reasons: [], rank: [0, 0, 0] } } })], error: "" },
      { key: "remote:l2", kind: "remote", name: "Second", provider: "emby", status: "loaded", streams: [stream("remote", { provider: "jellyfin", rules: { balanced: { profileId: "balanced", status: "meets", reasons: [], rank: [0, 0, 1] } } })], error: "" },
    ], (group) => group.name || "Local files");
    expect(librarySourceRows(ranked, "", "", "rule:balanced", "en").map((row) => row.sourceId))
      .toEqual(["native", "addon", "remote", "copy"]);
  });

  it("isolates one class, and the class still out contributes nothing yet", () => {
    expect(librarySourceRows(entries, "addon:b", "", "rule:balanced", "en")).toEqual([]);
    expect(librarySourceRows(entries, "remote:l2", "", "rule:balanced", "en").map((row) => row.sourceId)).toEqual(["other"]);
  });

  it("ranks every class together for a named size sort", () => {
    expect(librarySourceRows(entries, "", "", "size-desc", "en").map((row) => row.sourceId))
      .toEqual(["add", "copy", "other", "native"]);
  });

  it("counts what each menu option holds, applying the other filter", () => {
    const choices = librarySourceChoices(entries, "", "", undefined);
    expect(choices.total).toBe(4);
    // The detail's own rows lead the menu, exactly as they lead the list.
    expect(choices.options.map((option) => option.value)).toEqual([ORIGIN_SOURCE, "local", "remote:l2", "addon:a"]);
    expect(choices.options[0]!.label).toBe("Local files");
    // The source menu names every class the language filter leaves, whatever has been picked;
    // only the language menu is counted over the picked source.
    const picked = librarySourceChoices(entries, "addon:a", "", undefined);
    expect(picked.total).toBe(4);
    expect(picked.options.map((option) => option.value)).toEqual([ORIGIN_SOURCE, "local", "remote:l2", "addon:a"]);
    expect(picked.languageTotal).toBe(1);
  });

  it("cross-counts a language picked beside a source and a source picked beside a language", () => {
    const english = (id: string, over: Partial<Stream> = {}) => stream(id, { title: "1080p", ...over });
    const czech = (id: string, over: Partial<Stream> = {}) => stream(id, { title: "1080p CZ dabing", ...over });
    const crossed = librarySourceEntries([english("native-en", { title: "BluRay en" }), czech("native-cs", { title: "CZ dabing 4K" })], "Local files", [
      { key: "addon:a", kind: "addon", name: "Alpha", status: "loaded", streams: [english("alpha-en")], error: "" },
      { key: "addon:b", kind: "addon", name: "Beta", status: "loaded", streams: [czech("beta-cs")], error: "" },
    ], (group) => group.name || "Local files");
    // A picked source leaves every other source in the menu: it hides no choice.
    const bySource = librarySourceChoices(crossed, "addon:b", "", undefined);
    expect(bySource.options.map((option) => option.value)).toEqual([ORIGIN_SOURCE, "addon:a", "addon:b"]);
    expect(bySource.total).toBe(4);
    expect(bySource.languageTotal).toBe(1);
    // A picked language counts the "all sources" option over what is left, and the language menu
    // over the picked source alone.
    const byLanguage = librarySourceChoices(crossed, "", "cs", undefined);
    expect(byLanguage.total).toBe(2);
    expect(byLanguage.options.map((option) => option.value)).toEqual([ORIGIN_SOURCE, "addon:b"]);
    const both = librarySourceChoices(crossed, "addon:b", "cs", undefined);
    expect(both.total).toBe(2);
    expect(both.languageTotal).toBe(1);
    expect(both.languages).toEqual([{ value: "cs", label: "cs", count: 1 }]);
  });

  it("keeps the picked source in the menu when the language filter left it no row", () => {
    const english = (id: string) => stream(id, { title: "1080p English" });
    const czech = (id: string) => stream(id, { title: "1080p CZ dabing" });
    const entries = librarySourceEntries([czech("native-cs")], "Local files", [
      { key: "addon:a", kind: "addon", name: "Alpha", status: "loaded", streams: [czech("alpha-cs")], error: "" },
      { key: "addon:b", kind: "addon", name: "Beta", status: "loaded", streams: [english("beta-en")], error: "" },
    ], (group) => group.name || "Local files");
    const choices = librarySourceChoices(entries, "addon:b", "cs", undefined);
    // Beta holds no Czech row, so it drops out of the language-filtered list; the menu still names
    // the value it holds, or the browser would show "All sources" while the list stays filtered.
    expect(choices.options).toEqual([
      { value: ORIGIN_SOURCE, label: "Local files", count: 1 },
      { value: "addon:a", label: "Alpha", count: 1 },
      { value: "addon:b", label: "Beta", count: 0 },
    ]);
    // The picked source itself still holds its English row; the language menu counts that, while
    // the list beside the source menu is empty.
    expect(choices.languageTotal).toBe(1);
    expect(librarySourceRows(entries, "addon:b", "cs", "rule:balanced", "en")).toEqual([]);
  });

  it("keeps the configured provider order in the rule and by-addon sorts", () => {
    const provider = (key: string, name: string, id: string, size: number) =>
      ({ key, kind: "addon" as const, name, status: "loaded" as const, streams: [stream(id, { addonKey: key, addonName: name, title: `💾 ${size} GB` })], error: "" });
    const ordered = librarySourceEntries([], "Local files", [provider("a", "Alpha", "alpha", 1), provider("b", "Beta", "beta", 5)], (group) => group.name || "Local files");
    // Beta's copy is larger, and Alpha is still first: the plan's order, not the sizes, ranks them.
    expect(librarySourceRows(ordered, "", "", "rule:balanced", "en").map((row) => row.sourceId)).toEqual(["alpha", "beta"]);
    expect(librarySourceRows(ordered, "", "", "addon", "en").map((row) => row.sourceId)).toEqual(["alpha", "beta"]);
    // An explicit map still wins, and a size sort still ranks by size.
    expect(librarySourceRows(ordered, "", "", "rule:balanced", "en", undefined, new Map([["Beta", 0], ["Alpha", 1]])).map((row) => row.sourceId)).toEqual(["beta", "alpha"]);
    expect(librarySourceRows(ordered, "", "", "size-desc", "en").map((row) => row.sourceId)).toEqual(["beta", "alpha"]);
  });
});
