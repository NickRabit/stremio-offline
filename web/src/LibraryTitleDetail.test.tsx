import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LibraryTitleDetail, type LibraryTitleDetailProps } from "./LibraryTitleDetail";
import { TitleChips } from "./TitleChips";
import type { LibrarySourceGroup } from "./library-sources";
import type { GalleryImage } from "./gallery-images";
import { sourceIdentity } from "./library-detail-sources";
import { setLocale } from "./i18n";
import type { MediaServerProvider, Stream } from "./types";

const poster = (url: string): GalleryImage => ({ url, label: "Poster", shape: "poster", kind: "poster" });
const still = (url: string): GalleryImage => ({ url, label: "Still 1", shape: "wide", kind: "still" });

const remote = (id: string, name: string, bytes?: number): Stream => ({
  sourceId: id, kind: "remote", playable: true, name, provider: "jellyfin",
  remoteItem: { libraryId: "l", itemId: "i", mediaSourceId: id, progressKey: "k" },
  behaviorHints: bytes === undefined ? undefined : { videoSize: bytes },
});

/** The identity a detail names a version by, so a saved position can be attached to the right one. */
const key = (mediaSourceId: string) => sourceIdentity(remote(mediaSourceId, "version"));

/** A supplementary addon row: no remote identity at all, only its own addon and source id. */
const addon = (id: string, name: string, size?: number): Stream => ({
  sourceId: id, kind: "remote", playable: true, name, addonKey: "torrentio", addonName: "Torrentio",
  ...(size === undefined ? {} : { behaviorHints: { videoSize: size } }),
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const render = (over: Partial<LibraryTitleDetailProps> = {}) => {
  const onPlay = vi.fn();
  const props: LibraryTitleDetailProps = { identityKey: "t1", title: "One", sources: [remote("s1", "1080p", 2_000_000_000)], onPlay, ...over };
  act(() => root.render(<LibraryTitleDetail {...props}/>));
  return { onPlay, props };
};
const rerender = (over: Partial<LibraryTitleDetailProps>) => {
  const onPlay = vi.fn();
  act(() => root.render(<LibraryTitleDetail identityKey="t1" title="One" sources={null} onPlay={onPlay} {...over}/>));
  return onPlay;
};
const click = (element: Element | null) => act(() => { (element as HTMLElement).click(); });
const playButton = () => host.querySelector<HTMLButtonElement>(".library-detail-play button.primary")!;
const pickerRows = () => [...document.querySelectorAll<HTMLButtonElement>(".library-source-card .remote-streams button")];
const chosenRow = () => pickerRows().find((row) => row.getAttribute("aria-pressed") === "true");
const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
const clickAsync = async (element: Element | null) => { await act(async () => { (element as HTMLElement).click(); }); await flush(); };
const saved = () => host.querySelector(".library-detail-progress");
const savedText = () => host.querySelector(".library-detail-progress span")!.textContent;
const clearButton = () => host.querySelector<HTMLButtonElement>('.library-detail-progress button[aria-label="Forget progress"]');
const startOverButton = () => host.querySelector<HTMLButtonElement>('.library-detail-actions button[aria-label="Play from the start"]');
const favoriteButton = () => host.querySelector<HTMLButtonElement>(".library-detail-chips > button.watch-star");
const lowerActions = () => host.querySelector(".library-detail-actions")!;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("LibraryTitleDetail sources", () => {
  it("plays the single source with no picker arrow", () => {
    const { onPlay } = render();
    expect(host.querySelector(".split-button-toggle")).toBeNull();
    expect(playButton().disabled).toBe(false);
    click(playButton());
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "s1" }));
  });

  it("defaults a multi-version title to the largest and lets another be chosen", () => {
    const sources = [remote("s1", "720p", 800_000_000), remote("s2", "1080p", 3_000_000_000), remote("s3", "Small", 10)];
    render({ sources });
    click(host.querySelector<HTMLButtonElement>(".split-button-toggle"));
    const rows = pickerRows();
    expect(rows).toHaveLength(3);
    expect(chosenRow()!.textContent).toContain("1080p");
    click(rows[2]!);
    expect(document.querySelector(".library-source-card")).toBeNull();
    // The picker is the one place a version is named; reopening it shows which one plays.
    click(host.querySelector<HTMLButtonElement>(".split-button-toggle"));
    expect(chosenRow()!.textContent).toContain("Small");
  });

  it("keeps an explicit choice across a refresh of the same title and resets for a new one", () => {
    const sources = [remote("s1", "1080p", 3_000_000_000), remote("s2", "720p", 1)];
    render({ sources });
    click(host.querySelector<HTMLButtonElement>(".split-button-toggle"));
    click(pickerRows()[1]!);
    // A refresh hands brand-new objects but the same identities.
    rerender({ sources: [remote("s1", "1080p", 3_000_000_000), remote("s2", "720p", 1)] });
    click(host.querySelector<HTMLButtonElement>(".split-button-toggle"));
    expect(chosenRow()!.textContent).toContain("720p");
    // Another title opens over this one, so the picker closes with it before the arrow reopens it.
    rerender({ identityKey: "t2", sources: [remote("s1", "1080p", 3_000_000_000), remote("s2", "720p", 1)] });
    click(host.querySelector<HTMLButtonElement>(".split-button-toggle"));
    expect(chosenRow()!.textContent).toContain("1080p");
  });

  it("disables Play while loading and shows the status", () => {
    render({ sources: null });
    expect(playButton().disabled).toBe(true);
    expect(host.querySelector(".library-title-detail .loading")).not.toBeNull();
  });

  it("shows a failed read with its retry and an empty list as no playable version", () => {
    const onRetry = vi.fn();
    render({ sources: [], sourceError: "boom", onRetry });
    expect(host.querySelector(".remote-error")!.textContent).toContain("boom");
    expect(playButton().disabled).toBe(true);
    click(host.querySelector(".remote-error button"));
    expect(onRetry).toHaveBeenCalled();
    rerender({ sources: [] });
    expect(host.querySelector(".library-title-detail")!.textContent).toContain("No playable version");
    expect(playButton().disabled).toBe(true);
  });

  it("drops an explicit version when it becomes unplayable", () => {
    const sources = [remote("s1", "Large", 30), remote("s2", "Small", 1)];
    render({ sources });
    click(host.querySelector(".split-button-toggle"));
    click(pickerRows()[1]!);
    const onPlay = rerender({ sources: [sources[0]!, { ...sources[1]!, playable: false }] });
    click(playButton());
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "s1" }));
  });

  it("shows the shared hero, the gallery in its own corner and the whole synopsis", () => {
    render({ gallery: [poster("/poster.jpg"), still("/still.jpg")], onGallery: vi.fn(), description: "A quiet film." });
    expect(host.querySelector(".hero.library-detail-hero")).not.toBeNull();
    const corner = host.querySelector<HTMLButtonElement>(".gallery-open")!;
    expect(corner.querySelector("img")?.getAttribute("src")).toBe("/poster.jpg");
    expect(corner.textContent).toContain("2 stills");
    expect(host.querySelector(".library-detail-synopsis")!.textContent).toBe("A quiet film.");
    // No disclosure and no clamp: the full text is simply read.
    expect(host.querySelector(".library-title-detail details")).toBeNull();
  });

  it("opens the one gallery overlay with the pictures it was given", () => {
    const onGallery = vi.fn();
    const images = [poster("/poster.jpg"), still("/still.jpg")];
    render({ gallery: images, onGallery });
    click(host.querySelector(".gallery-open"));
    expect(onGallery).toHaveBeenCalledWith(images, undefined);
  });

  it("falls back to the poster as the corner image when only a poster is known", () => {
    const onGallery = vi.fn();
    render({ poster: "/poster.jpg", onGallery });
    const corner = host.querySelector<HTMLButtonElement>(".gallery-open")!;
    expect(corner.querySelector("img")?.getAttribute("src")).toBe("/poster.jpg");
    expect(corner.textContent).toContain("Enlarge");
    click(corner);
    expect(onGallery).toHaveBeenCalledWith([], undefined);
  });

  it("shows no gallery trigger when nothing can be shown", () => {
    render({ sources: [], onGallery: vi.fn() });
    expect(host.querySelector(".gallery-open")).toBeNull();
    expect(host.querySelector(".library-title-detail")!.textContent).toContain("No playable version");
  });

  it("clears a broken corner image when another title opens", () => {
    render({ poster: "/missing.jpg", onGallery: vi.fn() });
    act(() => host.querySelector(".gallery-open img")!.dispatchEvent(new Event("error")));
    expect(host.querySelector("img.broken")).not.toBeNull();
    rerender({ identityKey: "second", poster: "/available.jpg", onGallery: vi.fn() });
    expect(host.querySelector("img.broken")).toBeNull();
  });

  it("lays the backdrop on the whole surface, with the hero transparent above it", () => {
    render({ description: "A quiet film." });
    const surface = host.querySelector<HTMLElement>(".library-title-detail")!;
    const hero = host.querySelector<HTMLElement>(".hero.library-detail-hero")!;
    expect(hero.style.backgroundImage).toBe("");
    // Without a backdrop the surface keeps its own gradient rather than going flat black.
    expect(surface.style.backgroundImage).toContain("linear-gradient");
    // The actions follow the synopsis on that same surface, not on a band of their own.
    expect(surface.querySelector(".library-detail-actions")).not.toBeNull();
    expect(surface.querySelector(".library-detail-synopsis")).not.toBeNull();
  });

  it("puts the chosen backdrop on the surface, not on the hero band", () => {
    render({ backdrops: ["/wide.jpg"] });
    const surface = host.querySelector<HTMLElement>(".library-title-detail")!;
    const hero = host.querySelector<HTMLElement>(".hero.library-detail-hero")!;
    expect(surface.style.backgroundImage).toContain("/wide.jpg");
    expect(hero.style.backgroundImage).toBe("");
  });

  it("draws the play, watched and open-folder controls on the lower row, with the favourite above them", () => {
    const onToggleFavorite = vi.fn();
    const onToggleWatched = vi.fn();
    const onOpenFolder = vi.fn();
    render({ sources: [remote("s1", "1080p", 1)], favorite: true, watched: false, onToggleFavorite, onToggleWatched, onOpenFolder });
    const row = lowerActions();
    expect(row.querySelector(".library-detail-play button.primary")).not.toBeNull();
    click(favoriteButton());
    expect(onToggleFavorite).toHaveBeenCalledWith(false);
    click(row.querySelector('button[aria-label="Mark watched"]'));
    expect(onToggleWatched).toHaveBeenCalled();
    click(row.querySelector('button[aria-label="Open folder"]'));
    expect(onOpenFolder).toHaveBeenCalled();
    // The star is not drawn a second time beside the actions.
    expect(row.querySelector(".watch-star")).toBeNull();
    expect(row.querySelector('button[aria-label="Remove from favorites"]')).toBeNull();
  });
});

