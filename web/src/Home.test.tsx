import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Home } from "./Home";
import { setLocale } from "./i18n";
import type { HomeRowState, HomeRows } from "./home-state";
import type { HomeCard } from "../../server/src/home";
import { homeCatalogRowId } from "../../server/src/home";
import type { Download, TileShape } from "./types";

const at = "2026-01-01T00:00:00.000Z";
const job = (over: Partial<Download> & Pick<Download, "id">): Download => ({
  title: over.id, status: "queued", target: `${over.id}.mkv`, received: 0, speed: 0,
  createdAt: at, updatedAt: at, pending: false, order: 0, mine: true, ...over,
});
const rowState = (over: Partial<HomeRowState> = {}): HomeRowState => ({ status: "ok", items: [], hasMore: false, partial: false, request: 1, ...over });
const allEmpty = (over: Partial<HomeRows> = {}): HomeRows => ({
  resume: rowState(), episodes: rowState(), completed: rowState(), recent: rowState(), tonight: rowState(), favorites: rowState(), confirm: rowState(), ...over,
});
type ResumeFile = Extract<HomeCard, { kind: "resume-file" }>;
type Completed = Extract<HomeCard, { kind: "completed" }>;
type Favorite = Extract<HomeCard, { kind: "favorite" }>;
type Episode = Extract<HomeCard, { kind: "episode" }>;
type Recent = Extract<HomeCard, { kind: "recent" }>;
type Tonight = Extract<HomeCard, { kind: "tonight" }>;
type Confirm = Extract<HomeCard, { kind: "confirm" }>;
type Discovery = Extract<HomeCard, { kind: "discovery" }>;
const resumeFile = (key = "file:a"): ResumeFile => ({
  kind: "resume-file", key, title: `Title ${key}`, path: `lib_00000000/${key}.mkv`,
  progress: { position: 1, duration: 4 }, updatedAt: at, forgetKeys: [key, `${key}:extra`],
});
const catalogue = (over: Partial<Extract<HomeCard, { kind: "resume-catalogue" }>> = {}): HomeCard => ({
  kind: "resume-catalogue", key: "series:tt2:2:4", title: "Show", type: "series", id: "tt2", name: "Show",
  season: 2, episode: 4, progress: { position: 1, duration: 4 }, updatedAt: at, forgetKeys: ["series:tt2:2:4"], ...over,
});
const completedCard = (): Completed => ({ kind: "completed", key: "lib_00000000/c.mkv", title: "Film", path: "lib_00000000/c.mkv", completedAt: at });
const favoriteCard = (itemKind: "file" | "folder", key = "lib_00000000/d"): Favorite => ({ kind: "favorite", key, path: key, itemKind, label: "Fav" });
const episodeCard = (): Episode => ({ kind: "episode", key: "episode:f:1", followId: "f", type: "series", metaId: "tt2", name: "Show", poster: "art", season: 2, episode: 4, released: "2026-10-03T00:00:00Z" });
const recentCard = (): Recent => ({ kind: "recent", key: "lib_00000000/r.mkv", path: "lib_00000000/r.mkv", label: "Recent", addedAt: at, libraryId: "lib_00000000", season: 2, episode: 4 });
const tonightFile = (): Tonight => ({ kind: "tonight", key: "lib_00000000/t.mkv", path: "lib_00000000/t.mkv", itemKind: "file", label: "Tonight", year: "2024", libraryId: "lib_00000000" });
const tonightFolder = (): Tonight => ({ kind: "tonight", key: "lib_00000000/tf", path: "lib_00000000/tf", itemKind: "folder", label: "Folder", libraryId: "lib_00000000" });
const confirmCard = (): Confirm => ({ kind: "confirm", key: "s1", libraryId: "lib_00000000", library: "Films", label: "guess.mkv", path: "lib_00000000/guess.mkv", candidate: { name: "Real Title", year: "2023", poster: "art" } });
const discoveryCard = (): Discovery => ({ kind: "discovery", key: "movie:tt1", type: "movie", id: "tt1", name: "Film", title: "Film", year: "2025" });
const catalogAddon = { key: "cinemeta", role: "catalog" as const, enabled: true, globalSearch: true, showOnHome: true,
  manifest: { id: "com.linvo.cinemeta", name: "Cinemeta", version: "1", catalogs: [{ type: "movie", id: "top", name: "Popular" }] } };
