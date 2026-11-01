import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApiError, api } from "./api";
import { setLocale } from "./i18n";
import { SeriesBulkDialog } from "./SeriesBulkDialog";
import type {
  BulkPrepareResponse,
  CatalogueBulkRequest,
  PreparedBulkEpisode,
  RemoteBulkRequest,
  SourceProfile,
} from "./types";

const profile: SourceProfile = {
  id: "balanced", nameKey: "rules.preset.balanced", template: "rules", revision: 3,
  operations: ["downloadToLibrary"],
  sizeLimits: { episodeBytes: 4_000_000_000 },
  policy: {
    schemaVersion: 1,
    scope: { mode: "allAvailable" },
    constraints: {
      sourceKinds: ["localFile", "mediaServerOriginal", "http", "torrent"],
      audio: { mode: "preferred", preferred: { preference: "audio" } },
      subtitles: { mode: "optional", preferred: { preference: "subtitle" } },
      heightPixels: { min: 720, max: 1080 },
      bytes: { max: 4_000_000_000 },
    },
    criteria: [{ kind: "audioTier" }, { kind: "providerOrder", from: "viewer" }],
    nextEpisode: "profile",
    existingLocalCopy: "meetsRequirements",
  },
};
const catalogueRequest = (scope: "season" | "series" = "series", season?: number): CatalogueBulkRequest => ({
  scope,
  ...(season !== undefined ? { season } : {}),
  title: "Show",
  media: { id: "tt-show", metaType: "series", poster: "/show.jpg" },
  episodes: [
    { id: "tt-show:1:1", season: 1, episode: 1, title: "Pilot" },
    { id: "tt-show:2:1", season: 2, episode: 1, title: "Return" },
  ],
});
const remoteRequest = (scope: "season" | "series" = "series", season?: number): RemoteBulkRequest => ({
  scope,
  ...(season !== undefined ? { season } : {}),
  title: "Show",
  libraryId: "rlib_a",
  libraryName: "Shows",
  provider: "jellyfin",
  seriesItemId: "ser1",
});
const preparedEpisode = (id: string, season: number | undefined, episode: number | undefined, status: PreparedBulkEpisode["status"], title?: string): PreparedBulkEpisode =>
  ({ id, ...(season !== undefined ? { season } : {}), ...(episode !== undefined ? { episode } : {}), status, ...(title ? { title } : {}) });