describe("LibraryTitleDetail source picker", () => {
  it("keeps Tab navigation inside the dialog", () => {
    render({ sources: [remote("s1", "Large", 30), remote("s2", "Small", 1)] });
    click(host.querySelector(".split-button-toggle"));
    const controls = [...document.querySelectorAll<HTMLButtonElement>(".library-source-card button")];
    controls.at(-1)!.focus();
    act(() => controls.at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(controls[0]);
    act(() => controls[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(controls.at(-1));
  });

  it("focuses the chosen version when the picker reopens", () => {
    render({ sources: [remote("s1", "Large", 30), remote("s2", "Small", 1)] });
    click(host.querySelector(".split-button-toggle"));
    click(pickerRows()[1]!);
    click(host.querySelector(".split-button-toggle"));
    expect(document.activeElement).toBe(pickerRows()[1]);
  });

  it("closes on Escape and returns focus to the arrow", () => {
    render({ sources: [remote("s1", "1080p", 3_000_000_000), remote("s2", "720p", 1)] });
    const arrow = host.querySelector<HTMLButtonElement>(".split-button-toggle")!;
    click(arrow);
    expect(document.querySelector(".library-source-card")).not.toBeNull();
    expect(document.activeElement).toBe(pickerRows()[0]);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(document.querySelector(".library-source-card")).toBeNull();
    expect(document.activeElement).toBe(arrow);
  });
});

describe("LibraryTitleDetail saved position", () => {
  const twoVersions = () => [remote("s1", "720p", 1_000_000_000), remote("s2", "1080p", 3_000_000_000)];

  it("shows a clamped progress bar and the formatted position for a known length", () => {
    render({ sources: [remote("s1", "1080p", 1)], progress: { position: 90, duration: 60, sourceKey: key("s1") } });
    const bar = host.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.querySelector<HTMLElement>("i")!.style.width).toBe("100%");
    expect(savedText()).toBe("1:30 of 1:00");
  });

  it("shows a completed position as a full bar", () => {
    render({ sources: [remote("s1", "1080p", 1)], progress: { position: 3600, duration: 3600, sourceKey: key("s1") } });
    expect(host.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("100");
    expect(savedText()).toBe("1:00:00 of 1:00:00");
  });

  it("writes the position without a bar when the length is unknown or unusable", () => {
    render({ sources: [remote("s1", "1080p", 1)], progress: { position: 120, duration: 0, sourceKey: key("s1") } });
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    expect(savedText()).toBe("Saved position: 2:00");
    rerender({ sources: [remote("s1", "1080p", 1)], progress: { position: 120, duration: Number.NaN, sourceKey: key("s1") } });
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    expect(savedText()).toBe("Saved position: 2:00");
  });

  it("hides a zero, negative or non-finite position and a position of another source", () => {
    render({ sources: [remote("s1", "1080p", 1)], progress: { position: 0, duration: 100, sourceKey: key("s1") } });
    expect(saved()).toBeNull();
    rerender({ sources: [remote("s1", "1080p", 1)], progress: { position: -70, duration: 100, sourceKey: key("s1") } });
    expect(saved()).toBeNull();
    rerender({ sources: [remote("s1", "1080p", 1)], progress: { position: Number.NaN, duration: 100, sourceKey: key("s1") } });
    expect(saved()).toBeNull();
    rerender({ sources: [remote("s1", "1080p", 1)], progress: { position: 120, duration: 600, sourceKey: "somewhere-else" } });
    expect(saved()).toBeNull();
  });

  it("plays the chosen source ordinarily and starts it over from the same source", () => {
    const onPlay = vi.fn();
    render({ sources: twoVersions(), progress: { position: 120, duration: 3600, sourceKey: key("s2") }, onPlay });
    click(playButton());
    expect(onPlay.mock.calls.at(-1)![1]).toBeUndefined();
    expect(onPlay.mock.calls.at(-1)![0]).toEqual(expect.objectContaining({ sourceId: "s2" }));
    click(startOverButton());
    expect(onPlay.mock.calls.at(-1)![1]).toBe(true);
    expect(onPlay.mock.calls.at(-1)![0]).toEqual(expect.objectContaining({ sourceId: "s2" }));
  });

  it("offers neither control while nothing is saved", () => {
    render({ sources: [remote("s1", "1080p", 1)], onClearProgress: vi.fn().mockResolvedValue(true) });
    expect(saved()).toBeNull();
    expect(startOverButton()).toBeNull();
  });

  it("clears the selected source, disables the button while pending and hides the position on success", async () => {
    const held = deferred<boolean>();
    const onClearProgress = vi.fn(() => held.promise);
    render({ sources: twoVersions(), progress: { position: 120, duration: 3600, sourceKey: key("s2") }, onClearProgress });
    await act(async () => clearButton()!.click());
    expect(onClearProgress).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "s2" }));
    expect(clearButton()!.disabled).toBe(true);
    await act(async () => { held.resolve(true); await Promise.resolve(); });
    await flush();
    expect(saved()).toBeNull();
  });

  it("shows a new saved position after playback following a clear", async () => {
    const sources = [remote("s1", "1080p", 1)];
    render({ sources, progress: { position: 120, duration: 3600, sourceKey: key("s1") }, onClearProgress: vi.fn().mockResolvedValue(true) });
    await clickAsync(clearButton());
    expect(saved()).toBeNull();
    rerender({ sources, progress: { position: 60, duration: 3600, sourceKey: key("s1") } });
    expect(savedText()).toBe("1:00 of 1:00:00");
  });

  it("does not hide another title sharing a provider's version id after a late clear", async () => {
    const held = deferred<boolean>();
    const sources = [remote("s1", "1080p", 1)];
    render({ sources, progress: { position: 120, duration: 3600, sourceKey: key("s1") }, onClearProgress: () => held.promise });
    await act(async () => clearButton()!.click());
    rerender({ identityKey: "another-title", sources, progress: { position: 60, duration: 300, sourceKey: key("s1") } });
    await act(async () => { held.resolve(true); });
    expect(savedText()).toBe("1:00 of 5:00");
  });

  it("keeps the position when the write fails", async () => {
    const onClearProgress = vi.fn().mockResolvedValue(false);
    render({ sources: [remote("s1", "1080p", 1)], progress: { position: 120, duration: 3600, sourceKey: key("s1") }, onClearProgress });
    await clickAsync(clearButton());
    expect(saved()).not.toBeNull();
    expect(clearButton()!.disabled).toBe(false);
  });

  it("does not erase another source's position when the selection changes while clearing", async () => {
    const held = deferred<boolean>();
    render({ sources: twoVersions(), progress: { position: 120, duration: 3600, sourceKey: key("s2") }, onClearProgress: () => held.promise });
    await act(async () => clearButton()!.click());
    rerender({ sources: [remote("s1", "720p", 5_000_000_000), remote("s2", "1080p", 3_000_000_000)], progress: { position: 30, duration: 300, sourceKey: key("s1") } });
    await act(async () => { held.resolve(true); await Promise.resolve(); });
    await flush();
    expect(saved()).not.toBeNull();
    expect(savedText()).toBe("0:30 of 5:00");
  });
});