const catalogRow = homeCatalogRowId("cinemeta", "movie", "top");

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

type Overrides = Partial<Parameters<typeof Home>[0]>;

const render = async (over: Overrides = {}) => {
  const props: Parameters<typeof Home>[0] = {
    jobs: [], libraries: [], addons: [], admin: false, rows: allEmpty(), shape: "wide" as TileShape,
    onShowDownloads: vi.fn(), onAction: vi.fn(async () => undefined),
    onToggleShape: vi.fn(), onRetry: vi.fn(), onShowAll: vi.fn(), onShuffle: vi.fn(),
    onPlay: vi.fn(), onOpenCatalogue: vi.fn(), onReveal: vi.fn(), onForgotten: vi.fn(), onError: vi.fn(),
    ...over,
  };
  await act(async () => { root.render(<Home {...props}/>); });
  return props;
};

const cardButtons = (row = ".hq-card") => [...host.querySelectorAll<HTMLDivElement>(row)].map((card) => [...card.querySelectorAll<HTMLButtonElement>("button")]);
const row = (id: string) => host.querySelector<HTMLElement>(`[data-row="${id}"]`);
const primary = (id: string) => row(id)!.querySelector<HTMLButtonElement>(".browse-open")!;
const menuButton = (id: string) => row(id)!.querySelector<HTMLButtonElement>(".browse-menu")!;
const menuItem = (text: string) => [...host.querySelectorAll<HTMLButtonElement>(".home-actions button")].find((button) => button.textContent?.includes(text));
const click = async (element: HTMLElement) => { await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); }); };
const openMenu = async (id: string) => { await act(async () => { menuButton(id).click(); }); };