const response = (episodes: PreparedBulkEpisode[], over: Partial<BulkPrepareResponse> = {}): BulkPrepareResponse => ({
  origin: "catalogue",
  series: { title: "Show", catalogueId: "tt-show" },
  target: { libraryId: "lib_show", libraryName: "Series" },
  episodes,
  listing: { complete: true },
  ...over,
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  vi.spyOn(api, "sourceProfiles").mockResolvedValue([profile]);
  vi.spyOn(api, "prepareBulk").mockResolvedValue(response([
    preparedEpisode("tt-show:1:1", 1, 1, "ready", "Pilot"),
    preparedEpisode("tt-show:2:1", 2, 1, "ready", "Return"),
  ]));
  vi.spyOn(api, "meta").mockResolvedValue({
    id: "tt-show", type: "series", name: "Show",
    videos: [
      { id: "tt-show:1:1", season: 1, episode: 1, title: "Pilot" },
      { id: "tt-show:2:1", season: 2, episode: 1, title: "Return" },
    ],
  });
  vi.spyOn(api, "downloadBulk").mockResolvedValue({ added: 0, skipped: 0, results: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const flush = () => act(async () => {
  await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
});
const settlePrepare = async () => {
  await flush();
  await act(async () => { await new Promise((done) => setTimeout(done, 650)); });
  await flush();
};
const renderDialog = async (request: CatalogueBulkRequest | RemoteBulkRequest = catalogueRequest()) => {
  const onQueued = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    root.render(<SeriesBulkDialog request={request} libraries={[]} onQueued={onQueued} onClose={onClose}/>);
  });
  await settlePrepare();
  return { onQueued, onClose };
};
const click = async (element: Element | null) => {
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
};
const primary = () => document.querySelector<HTMLButtonElement>(".series-bulk-card .dialog-foot button.primary")!;
const summary = () => host.querySelector(".series-bulk-summary")!;
const setChecked = async (element: HTMLInputElement, checked: boolean) => {
  if (element.checked !== checked) await act(async () => { element.click(); });
};
const selectValue = async (element: HTMLSelectElement, value: string) => {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

describe("SeriesBulkDialog", () => {
  it("prepares the full series once, whatever scope is displayed", async () => {
    await renderDialog(catalogueRequest("season", 2));
    expect(api.prepareBulk).toHaveBeenCalledOnce();
    expect(api.prepareBulk).toHaveBeenCalledWith(expect.objectContaining({
      scope: "series",
      specials: true,
      title: "Show",
      selection: { profile: { profileId: "balanced", revision: 3 } },
    }), expect.any(AbortSignal));
    await selectValue(host.querySelector<HTMLSelectElement>('select[aria-label="Season"]')!, "1");
    await click(document.querySelector('input[name="series-bulk-scope"][value="series"]'));
    expect(api.prepareBulk).toHaveBeenCalledOnce();
  });

  it("falls back to the first regular season when the entry season is absent", async () => {
    vi.mocked(api.prepareBulk).mockResolvedValue(response([
      preparedEpisode("e0", 0, 1, "ready", "Special"),
      preparedEpisode("e2", 2, 1, "ready", "Second"),
      preparedEpisode("e3", 3, 1, "ready", "Third"),
    ]));
    await renderDialog(catalogueRequest("season", 99));
    expect(document.querySelector<HTMLInputElement>('input[name="series-bulk-scope"][value="season"]')?.checked).toBe(true);
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Season"]')?.value).toBe("2");
  });

  it("summarises statuses and lists skipped episodes with their reasons", async () => {
    vi.mocked(api.prepareBulk).mockResolvedValue(response([
      preparedEpisode("e1", 1, 1, "ready", "Pilot"),
      preparedEpisode("e2", 1, 2, "inTarget", "Already here"),
      preparedEpisode("e3", 1, 3, "queued", "Waiting"),
      preparedEpisode("e4", 1, 4, "unreleased", "Later"),
      preparedEpisode("e5", 1, undefined, "unnumbered", "Extra"),
    ]));
    await renderDialog();
    expect(summary().textContent).toContain("1 episode ready · 1 already in the library · 1 already in the queue · 1 not released yet · 1 without numbering");
    await click(host.querySelector(".series-bulk-summary .link-button"));
    expect([...host.querySelectorAll(".series-bulk-skipped li")].map((item) => item.textContent)).toEqual([
      "S01E02 · Already here · already in the library",
      "S01E03 · Waiting · already in the queue",
      "S01E04 · Later · not released yet",
      "Extra · no season or episode number",
    ]);
  });

  it("adds specials only when whole-series specials are selected", async () => {
    vi.mocked(api.prepareBulk).mockResolvedValue(response([
      preparedEpisode("e1", 1, 1, "ready", "Pilot"),
      preparedEpisode("e0", 0, 1, "ready", "Special"),
    ]));
    await renderDialog();
    expect(primary().textContent).toContain("Add 1 episode");
    const specials = host.querySelector<HTMLInputElement>(".bulk-remember-profile input")!;
    await setChecked(specials, true);
    expect(primary().textContent).toContain("Add 2 episodes");
    expect(api.prepareBulk).toHaveBeenCalledOnce();
  });

  it("disables the primary on an incomplete list and retries the prepare", async () => {
    vi.mocked(api.prepareBulk)
      .mockResolvedValueOnce(response([preparedEpisode("e1", 1, 1, "ready", "Pilot")], { listing: { complete: false } }))
      .mockResolvedValueOnce(response([preparedEpisode("e1", 1, 1, "ready", "Pilot")]));
    await renderDialog();
    expect(summary().textContent).toContain("The episode list could not be read completely.");
    expect(primary().disabled).toBe(true);
    await click(byText(".series-bulk-incomplete button", "Try again")!);
    await settlePrepare();
    expect(api.prepareBulk).toHaveBeenCalledTimes(2);
    expect(primary().disabled).toBe(false);
  });

  it("aborts a running prepare when the dialog closes", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(api.prepareBulk).mockImplementation((_body, nextSignal) => {
      signal = nextSignal;
      return new Promise(() => undefined);
    });
    const { onClose } = await renderDialog();
    expect(summary().textContent).toContain("Preparing the episode list…");
    await click(byText(".dialog-foot button", "Cancel")!);
    expect(signal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("commits 1234 ready episodes sequentially in batches of 500, 500 and 234", async () => {
    const episodes = Array.from({ length: 1234 }, (_value, index) => preparedEpisode(`e${index + 1}`, 1, index + 1, "ready"));
    vi.mocked(api.prepareBulk).mockResolvedValue(response(episodes));
    let active = 0;
    let maximum = 0;
    vi.mocked(api.downloadBulk).mockImplementation(async (_title, _type, batch) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return { added: batch.length, skipped: 0, results: [] };
    });
    const { onQueued, onClose } = await renderDialog();
    await click(primary());
    await flush();
    const calls = vi.mocked(api.downloadBulk).mock.calls;
    expect(calls.map((call) => call[2].length)).toEqual([500, 500, 234]);
    expect(calls.map((call) => call[2][0]?.id)).toEqual(["e1", "e501", "e1001"]);
    expect(calls[2]![2].at(-1)?.id).toBe("e1234");
    expect(maximum).toBe(1);
    expect(onQueued).toHaveBeenCalledWith(1234, 0);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the dialog open with the partly-added count when a later batch fails", async () => {
    const episodes = Array.from({ length: 700 }, (_value, index) => preparedEpisode(`e${index + 1}`, 1, index + 1, "ready"));
    vi.mocked(api.prepareBulk).mockResolvedValue(response(episodes));
    vi.mocked(api.downloadBulk)
      .mockResolvedValueOnce({ added: 500, skipped: 0, results: [] })
      .mockRejectedValueOnce(new ApiError("Batch failed", 500));
    const { onQueued, onClose } = await renderDialog();
    await click(primary());
    await flush();
    expect(document.querySelector(".series-bulk-card")).not.toBeNull();
    expect(document.querySelector(".dialog-foot .login-error")!.textContent).toContain("Batch failed 500 episodes were already added.");
    expect(onQueued).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers catalogue sourcing only when the remote answer names a catalogue series", async () => {
    vi.mocked(api.prepareBulk).mockResolvedValue(response([
      preparedEpisode("remote:1", 1, 1, "ready", "Pilot"),
    ], { origin: "remote", series: { title: "Show" } }));
    await renderDialog(remoteRequest());
    expect(document.querySelectorAll('input[name="series-bulk-source"]')).toHaveLength(1);

    vi.mocked(api.prepareBulk).mockClear();
    vi.mocked(api.prepareBulk).mockResolvedValue(response([
      preparedEpisode("remote:1", 1, 1, "ready", "Pilot"),
    ], { origin: "remote", series: { title: "Show", catalogueId: "tt-show" } }));
    act(() => root.unmount());
    root = createRoot(host);
    await renderDialog(remoteRequest());
    expect(document.querySelectorAll('input[name="series-bulk-source"]')).toHaveLength(2);
    await click(document.querySelector('input[name="series-bulk-source"][value="catalogue"]'));
    await settlePrepare();
    expect(api.meta).toHaveBeenCalledOnce();
    expect(api.meta).toHaveBeenCalledWith("series", "tt-show");
    expect(api.prepareBulk).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.prepareBulk).mock.calls[1]![0].origin).toEqual({
      kind: "catalogue",
      media: expect.objectContaining({ id: "tt-show", metaType: "series" }),
      episodes: [
        { id: "tt-show:1:1", season: 1, episode: 1, title: "Pilot" },
        { id: "tt-show:2:1", season: 2, episode: 1, title: "Return" },
      ],
    });
    await click(primary());
    const commit = vi.mocked(api.downloadBulk).mock.calls[0]!;
    expect(commit[4]).toEqual(expect.objectContaining({ id: "tt-show", metaType: "series" }));
    expect(commit[6]).toBeUndefined();
    expect(commit[2][0]).not.toHaveProperty("remoteItemId");
  });

  it("shows the remote-rules refusal and keeps the primary disabled", async () => {
    vi.mocked(api.prepareBulk).mockRejectedValue(new ApiError(
      "Your download rules do not allow copying from this library.",
      400,
      "BULK_REMOTE_NOT_IN_RULES",
      "err.bulkRemoteNotInRules",
    ));
    await renderDialog(remoteRequest());
    expect(summary().textContent).toContain("Your download rules do not allow copying from this library.");
    expect(primary().disabled).toBe(true);
  });

  it("commits a remote-library origin with the provider item ids", async () => {
    vi.mocked(api.prepareBulk).mockResolvedValue(response([
      {
        id: "remote-item:rlib_a:item-1", season: 1, episode: 1, title: "Pilot",
        remoteItemId: "item-1", status: "ready",
      },
    ], { origin: "remote", series: { title: "Show", catalogueId: "tt-show" } }));
    vi.mocked(api.downloadBulk).mockResolvedValue({ added: 1, skipped: 0, results: [] });
    await renderDialog(remoteRequest());
    await click(primary());
    expect(api.downloadBulk).toHaveBeenCalledWith(
      "Show",
      "series",
      [{ id: "remote-item:rlib_a:item-1", season: 1, episode: 1, title: "Pilot", remoteItemId: "item-1" }],
      { profile: { profileId: "balanced", revision: 3 } },
      undefined,
      undefined,
      { kind: "remote", libraryId: "rlib_a", seriesItemId: "ser1" },
    );
  });
});

const byText = (selector: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((node) => node.textContent?.includes(text));