describe("LibraryTitleDetail save to library", () => {
  it("shows no save action unless the caller asks for one", () => {
    render();
    expect(host.textContent).not.toContain("To library");
  });

  it("queues the version the selector currently holds, not the largest default", () => {
    const onSaveToLibrary = vi.fn();
    render({ sources: [remote("s1", "720p", 1_000_000_000), remote("s2", "1080p", 3_000_000_000)], onSaveToLibrary });
    click(host.querySelector<HTMLButtonElement>(".split-button-toggle"));
    click(pickerRows()[1]!);
    const save = [...host.querySelectorAll<HTMLButtonElement>(".library-detail-actions button")].find((button) => button.textContent?.includes("To library"))!;
    expect(save.disabled).toBe(false);
    click(save);
    expect(onSaveToLibrary).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "s1" }));
  });

  it("holds the action back while no version is selected", () => {
    render({ sources: [], onSaveToLibrary: vi.fn() });
    const save = [...host.querySelectorAll<HTMLButtonElement>(".library-detail-actions button")].find((button) => button.textContent?.includes("To library"))!;
    expect(save.disabled).toBe(true);
  });
});

describe("LibraryTitleDetail favourite and action row", () => {
  const chipsRow = () => host.querySelector(".library-detail-chips");
  const titleChips = (kind: string) => <TitleChips kind={kind} trailer={null} links={[]} onTrailer={vi.fn()} secureMode/>;
  const versions = () => [remote("s1", "720p", 1_000_000_000), remote("s2", "1080p", 3_000_000_000)];
  const saved = { position: 120, duration: 3600, sourceKey: key("s2") };

  it("leads the caller's own chip row with the favourite, and keeps its own semantics", () => {
    const onToggleFavorite = vi.fn();
    render({ chips: titleChips("One film"), favorite: true, onToggleFavorite });
    const row = chipsRow()!;
    const star = favoriteButton()!;
    // The star comes first and the caller's own chips follow it, still the shared component's row.
    expect(row.firstElementChild).toBe(star);
    expect(star.nextElementSibling).toBe(row.querySelector(".title-chips"));
    expect(star.classList.contains("watch-star")).toBe(true);
    expect(star.classList.contains("on")).toBe(true);
    expect(star.getAttribute("aria-pressed")).toBe("true");
    expect(star.getAttribute("aria-label")).toBe("Remove from favorites");
    expect(star.title).toBe("Remove from favorites");
    click(star);
    expect(onToggleFavorite).toHaveBeenCalledWith(false);
  });

  it("draws the same star off and disabled, and no row at all when there is nothing to put in it", () => {
    const onToggleFavorite = vi.fn();
    render({ favorite: false, onToggleFavorite });
    const star = favoriteButton()!;
    expect(star.classList.contains("on")).toBe(false);
    expect(star.getAttribute("aria-pressed")).toBe("false");
    expect(star.getAttribute("aria-label")).toBe("Add to favorites");
    click(star);
    expect(onToggleFavorite).toHaveBeenCalledWith(true);
    // An owner that cannot star the title right now keeps the control, disabled, in the same place.
    rerender({ favorite: true, onToggleFavorite, favoriteDisabled: true });
    expect(favoriteButton()!.disabled).toBe(true);
    // Chips without a favourite draw the chips alone; neither of the two draws no row at all.
    rerender({ chips: titleChips("One film") });
    expect(chipsRow()).not.toBeNull();
    expect(chipsRow()!.querySelector("button.watch-star")).toBeNull();
    expect(chipsRow()!.querySelector(".title-chips")).not.toBeNull();
    rerender({});
    expect(chipsRow()).toBeNull();
  });

  it("starts the selected version over from its own icon action, never through the progress reset", () => {
    const onPlay = vi.fn();
    const onClearProgress = vi.fn();
    render({ sources: versions(), progress: saved, onPlay, onClearProgress });
    const start = startOverButton()!;
    expect(start.textContent).toBe("");
    expect(start.querySelector("svg")).not.toBeNull();
    expect(start.title).toBe("Play from the start");
    click(start);
    expect(onPlay.mock.calls.at(-1)![1]).toBe(true);
    expect(onPlay.mock.calls.at(-1)![0]).toEqual(expect.objectContaining({ sourceId: "s2" }));
    // The two controls stay distinct: the reset forgets the position and is never the way to play.
    expect(onClearProgress).not.toHaveBeenCalled();
    expect(clearButton()).not.toBe(start);
    expect(clearButton()!.getAttribute("aria-label")).toBe("Forget progress");
    expect(lowerActions().querySelector('button[aria-label="Play from the start"]')).toBe(start);
  });

  it("keeps every lower action's callback, name and label, and the play text", () => {
    const onSaveToLibrary = vi.fn();
    const onToggleWatched = vi.fn();
    const onOpenFolder = vi.fn();
    render({ sources: versions(), onSaveToLibrary, watched: true, onToggleWatched, onOpenFolder });
    const action = (name: string) => lowerActions().querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
    // A labelled action keeps its own name, so hiding the label at a narrow width cannot rename it.
    for (const [name, className] of [["To library", "To library"], ["Open folder", "Open folder"]] as const) {
      const button = action(name);
      expect(button.title).toBe(className);
      expect(button.querySelector(".library-detail-action-label")!.textContent).toBe(className);
    }
    const watched = action("Mark unwatched");
    expect(watched.getAttribute("aria-pressed")).toBe("true");
    expect(watched.querySelector(".library-detail-action-label")).toBeNull();
    click(action("To library"));
    expect(onSaveToLibrary).toHaveBeenCalled();
    click(watched);
    expect(onToggleWatched).toHaveBeenCalled();
    click(action("Open folder"));
    expect(onOpenFolder).toHaveBeenCalled();
    expect(playButton().textContent).toContain("Play");
  });
});