describe("Home", () => {
  it("draws no row and shows the empty state when the queue is empty and every server row answered empty", async () => {
    await render({
      jobs: [job({ id: "done", status: "completed" }), job({ id: "theirs", mine: false })],
      rows: allEmpty(),
    });
    expect(host.querySelector(".home-row")).toBeNull();
    expect(host.querySelector(".empty")).not.toBeNull();
    expect(host.textContent).toContain("Nothing here yet");
  });

  it("withholds the empty state while a row is still loading or has failed", async () => {
    await render({ rows: allEmpty({ resume: rowState({ status: "loading" }) }) });
    expect(host.querySelector(".empty")).toBeNull();
    await render({ rows: allEmpty({ resume: rowState({ status: "error" }) }) });
    expect(host.querySelector(".empty")).toBeNull();
  });

  it("draws a quiet Downloads strip for healthy jobs, with no cards", async () => {
    await render({ jobs: [job({ id: "running", status: "downloading", total: 100, received: 50, speed: 1024 })] });
    expect(host.querySelector(".home-row")).not.toBeNull();
    expect(host.querySelector(".empty")).toBeNull();
    expect(host.textContent).toContain("Downloads");
    expect(host.querySelectorAll(".hq-card")).toHaveLength(0);
    expect(host.querySelector(".home-row .resume-show-all")!.textContent).toContain("Show all");
  });

  it("draws a card only for a job that needs attention", async () => {
    await render({ jobs: [
      job({ id: "running", status: "downloading" }),
      job({ id: "queued", status: "queued", order: 1 }),
      job({ id: "failed", status: "failed", order: 2 }),
      job({ id: "blocked", status: "paused", pauseReason: "storage", order: 3 }),
    ] });
    expect(cardButtons().map((buttons) => buttons[0]!.textContent)).toEqual(["failed", "blocked"]);
  });

  it("draws the shelves in the page order with Downloads last", async () => {
    await render({
      admin: true,
      jobs: [job({ id: "failed", status: "failed" })],
      rows: allEmpty({
        resume: rowState({ items: [resumeFile()] }),
        favorites: rowState({ items: [favoriteCard("file")] }),
        tonight: rowState({ items: [tonightFile()] }),
        [catalogRow]: rowState({ items: [discoveryCard()] }),
        episodes: rowState({ items: [episodeCard()] }),
        completed: rowState({ items: [completedCard()] }),
        recent: rowState({ items: [recentCard()] }),
        confirm: rowState({ items: [confirmCard()], total: 1 }),
      }),
    });
    expect([...host.querySelectorAll<HTMLElement>(".home-row")].map((element) => element.dataset.row ?? "downloads"))
      .toEqual(["resume", "favorites", "tonight", catalogRow, "episodes", "completed", "recent", "downloads"]);
    expect(row("confirm")).toBeNull();
  });

  it("keeps the title and the action as sibling buttons", async () => {
    const { onShowDownloads } = await render({ jobs: [job({ id: "Duna", status: "failed" })] });
    const [title, action] = cardButtons()[0]!;
    expect(title!.classList.contains("hq-title")).toBe(true);
    expect(title!.contains(action!)).toBe(false);
    expect(action!.contains(title!)).toBe(false);
    await click(title!);
    expect(onShowDownloads).toHaveBeenCalled();
  });

  it("calls onAction with the action the state names", async () => {
    const failed = job({ id: "failed", status: "failed" });
    const paused = job({ id: "paused", status: "paused", pauseReason: "user", order: 1 });
    const { onAction } = await render({ jobs: [failed, paused] });
    expect(cardButtons()).toHaveLength(1);
    await click(cardButtons()[0]![1]!);
    expect(onAction).toHaveBeenCalledWith(failed, "retry");
    expect(cardButtons().some((buttons) => buttons[0]!.textContent?.includes("paused"))).toBe(false);
  });

  it("opens the Downloads view for a job Home cannot repair", async () => {
    const blocked = job({ id: "blocked", status: "paused", pauseReason: "storage" });
    const { onAction, onShowDownloads } = await render({ jobs: [blocked] });
    await click(cardButtons()[0]![1]!);
    expect(onShowDownloads).toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
    expect(cardButtons()[0]![1]!.textContent).toContain("Downloads");
  });

  it("disables only the card whose mutation is pending and restores it on failure", async () => {
    let rejectAction: (error: unknown) => void = () => undefined;
    const onAction = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectAction = reject; }));
    await render({ jobs: [job({ id: "a", status: "failed" }), job({ id: "b", status: "failed", order: 1 })], onAction });

    await click(cardButtons()[0]![1]!);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(cardButtons()[0]![1]!.disabled).toBe(true);
    expect(cardButtons()[1]![1]!.disabled).toBe(false);

    await act(async () => { rejectAction(new Error("the queue refused it")); });
    expect(cardButtons()[0]![1]!.disabled).toBe(false);
    expect(cardButtons()[1]![1]!.disabled).toBe(false);
  });

  it("does not draw a shelf with no items", async () => {
    await render({ rows: allEmpty({ completed: rowState({ items: [completedCard()] }) }) });
    expect(row("resume")).toBeNull();
    expect(row("favorites")).toBeNull();
    expect(row("completed")).not.toBeNull();
  });

  it("draws a fixed-height skeleton on a row's first load", async () => {
    await render({ rows: allEmpty({ resume: rowState({ status: "loading", items: [] }) }) });
    expect(row("resume")).not.toBeNull();
    expect(row("resume")!.querySelector(".resume-strip.skeleton")).not.toBeNull();
  });

  it("keeps its cards on refresh and marks the row as loading", async () => {
    await render({ rows: allEmpty({ resume: rowState({ status: "loading", items: [resumeFile()] }) }) });
    expect(row("resume")!.querySelectorAll(".home-card")).toHaveLength(1);
    expect(row("resume")!.querySelector(".resume-strip.refreshing")).not.toBeNull();
  });

  it("shows a row's own error line and retries only that row", async () => {
    const { onRetry } = await render({ rows: allEmpty({ resume: rowState({ status: "error" }), favorites: rowState({ items: [favoriteCard("file")] }) }) });
    const retry = row("resume")!.querySelector<HTMLButtonElement>(".home-retry")!;
    expect(retry.textContent).toContain("Try again");
    await click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith("resume");
  });

  it("notes a partial row", async () => {
    const { onRetry } = await render({ rows: allEmpty({ resume: rowState({ items: [resumeFile()], partial: true }) }) });
    expect(row("resume")!.querySelector(".home-note")!.textContent).toContain("Some titles could not be checked.");
    await click(row("resume")!.querySelector<HTMLButtonElement>(".home-retry")!);
    expect(onRetry).toHaveBeenCalledWith("resume");
  });

  it("plays a resume-file and offers Show in library and Forget progress", async () => {
    const card = resumeFile();
    const { onPlay, onReveal } = await render({ rows: allEmpty({ resume: rowState({ items: [card] }) }) });
    expect(cardButtons(".home-card").length).toBe(1);
    await click(primary("resume"));
    expect(onPlay).toHaveBeenCalledWith(card);
    await openMenu("resume");
    await click(menuItem("Show in library")!);
    expect(onReveal).toHaveBeenCalledWith(card.path);
  });

  it("opens a catalogue card on the remembered episode", async () => {
    const card = catalogue();
    const { onOpenCatalogue } = await render({ rows: allEmpty({ resume: rowState({ items: [card] }) }) });
    expect(row("resume")!.textContent).toContain("Open episode");
    expect(row("resume")!.textContent).toContain("S02E04");
    await click(primary("resume"));
    expect(onOpenCatalogue).toHaveBeenCalledWith(card);
  });

  it("labels a film Open title and a pending next episode without a progress bar", async () => {
    await render({ rows: allEmpty({ resume: rowState({ items: [catalogue({ type: "movie", id: "tt9", key: "movie:tt9", name: "Film" })] }) }) });
    expect(row("resume")!.textContent).toContain("Open title");
    await render({ rows: allEmpty({ resume: rowState({ items: [catalogue({ pending: true, progress: undefined, episode: 5, key: "series:tt2:2:5" })] }) }) });
    expect(row("resume")!.textContent).toContain("Next episode");
    expect(row("resume")!.textContent).toContain("S02E05");
    expect(row("resume")!.querySelector(".resume-bar")).toBeNull();
  });

  it("plays a completed card and a favourite file, and opens a favourite folder", async () => {
    const play = completedCard();
    const file = favoriteCard("file");
    const folder = favoriteCard("folder", "lib_00000000/e");
    const { onPlay, onReveal } = await render({ rows: allEmpty({ completed: rowState({ items: [play] }), favorites: rowState({ items: [file, folder] }) }) });
    await click(primary("completed"));
    expect(onPlay).toHaveBeenCalledWith(play);
    const opens = [...row("favorites")!.querySelectorAll<HTMLButtonElement>(".browse-open")];
    await click(opens[0]!);
    expect(onPlay).toHaveBeenCalledWith(file);
    await click(opens[1]!);
    expect(onReveal).toHaveBeenCalledWith(folder.path);
  });

  it("keeps the title and the card menu as sibling buttons", async () => {
    await render({ rows: allEmpty({ resume: rowState({ items: [resumeFile()] }) }) });
    const title = primary("resume");
    const menu = menuButton("resume");
    expect(title.contains(menu)).toBe(false);
    expect(menu.contains(title)).toBe(false);
    expect(title.parentElement).toBe(menu.parentElement);
  });

  it("asks before forgetting, then sends every forgetKey in one call", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { onForgotten } = await render({ rows: allEmpty({ resume: rowState({ items: [resumeFile()] }) }) });
    await openMenu("resume");
    await click(menuItem("Forget progress")!);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/api/progress/forget");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body)).keys).toEqual(["file:a", "file:a:extra"]);
    expect(onForgotten).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the confirmation is dismissed", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { onForgotten } = await render({ rows: allEmpty({ resume: rowState({ items: [resumeFile()] }) }) });
    await openMenu("resume");
    await click(menuItem("Forget progress")!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onForgotten).not.toHaveBeenCalled();
  });

  it("shows Show all only for a row with more, and Favourites always offers Open library", async () => {
    const { onShowAll } = await render({
      rows: allEmpty({ resume: rowState({ items: [resumeFile()], hasMore: true }), completed: rowState({ items: [completedCard()] }), favorites: rowState({ items: [favoriteCard("file")] }) }),
    });
    const showAll = (id: string) => row(id)!.querySelector<HTMLButtonElement>(".resume-show-all");
    expect(showAll("resume")!.textContent).toContain("Show all");
    expect(showAll("completed")).toBeNull();
    expect(showAll("favorites")!.textContent).toContain("Open library");
    await click(showAll("resume")!);
    expect(onShowAll).toHaveBeenCalledWith("library-resume");
    await click(showAll("favorites")!);
    expect(onShowAll).toHaveBeenCalledWith("library-favorites");
  });

  it("flips the tile shape from the heading", async () => {
    const { onToggleShape } = await render({ jobs: [job({ id: "a", status: "downloading" })] });
    await click(host.querySelector<HTMLButtonElement>(".shape-toggle")!);
    expect(onToggleShape).toHaveBeenCalledTimes(1);
  });

  it("draws the New episodes, Recently added and Tonight shelves, and no confirm shelf", async () => {
    await render({ admin: true, rows: allEmpty({
      episodes: rowState({ items: [episodeCard()] }),
      recent: rowState({ items: [recentCard()] }),
      tonight: rowState({ items: [tonightFile()] }),
      confirm: rowState({ items: [confirmCard()], total: 1 }),
    }) });
    expect(row("episodes")).not.toBeNull();
    expect(row("recent")).not.toBeNull();
    expect(row("tonight")).not.toBeNull();
    expect(row("confirm")).toBeNull();
  });

  it("opens a Cinemeta title and displays its year without a card menu", async () => {
    const card = discoveryCard();
    const { onOpenCatalogue } = await render({ addons: [catalogAddon], rows: allEmpty({ [catalogRow]: rowState({ items: [card] }) }) });
    expect(row(catalogRow)!.textContent).toContain("2025");
    await click(primary(catalogRow));
    expect(onOpenCatalogue).toHaveBeenCalledWith(card);
    expect(row(catalogRow)!.querySelector(".browse-menu")).toBeNull();
  });

  it("omits a new shelf with no items", async () => {
    await render({ admin: true, rows: allEmpty({ episodes: rowState({ items: [episodeCard()] }) }) });
    expect(row("episodes")).not.toBeNull();
    expect(row("recent")).toBeNull();
    expect(row("tonight")).toBeNull();
    expect(row("confirm")).toBeNull();
  });

  it("opens a new episode's show and captions it with its numbering and release date", async () => {
    const card = episodeCard();
    const { onOpenCatalogue } = await render({ rows: allEmpty({ episodes: rowState({ items: [card] }) }) });
    expect(row("episodes")!.textContent).toContain("S02E04");
    expect(row("episodes")!.textContent).toContain("03/10/2026");
    await click(primary("episodes"));
    expect(onOpenCatalogue).toHaveBeenCalledWith(card);
    expect(row("episodes")!.querySelector(".browse-menu")).toBeNull();
  });

  it("plays a recently added card and reveals it from the menu", async () => {
    const card = recentCard();
    const { onPlay, onReveal } = await render({ rows: allEmpty({ recent: rowState({ items: [card] }) }) });
    await click(primary("recent"));
    expect(onPlay).toHaveBeenCalledWith(card);
    await openMenu("recent");
    await click(menuItem("Show in library")!);
    expect(onReveal).toHaveBeenCalledWith(card.path);
  });

  it("plays a Tonight file, opens a Tonight folder in the library, and captions the year", async () => {
    const file = tonightFile();
    const folder = tonightFolder();
    const { onPlay, onReveal } = await render({ rows: allEmpty({ tonight: rowState({ items: [file, folder] }) }) });
    expect(row("tonight")!.textContent).toContain("2024");
    const opens = [...row("tonight")!.querySelectorAll<HTMLButtonElement>(".browse-open")];
    await click(opens[0]!);
    expect(onPlay).toHaveBeenCalledWith(file);
    await click(opens[1]!);
    expect(onReveal).toHaveBeenCalledWith(folder.path);
  });

  it("shuffles the Tonight row with an incrementing counter", async () => {
    const onShuffle = vi.fn();
    await render({ rows: allEmpty({ tonight: rowState({ items: [tonightFile()] }) }), onShuffle });
    const shuffle = row("tonight")!.querySelector<HTMLButtonElement>(".home-shuffle")!;
    expect(shuffle.getAttribute("aria-label")).toBe("Shuffle");
    await click(shuffle);
    await click(shuffle);
    expect(onShuffle.mock.calls).toEqual([["tonight", 1], ["tonight", 2]]);
  });

  it("shuffles the Cinemeta row with an incrementing counter", async () => {
    const onShuffle = vi.fn();
    await render({ addons: [catalogAddon], rows: allEmpty({ [catalogRow]: rowState({ items: [discoveryCard()] }) }), onShuffle });
    const shuffle = row(catalogRow)!.querySelector<HTMLButtonElement>(".home-shuffle")!;
    expect(shuffle.getAttribute("aria-label")).toBe("Shuffle");
    await click(shuffle);
    await click(shuffle);
    expect(onShuffle.mock.calls).toEqual([[catalogRow, 1], [catalogRow, 2]]);
  });

  it("shows the To confirm count as a heading chip that opens the suggestions dialog", async () => {
    const { onShowAll } = await render({ admin: true, rows: allEmpty({ confirm: rowState({ items: [confirmCard()], total: 4 }) }) });
    expect(row("confirm")).toBeNull();
    const chip = host.querySelector<HTMLButtonElement>(".home-confirm-chip")!;
    expect(chip.textContent).toBe("4 to confirm");
    await click(chip);
    expect(onShowAll).toHaveBeenCalledWith("confirm");
  });

  it("draws no confirm chip for an empty, loading or ordinary confirm row", async () => {
    await render({ admin: true, rows: allEmpty() });
    expect(host.querySelector(".home-confirm-chip")).toBeNull();
    await render({ admin: true, rows: allEmpty({ confirm: rowState({ status: "loading" }) }) });
    expect(host.querySelector(".home-confirm-chip")).toBeNull();
    // An ordinary account never asks for `confirm`, so its rows carry none and no chip.
    const withoutConfirm = Object.fromEntries(Object.entries(allEmpty()).filter(([row]) => row !== "confirm")) as HomeRows;
    await render({ admin: false, rows: withoutConfirm });
    expect(host.querySelector(".home-confirm-chip")).toBeNull();
  });

  it("shows the confirm row's failure and retry under the heading, not a shelf", async () => {
    const { onRetry } = await render({ admin: true, rows: allEmpty({ confirm: rowState({ status: "error" }) }) });
    expect(row("confirm")).toBeNull();
    const note = host.querySelector(".home-note.bad")!;
    expect(note.textContent).toContain("This row could not load.");
    await click(note.querySelector<HTMLButtonElement>(".home-retry")!);
    expect(onRetry).toHaveBeenCalledWith("confirm");
  });

  it("never draws the To confirm shelf for an ordinary account", async () => {
    await render({ admin: false, rows: allEmpty({ confirm: rowState({ items: [confirmCard()], total: 3 }) }) });
    expect(row("confirm")).toBeNull();
  });

  it("leaves the other shelves alone when one new row fails", async () => {
    await render({ admin: true, rows: allEmpty({ recent: rowState({ status: "error" }), tonight: rowState({ items: [tonightFile()] }) }) });
    expect(row("recent")!.querySelector(".home-note.bad")).not.toBeNull();
    expect(row("tonight")).not.toBeNull();
  });

  it("points New episodes at Following and Recently added at the library", async () => {
    const { onShowAll } = await render({ rows: allEmpty({ episodes: rowState({ items: [episodeCard()] }), recent: rowState({ items: [recentCard()], hasMore: true }) }) });
    await click(row("episodes")!.querySelector<HTMLButtonElement>(".resume-show-all")!);
    expect(onShowAll).toHaveBeenCalledWith("following");
    await click(row("recent")!.querySelector<HTMLButtonElement>(".resume-show-all")!);
    expect(onShowAll).toHaveBeenCalledWith("library");
  });
});
