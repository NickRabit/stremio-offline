import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, ApiError } from "./api";
import { setLocale } from "./i18n";
import type { SearchClusterView, SearchSnapshot, SearchSourceClass, SearchStartBody } from "./types";
import { useSearchEverywhere, type SearchEverywhereController } from "./useSearchEverywhere";

const cluster = (key: string, over: Partial<SearchClusterView> = {}): SearchClusterView => ({
  key,
  kind: "movie",
  title: key.toUpperCase(),
  sourceLabels: ["Source"],
  hasLocal: false,
  hasRemote: false,
  memberCount: 1,
  primaryMemberKey: `member-${key}`,
  memberKeys: [`member-${key}`],
  rank: 1,
  score: 1,
  ...over,
});

const snapshot = (over: Partial<SearchSnapshot> = {}): SearchSnapshot => ({
  revision: 1,
  state: "partial",
  sources: [{
    id: "catalog-one",
    sourceClass: "catalog",
    label: "Catalog one",
    state: "loading",
    loaded: 0,
    hasMore: true,
    continuation: "supported",
    retryable: false,
  }],
  clusters: [],
  unidentified: [],
  aliases: [],
  limitReached: false,
  ...over,
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const advance = async (milliseconds: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
};

let root: Root;
let host: HTMLDivElement;
let current: SearchEverywhereController;
let options: { active: boolean; covered: boolean };

function Harness() {
  current = useSearchEverywhere(options);
  return null;
}

const render = async (active = true, covered = false) => {
  options = { active, covered };
  await act(async () => { root.render(createElement(Harness)); });
  await flush();
};

const rerender = async (active: boolean, covered = false) => {
  options = { active, covered };
  await act(async () => { root.render(createElement(Harness)); });
  await flush();
};

const submit = async (query: string) => {
  await act(async () => {
    current.setDraft(query);
    current.submit();
  });
  await flush();
};

const visibility = (value: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
};

const startBodies = () => (api.searchEverywhereStart as ReturnType<typeof vi.fn>).mock.calls.map(([body]) => body as SearchStartBody);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.spyOn(api, "searchPreferences").mockResolvedValue({ liveSearch: false });
  vi.spyOn(api, "searchEverywhereDelete").mockReturnValue(undefined);
  vi.spyOn(api, "searchEverywherePage").mockResolvedValue({ revision: 1 });
  vi.spyOn(api, "searchEverywhereRetry").mockResolvedValue({ revision: 1 });
  vi.spyOn(api, "searchState").mockResolvedValue({
    saveHistory: true,
    liveSearch: true,
    defaultOrder: "source",
    recent: [],
  });
  vi.spyOn(api, "recordSearch").mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  visibility("visible");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useSearchEverywhere", () => {
  it("a library chip searches only its source and stays gone once cleared", async () => {
    vi.spyOn(api, "searchEverywhereStart").mockResolvedValue({
      id: "session-chip",
      snapshot: snapshot({ revision: 1, state: "complete" }),
    });
    await render();
    await act(async () => {
      current.applyPreset({
        sources: ["local", "remote"],
        library: {
          scope: { libraryId: "lib_ab12cd34", path: "Shows" },
          source: "local",
          title: "Films – Shows",
        },
      });
    });
    expect(current.committed).toBe("");
    expect(current.sources).toEqual(["local", "remote"]);
    expect(current.library).toEqual({
      scope: { libraryId: "lib_ab12cd34", path: "Shows" },
      source: "local",
      title: "Films – Shows",
    });

    await submit("alpha");
    const scoped = startBodies().at(-1)!;
    expect(scoped.sources).toEqual(["local"]);
    expect(scoped.library).toEqual({ libraryId: "lib_ab12cd34", path: "Shows" });
    expect(scoped.scope).toBeUndefined();

    await act(async () => { current.clearLibrary(); });
    await flush();
    expect(current.library).toBeNull();
    const cleared = startBodies().at(-1)!;
    expect(cleared.sources).toEqual(["local", "remote"]);
    expect(cleared.library).toBeUndefined();

    await act(async () => { current.setSources(["catalog"]); });
    await flush();
    await act(async () => { current.setSources(["remote", "local"]); });
    await flush();
    expect(current.library).toBeNull();
    const restored = startBodies().at(-1)!;
    expect(restored.library).toBeUndefined();
    expect(restored.sources).toEqual(["remote", "local"]);

    await act(async () => {
      current.applyPreset({
        sources: ["local", "remote"],
        library: {
          scope: { libraryId: "rlib_a", parentId: "f1" },
          source: "remote",
          title: "Server – Shows",
        },
      });
    });
    await submit("beta");
    await act(async () => { current.setScope({ addonKey: "cinemeta" }); });
    await flush();
    expect(current.library).toBeNull();
    expect(current.sources).toEqual(["catalog"]);
    const scopedAway = startBodies().at(-1)!;
    expect(scopedAway.library).toBeUndefined();
    expect(scopedAway.scope).toEqual({ addonKey: "cinemeta" });
    expect(scopedAway.sources).toEqual(["catalog"]);
  });

  it("drops a late start response from an older query", async () => {
    let resolveFirst!: (answer: { id: string; snapshot: SearchSnapshot }) => void;
    let resolveSecond!: (answer: { id: string; snapshot: SearchSnapshot }) => void;
    vi.spyOn(api, "searchEverywhereStart").mockImplementation((body) => new Promise((resolve) => {
      if (body.query === "alpha") resolveFirst = resolve;
      else resolveSecond = resolve;
    }));

    await render();
    await submit("alpha");
    await submit("beta");

    await act(async () => {
      resolveSecond({ id: "session-beta", snapshot: snapshot({ revision: 4, clusters: [cluster("beta")] }) });
    });
    await flush();
    await act(async () => {
      resolveFirst({ id: "session-alpha", snapshot: snapshot({ revision: 9, clusters: [cluster("alpha")] }) });
    });
    await flush();

    expect(current.committed).toBe("beta");
    expect(current.snapshot?.clusters.map((item) => item.key)).toEqual(["beta"]);
    expect(startBodies().map((body) => body.query)).toEqual(["alpha", "beta"]);
    expect(startBodies()[0]!.sources).toEqual(["catalog", "local", "remote"]);
  });

  it("waits 250 ms after a partial snapshot and one second after a complete one", async () => {
    vi.spyOn(api, "searchEverywhereStart").mockResolvedValue({
      id: "session-one",
      snapshot: snapshot({ revision: 1, state: "partial" }),
    });
    const poll = vi.spyOn(api, "searchEverywherePoll").mockResolvedValue({ changed: false, revision: 1 });

    await render();
    await submit("alpha");
    await advance(0);
    expect(poll).toHaveBeenCalledTimes(1);

    await advance(249);
    expect(poll).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(poll).toHaveBeenCalledTimes(2);

    poll.mockResolvedValueOnce({
      changed: true,
      snapshot: snapshot({ revision: 2, state: "complete" }),
    });
    await advance(250);
    expect(poll).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(poll).toHaveBeenCalledTimes(4);
    await advance(999);
    expect(poll).toHaveBeenCalledTimes(4);
    await advance(1);
    expect(poll).toHaveBeenCalledTimes(5);
  });

  it("stops polling while the document is hidden and resumes when it returns", async () => {
    vi.spyOn(api, "searchEverywhereStart").mockResolvedValue({
      id: "session-one",
      snapshot: snapshot({ revision: 1 }),
    });
    const poll = vi.spyOn(api, "searchEverywherePoll").mockResolvedValue({ changed: false, revision: 1 });

    await render();
    await submit("alpha");
    await advance(0);
    expect(poll).toHaveBeenCalledTimes(1);

    visibility("hidden");
    await advance(5_000);
    expect(poll).toHaveBeenCalledTimes(1);

    visibility("visible");
    await advance(0);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("pauses polling while a detail covers Search", async () => {
    vi.spyOn(api, "searchEverywhereStart").mockResolvedValue({
      id: "session-one",
      snapshot: snapshot({ revision: 1 }),
    });
    const poll = vi.spyOn(api, "searchEverywherePoll").mockResolvedValue({ changed: false, revision: 1 });

    await render();
    await submit("alpha");
    await advance(0);
    expect(poll).toHaveBeenCalledTimes(1);

    await rerender(true, true);
    await advance(5_000);
    expect(poll).toHaveBeenCalledTimes(1);

    await rerender(true, false);
    await advance(0);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("restarts once after 410 and then shows the fixed expiry error", async () => {
    vi.spyOn(api, "searchEverywhereStart")
      .mockResolvedValueOnce({ id: "session-one", snapshot: snapshot({ revision: 1 }) })
      .mockResolvedValueOnce({ id: "session-two", snapshot: snapshot({ revision: 1 }) });
    vi.spyOn(api, "searchEverywherePoll")
      .mockRejectedValueOnce(new ApiError("expired", 410, "search-restart-required", "err.searchRestartRequired"))
      .mockRejectedValueOnce(new ApiError("expired", 410, "search-restart-required", "err.searchRestartRequired"));

    await render();
    await submit("alpha");
    await advance(1);
    await flush();
    await advance(1);
    await flush();
    await advance(1);
    await flush();

    expect(api.searchEverywhereStart).toHaveBeenCalledTimes(2);
    expect(startBodies().map((body) => body.query)).toEqual(["alpha", "alpha"]);
    expect(api.searchEverywherePoll).toHaveBeenCalledTimes(2);
    expect(current.error).toBe("The search expired. Search again.");
  });

  it("keeps the results on screen while an expired search starts again, then swaps them at once", async () => {
    // A title played from Search can outlast the idle expiry. The restarted session answers in
    // pieces; drawing the first piece would shorten the page and drop the reader to the top.
    const full = ["a", "b", "c"].map((key) => cluster(key));
    vi.spyOn(api, "searchEverywhereStart")
      .mockResolvedValueOnce({ id: "session-one", snapshot: snapshot({ revision: 1, state: "complete", clusters: full }) })
      .mockResolvedValueOnce({ id: "session-two", snapshot: snapshot({ revision: 1, state: "partial", clusters: [cluster("x")] }) });
    let finish!: () => void;
    vi.spyOn(api, "searchEverywherePoll")
      .mockRejectedValueOnce(new ApiError("expired", 410, "search-restart-required", "err.searchRestartRequired"))
      .mockImplementationOnce(() => new Promise((resolve) => {
        finish = () => resolve({ changed: true, snapshot: snapshot({ revision: 2, state: "complete", clusters: ["x", "y", "z"].map((key) => cluster(key)) }) });
      }));

    await render();
    await submit("alpha");
    act(() => current.markInteracted());
    await advance(1000);
    await flush();
    await advance(1);
    await flush();

    expect(api.searchEverywhereStart).toHaveBeenCalledTimes(2);
    expect(api.searchEverywherePoll).toHaveBeenCalledTimes(2);
    expect(current.snapshot?.clusters.map((item) => item.key)).toEqual(["a", "b", "c"]);
    expect(current.order).toEqual(["a", "b", "c"]);
    // The same query is starting again, not another one: nothing is labelled as earlier results.
    expect(current.previousQuery).toBe(false);

    await act(async () => { finish(); });
    await flush();
    expect(current.snapshot?.clusters.map((item) => item.key)).toEqual(["x", "y", "z"]);
    expect(current.order).toEqual(["x", "y", "z"]);
    expect(current.error).toBeNull();
  });

  it("keeps retired aliases in place, appends new cards and drops removed ones", async () => {
    vi.spyOn(api, "searchEverywhereStart").mockResolvedValue({
      id: "session-one",
      snapshot: snapshot({
        revision: 1,
        clusters: [cluster("a"), cluster("b"), cluster("c")],
        unidentified: [cluster("x"), cluster("y")],
      }),
    });
    vi.spyOn(api, "searchEverywherePoll").mockResolvedValue({
      changed: true,
      snapshot: snapshot({
        revision: 2,
        clusters: [cluster("d"), cluster("a"), cluster("z")],
        unidentified: [cluster("y"), cluster("q")],
        aliases: [
          { retired: "b", current: "z" },
          { retired: "x", current: "q" },
        ],
      }),
    });

    await render();
    await submit("alpha");
    expect(current.order).toEqual(["a", "b", "c"]);
    expect(current.unidentifiedOrder).toEqual(["x", "y"]);
    current.markInteracted();
    await advance(0);
    await flush();

    expect(current.order).toEqual(["a", "z", "d"]);
    expect(current.unidentifiedOrder).toEqual(["q", "y"]);
  });

  it("adopts each server order until interaction, then keeps cards stable", async () => {
    vi.spyOn(api, "searchEverywhereStart").mockResolvedValue({
      id: "session-one",
      snapshot: snapshot({ revision: 1, clusters: [cluster("a"), cluster("b")] }),
    });
    vi.spyOn(api, "searchEverywherePoll")
      .mockResolvedValueOnce({
        changed: true,
        snapshot: snapshot({ revision: 2, clusters: [cluster("b"), cluster("a")] }),
      })
      .mockResolvedValueOnce({
        changed: true,
        snapshot: snapshot({ revision: 3, clusters: [cluster("c"), cluster("b"), cluster("a")] }),
      });

    await render();
    await submit("alpha");
    expect(current.order).toEqual(["a", "b"]);
    await advance(0);
    await flush();
    expect(current.order).toEqual(["b", "a"]);

    current.markInteracted();
    await advance(250);
    await flush();
    expect(current.order).toEqual(["b", "a", "c"]);
  });

  it("resets relevance adoption for a new query", async () => {
    vi.spyOn(api, "searchEverywhereStart")
      .mockResolvedValueOnce({
        id: "session-one",
        snapshot: snapshot({ revision: 1, clusters: [cluster("a"), cluster("b")] }),
      })
      .mockResolvedValueOnce({
        id: "session-two",
        snapshot: snapshot({ revision: 1, clusters: [cluster("d"), cluster("c")] }),
      });
    vi.spyOn(api, "searchEverywherePoll").mockResolvedValue({ changed: false, revision: 1 });

    await render();
    await submit("alpha");
    current.markInteracted();
    await submit("beta");
    expect(current.order).toEqual(["d", "c"]);
  });

  it("sends a Catalog scope and clears it when the source filter leaves Catalog", async () => {
    vi.spyOn(api, "searchEverywhereStart").mockResolvedValue({
      id: "session-one",
      snapshot: snapshot({ revision: 1 }),
    });
    await render();
    await submit("alpha");
    await act(async () => {
      current.setSources(["catalog"]);
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      current.setScope({ addonKey: "local-addon", catalogType: "movie", catalogId: "films" });
      await Promise.resolve();
    });
    await flush();

    expect(startBodies().at(-1)).toMatchObject({
      sources: ["catalog"],
      scope: { addonKey: "local-addon", catalogType: "movie", catalogId: "films" },
    });

    await act(async () => {
      current.setSources(["local", "remote"]);
      await Promise.resolve();
    });
    await flush();
    expect(startBodies().at(-1)?.sources).toEqual(["local", "remote"]);
    expect(startBodies().at(-1)).not.toHaveProperty("scope");
    expect(current.scope).toBeNull();
  });

  it("ends the session when the page is closed or reloaded", async () => {
    vi.spyOn(api, "searchEverywhereStart").mockResolvedValue({
      id: "session-pagehide",
      snapshot: snapshot({ revision: 1 }),
    });

    await render();
    await submit("alpha");
    window.dispatchEvent(new Event("pagehide"));

    expect(api.searchEverywhereDelete).toHaveBeenCalledWith("session-pagehide");
  });

  it("deletes the session and clears the query when Search is left", async () => {
    vi.spyOn(api, "searchEverywhereStart").mockResolvedValue({
      id: "session-leave",
      snapshot: snapshot({ revision: 1 }),
    });

    await render();
    await submit("alpha");
    expect(current.committed).toBe("alpha");
    await rerender(false, false);

    expect(api.searchEverywhereDelete).toHaveBeenCalledWith("session-leave");
    expect(current.committed).toBe("");
    expect(current.draft).toBe("");
    expect(current.snapshot).toBeNull();
  });

  it("never reads Catalog search history", async () => {
    vi.spyOn(api, "searchEverywhereStart").mockResolvedValue({
      id: "session-one",
      snapshot: snapshot({ revision: 1 }),
    });
    vi.spyOn(api, "searchEverywherePoll").mockResolvedValue({ changed: false, revision: 1 });

    await render();
    await submit("alpha");
    await act(async () => {
      current.setSources(["catalog"] as SearchSourceClass[]);
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      current.retry("catalog-one");
      current.loadMore();
      await Promise.resolve();
    });
    await flush();

    expect(api.searchState).not.toHaveBeenCalled();
    expect(api.recordSearch).not.toHaveBeenCalled();
  });
});