describe("LibraryTitleDetail supplementary source groups", () => {
  const group = (over: Partial<LibrarySourceGroup> = {}): LibrarySourceGroup =>
    ({ key: "addon:torrentio", kind: "addon", name: "Torrentio", status: "loaded", streams: [], error: "", ...over });
  const panel = (groups: LibrarySourceGroup[], retry = vi.fn()) => ({ groups, retry });
  const addonGroup = (streams: Stream[]) => panel([group({ streams })]);

  it("offers the arrow beside a single native version, keeps it the default and names the group still out", () => {
    const native = remote("n1", "1080p", 2_000_000_000);
    const { onPlay } = render({ sources: [native], defaultSources: [native], sourceGroups: panel([group({ status: "loading" })]) });
    expect(host.querySelector(".split-button-toggle")).not.toBeNull();
    click(playButton());
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "n1" }));
    click(host.querySelector(".split-button-toggle"));
    expect(pickerRows()).toHaveLength(1);
    expect(chosenRow()!.textContent).toContain("1080p");
    expect(document.querySelector(".library-source-card")!.textContent).toContain("Asking the other sources");
  });

  it("offers the arrow with no native version at all, but nothing to play", () => {
    render({ sources: [], defaultSources: [], sourceGroups: panel([group({ status: "loading" })]) });
    expect(host.querySelector(".split-button-toggle")).not.toBeNull();
    expect(playButton().disabled).toBe(true);
    click(host.querySelector(".split-button-toggle"));
    expect(pickerRows()).toHaveLength(0);
    expect(document.querySelector(".library-source-card")!.textContent).toContain("Asking the other sources");
  });

  it("sums seven libraries that found nothing into one line and keeps a failure's own retry", () => {
    const retry = vi.fn();
    const many = Array.from({ length: 7 }, (_, index) => group({ key: `remote:lib${index}`, kind: "remote", name: `Library ${index}`, provider: "jellyfin", streams: [] }));
    const failed = group({ key: "remote:bad", kind: "remote", name: "Second", provider: "jellyfin", status: "error", error: "Second is offline" });
    render({ sources: [], defaultSources: [], sourceGroups: panel([...many, failed, group({ key: "remote:pending", kind: "remote", name: "Late", provider: "jellyfin", status: "loading" })], retry) });
    click(host.querySelector(".split-button-toggle"));
    const card = document.querySelector<HTMLElement>(".library-source-card")!;
    // Seven silent libraries are one fact: the list says it once, per-library notes and all.
    expect([...card.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toEqual(["Asking the other sources…"]);
    expect(card.querySelectorAll(".notice")).toHaveLength(1);
    expect(card.querySelector(".notice")!.textContent).toContain("Second is offline");
    click(card.querySelector(".notice button")!);
    expect(retry).toHaveBeenCalledWith("remote:bad");
  });

  it("says once that nothing answered when every group settled empty", () => {
    const settled = [group({ status: "loaded", streams: [] }), group({ key: "remote:lib", kind: "remote", name: "Library", provider: "jellyfin", status: "loaded", streams: [] })];
    render({ sources: [], defaultSources: [], sourceGroups: panel(settled) });
    click(host.querySelector(".split-button-toggle"));
    const card = document.querySelector<HTMLElement>(".library-source-card")!;
    expect([...card.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toEqual(["No active source addon has a stream for this title."]);
  });

  it("keeps the largest native version as the default when a larger group row arrives", () => {
    const native = remote("n1", "1080p", 2_000_000_000);
    const { onPlay } = render({ sources: [native], defaultSources: [native], sourceGroups: addonGroup([addon("a1", "4K", 8_000_000_000)]) });
    click(playButton());
    expect(onPlay.mock.calls.at(-1)![0]).toEqual(expect.objectContaining({ sourceId: "n1" }));
    click(host.querySelector(".split-button-toggle"));
    expect(chosenRow()!.textContent).toContain("1080p");
    expect(pickerRows()).toHaveLength(2);
  });

  it("keeps an explicit group choice across a refresh of the same title", () => {
    const native = remote("n1", "1080p", 2_000_000_000);
    render({ sources: [native], defaultSources: [native], sourceGroups: addonGroup([addon("a1", "4K", 8_000_000_000)]) });
    click(host.querySelector(".split-button-toggle"));
    click(pickerRows().find((row) => row.textContent?.includes("Torrentio"))!);
    const onPlay = rerender({ sources: [remote("n1", "1080p", 2_000_000_000)], defaultSources: [remote("n1", "1080p", 2_000_000_000)], sourceGroups: addonGroup([addon("a1", "4K", 8_000_000_000)]) });
    click(playButton());
    expect(onPlay.mock.calls.at(-1)![0]).toEqual(expect.objectContaining({ sourceId: "a1" }));
    click(host.querySelector(".split-button-toggle"));
    expect(chosenRow()!.textContent).toContain("4K");
  });

  it("falls back to the native default when the chosen group row disappears", () => {
    const native = remote("n1", "1080p", 2_000_000_000);
    render({ sources: [native], defaultSources: [native], sourceGroups: addonGroup([addon("a1", "4K", 8_000_000_000)]) });
    click(host.querySelector(".split-button-toggle"));
    click(pickerRows().find((row) => row.textContent?.includes("Torrentio"))!);
    const onPlay = rerender({ sources: [remote("n1", "1080p", 2_000_000_000)], defaultSources: [remote("n1", "1080p", 2_000_000_000)], sourceGroups: addonGroup([]) });
    click(playButton());
    expect(onPlay.mock.calls.at(-1)![0]).toEqual(expect.objectContaining({ sourceId: "n1" }));
  });

  it("badges a native row with its provider and an addon row with its transport", () => {
    const native = remote("n1", "1080p", 2_000_000_000);
    render({ sources: [native], defaultSources: [native], sourceGroups: addonGroup([addon("a1", "4K", 8_000_000_000)]), sourceBadge: () => "Jellyfin" });
    click(host.querySelector(".split-button-toggle"));
    // The picker wears the catalogue's own tags: the caller's badge dresses a media server's row,
    // and an addon answer keeps its transport tag with its own name as the caption.
    expect(pickerRows().map((row) => row.querySelector("i")!.textContent)).toEqual(["Jellyfin", "HTTP"]);
    expect(pickerRows()[1]!.querySelector("small")!.textContent).toBe("Torrentio");
    expect(pickerRows()[1]!.textContent).toContain("8.0 GB");
  });

  it("tags a copy from another library with its own provider, never the one the detail came from", () => {
    const mine = { ...remote("n1", "1080p", 2_000_000_000), provider: "emby" as const, libraryName: "My library" };
    const other = { ...remote("v1", "Another copy", 8_000_000_000), provider: "jellyfin" as const, libraryName: "Second",
      remoteItem: { libraryId: "other", itemId: "9", mediaSourceId: "v1", progressKey: "k" } };
    const copy = (provider: MediaServerProvider, streams: Stream[]) => panel([{ key: "remote:other", kind: "remote", name: "Second", provider, status: "loaded", streams, error: "" }]);
    render({ sources: [mine], defaultSources: [mine], sourceGroups: copy("jellyfin", [other]), sourceBadge: () => "Emby" });
    click(host.querySelector(".split-button-toggle"));
    // An Emby detail offering a Jellyfin copy: the caller's badge is a fallback for a row that
    // names no transport of its own, and it never overrides the row's own provider.
    expect(pickerRows().map((row) => row.querySelector("i")!.textContent)).toEqual(["Emby", "Jellyfin"]);
    expect(pickerRows().map((row) => row.querySelector("small")!.textContent)).toEqual(["Emby · My library", "Jellyfin · Second"]);

    const native = { ...remote("n1", "1080p", 2_000_000_000), provider: "jellyfin" as const, libraryName: "My library" };
    const foreign = { ...remote("v1", "Another copy", 8_000_000_000), provider: "emby" as const, libraryName: "Second",
      remoteItem: { libraryId: "other", itemId: "9", mediaSourceId: "v1", progressKey: "k" } };
    rerender({ sources: [native], defaultSources: [native], sourceGroups: copy("emby", [foreign]), sourceBadge: () => "Jellyfin" });
    click(host.querySelector(".split-button-toggle"));
    expect(pickerRows().map((row) => row.querySelector("i")!.textContent)).toEqual(["Jellyfin", "Emby"]);
    expect(pickerRows().map((row) => row.querySelector("small")!.textContent)).toEqual(["Jellyfin · My library", "Emby · Second"]);
  });

  it("shows an addon answer with a quality name and a long file name exactly as the catalogue does", () => {
    const long = addon("a1", "FullHD", 8_000_000_000);
    long.behaviorHints = { ...long.behaviorHints, filename: "A.Very.Long.Release.Name.2026.2160p.WEB-DL.DDP.mkv" };
    render({ sources: [remote("n1", "1080p", 2_000_000_000)], defaultSources: [remote("n1", "1080p", 2_000_000_000)], sourceGroups: addonGroup([long]) });
    click(host.querySelector(".split-button-toggle"));
    const chosen = pickerRows()[1]!;
    expect(chosen.querySelector("i")!.textContent).toBe("HTTP");
    expect(chosen.querySelector("strong")!.textContent).toBe("FullHD");
    expect(chosen.querySelector("small")!.textContent).toBe("Torrentio");
    expect(chosen.textContent).not.toContain("A.Very.Long");
  });

  it("keeps two libraries' rows apart even when they share a media-source id", () => {
    const mine = { ...remote("v1", "Mine", 2_000_000_000), sourceId: "native-v1" };
    const other = { ...remote("v1", "Another library", 8_000_000_000), sourceId: "other-v1",
      remoteItem: { libraryId: "other", itemId: "9", mediaSourceId: "v1", progressKey: "k" } };
    render({ sources: [mine], defaultSources: [mine], sourceGroups: panel([{ key: "remote:other", kind: "remote", name: "Second", provider: "jellyfin", status: "loaded", streams: [other], error: "" }]) });
    click(host.querySelector(".split-button-toggle"));
    click(pickerRows().find((row) => row.textContent?.includes("Another library"))!);
    click(playButton());
    expect(host.querySelector(".library-detail-play button.primary")).toBeDefined();
    const onPlay = rerender({ sources: [mine], defaultSources: [mine], sourceGroups: panel([{ key: "remote:other", kind: "remote", name: "Second", provider: "jellyfin", status: "loaded", streams: [other], error: "" }]) });
    click(playButton());
    expect(onPlay.mock.calls.at(-1)![0]).toEqual(expect.objectContaining({ sourceId: "other-v1" }));
  });

  it("never silently defaults to a group row when the native default is explicitly null", () => {
    const only = addon("a1", "4K", 8_000_000_000);
    const { onPlay } = render({ sources: [], defaultSources: null, sourceGroups: addonGroup([only]) });
    expect(host.querySelector(".split-button-toggle")).not.toBeNull();
    expect(playButton().disabled).toBe(true);
    click(host.querySelector(".split-button-toggle"));
    expect(chosenRow()).toBeUndefined();
    // The viewer can still pick the row a group answered themselves.
    click(pickerRows()[0]!);
    click(playButton());
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "a1" }));
  });

  it("keeps native rows first and ranks group rows by the size their text reported", () => {
    const native = remote("n1", "1080p", 1_000_000_000);
    const hinted = addon("a1", "2 GB hint", 2_000_000_000);
    const text = { ...addon("a2", "20 GB text"), title: "\ud83d\udcbe 20 GB" };
    const { onPlay } = render({ sources: [native], defaultSources: [native], sourceGroups: addonGroup([hinted, text]) });
    click(playButton());
    expect(onPlay.mock.calls.at(-1)![0]).toEqual(expect.objectContaining({ sourceId: "n1" }));
    click(host.querySelector(".split-button-toggle"));
    expect(pickerRows()[0]!.textContent).toContain("1080p");
    expect(pickerRows()[1]!.textContent).toContain("20 GB text");
    expect(pickerRows()[2]!.textContent).toContain("2 GB hint");
  });

  it("shows a group that failed with its own retry, and asks only that one again", () => {
    const retry = vi.fn();
    const native = remote("n1", "1080p", 2_000_000_000);
    render({ sources: [native], defaultSources: [native], sourceGroups: panel([group({ status: "error", error: "Torrentio is down" })], retry) });
    click(host.querySelector(".split-button-toggle"));
    const failed = document.querySelector<HTMLElement>(".library-source-card .notice")!;
    expect(failed.textContent).toContain("Torrentio is down");
    click(failed.querySelector("button"));
    expect(retry).toHaveBeenCalledWith("addon:torrentio");
  });

  it("filters the unified list by source class and language", () => {
    const native = remote("n1", "1080p", 2_000_000_000);
    render({ sources: [native], defaultSources: [native], sourceGroups: addonGroup([addon("a1", "4K", 8_000_000_000)]) });
    click(host.querySelector(".split-button-toggle"));
    const addonField = document.querySelectorAll<HTMLSelectElement>(".library-source-card .stream-filters select")[0]!;
    expect([...addonField.options].map((option) => option.textContent)).toEqual([
      "All sources (2)", "Local files (1)", "Torrentio (1)",
    ]);
    act(() => { addonField.value = "addon:torrentio"; addonField.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(pickerRows()).toHaveLength(1);
    expect(pickerRows()[0]!.textContent).toContain("Torrentio");
  });

  it("keeps the picked source in the menu when the language left it no row, and offers the way back", () => {
    const native = remote("n1", "1080p English", 1_000_000_000);
    const czech = addon("a1", "4K CZ dabing", 8_000_000_000);
    const english = addon("a2", "4K English", 8_000_000_000);
    render({ sources: [native], defaultSources: [native], sourceGroups: addonGroup([czech]) });
    click(host.querySelector(".split-button-toggle"));
    const fields = () => document.querySelectorAll<HTMLSelectElement>(".library-source-card .stream-filters select");
    act(() => { fields()[0]!.value = "addon:torrentio"; fields()[0]!.dispatchEvent(new Event("change", { bubbles: true })); });
    act(() => { fields()[1]!.value = "cs"; fields()[1]!.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(pickerRows()).toHaveLength(1);
    // The group answers again without its Czech row: the menu must still hold the value the list is
    // filtered by, or the browser would show "All sources" over an empty, still-filtered list.
    rerender({ sources: [remote("n1", "1080p English", 1_000_000_000)], defaultSources: [remote("n1", "1080p English", 1_000_000_000)], sourceGroups: addonGroup([english]) });
    expect(pickerRows()).toHaveLength(0);
    const source = () => document.querySelector<HTMLSelectElement>(".library-source-card .stream-filters select")!;
    expect(source().value).toBe("addon:torrentio");
    expect([...source().options].map((option) => option.textContent)).toEqual(["All sources (0)", "Torrentio (0)"]);
    const notice = document.querySelector<HTMLElement>(".library-source-card [role=status]")!;
    expect(notice.textContent).toContain("None of the 1 sources matches the filter.");
    const clear = [...document.querySelectorAll<HTMLButtonElement>(".library-source-card button")].find((button) => button.textContent === "Clear filters")!;
    expect(clear).toBeDefined();
    click(clear);
    expect(source().value).toBe("");
    expect(fields()[1]!.value).toBe("");
    expect(pickerRows()).toHaveLength(2);
  });
});

function PendingGroupControl() {
  const [pending, setPending] = useState(false);
  const groups: LibrarySourceGroup[] = [{ key: "addon:a", kind: "addon", name: "Torrentio", status: pending ? "loading" : "error", streams: [], error: "gone" }];
  return <LibraryTitleDetail identityKey="t1" title="One" sources={[remote("s1", "1080p")]} onPlay={vi.fn()}
    sourceGroups={{ groups, retry: () => setPending(true) }}/>;
}

it("keeps keyboard focus inside the picker after a retry removes its button", () => {
  const rects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 40)] as unknown as DOMRectList);
  try {
    act(() => root.render(<PendingGroupControl/>));
    click(host.querySelector(".split-button-toggle"));
    const button = [...document.querySelectorAll<HTMLButtonElement>(".library-source-card button")].find(node => node.textContent === "Try again")!;
    button.focus();
    click(button);
    expect(document.activeElement).toBe(document.body);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
  } finally { rects.mockRestore(); }
});


it("shows deduplicated addon notices as messages without turning them into sources", () => {
  const native = remote("native", "Native version", 100);
  const notice: Stream = { sourceId: "notice-one", kind: "unsupported", playable: false,
    addonName: "Provider", title: "Your subscription has expired" };
  render({ sources: [native], sourceGroups: { retry: vi.fn(), groups: [
    { key: "addon:one", kind: "addon", name: "Provider", status: "loaded", error: "", streams: [notice] },
    { key: "addon:two", kind: "addon", name: "Provider copy", status: "loaded", error: "", streams: [{ ...notice, sourceId: "notice-two" }] },
  ] } });
  click(host.querySelector(".split-button-toggle"));
  const notices = document.querySelectorAll(".library-source-card .notice");
  expect(notices).toHaveLength(1);
  expect(notices[0]!.textContent).toContain("Provider");
  expect(notices[0]!.textContent).toContain("Your subscription has expired");
  expect(pickerRows()).toHaveLength(1);
  expect(chosenRow()!.textContent).toContain("Native version");
});

describe("LibraryTitleDetail play split", () => {
  it("gives the arrow the accent as well, so the whole split is one control", () => {
    render({ sources: [remote("s1", "1080p", 3_000_000_000), remote("s2", "720p", 1)] });
    const arrow = host.querySelector<HTMLButtonElement>(".library-detail-play button.split-button-toggle")!;
    expect(arrow.classList.contains("primary")).toBe(true);
    expect(playButton().classList.contains("primary")).toBe(true);
  });
});

describe("LibraryTitleDetail device download", () => {
  const local: Stream = { sourceId: "l1", kind: "library", playable: true, name: "Heat", localPath: "Films/Heat.mkv" };
  const deviceButton = () => host.querySelector<HTMLButtonElement>('.library-detail-actions button[aria-label="Save to this device"]');
  const capabilities = (downloadToDevice: boolean) =>
    ({ rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary: true, downloadToDevice });

  it("saves the selected file to the device when the caller offers it", () => {
    const onDownloadToDevice = vi.fn();
    render({ sources: [local], onDownloadToDevice });
    expect(deviceButton()).not.toBeNull();
    click(deviceButton());
    expect(onDownloadToDevice).toHaveBeenCalledWith(local);
  });

  it("hides it when the caller passes no device path at all", () => {
    render({ sources: [local] });
    expect(deviceButton()).toBeNull();
  });

  it("hides it for a remote original and for a source the account may not save", () => {
    const onDownloadToDevice = vi.fn();
    render({ sources: [remote("s1", "1080p", 1)], onDownloadToDevice });
    expect(deviceButton()).toBeNull();
    rerender({ sources: [{ ...local, capabilities: capabilities(false) }], onDownloadToDevice });
    expect(deviceButton()).toBeNull();
    rerender({ sources: [{ ...local, capabilities: capabilities(true) }], onDownloadToDevice });
    expect(deviceButton()).not.toBeNull();
  });
});

describe("LibraryTitleDetail save split", () => {
  it("keeps one save button without an elsewhere action and splits when the caller offers one", () => {
    const onSaveToLibrary = vi.fn();
    render({ sources: [remote("s1", "1080p", 1)], onSaveToLibrary });
    expect(host.querySelector(".library-detail-actions .split-button")).toBeNull();
    expect(lowerActions().querySelector('button[aria-label="To library"]')).not.toBeNull();

    const onSaveElsewhere = vi.fn();
    const stream = remote("s1", "1080p", 1);
    rerender({ sources: [stream], onSaveToLibrary, onSaveElsewhere });
    const split = lowerActions().querySelector(".split-button")!;
    const [main, arrow] = [...split.querySelectorAll("button")];
    click(main!);
    expect(onSaveToLibrary).toHaveBeenCalled();
    expect(onSaveElsewhere).not.toHaveBeenCalled();
    click(arrow!);
    expect(onSaveElsewhere).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "s1" }));
  });
});
