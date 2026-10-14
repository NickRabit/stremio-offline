import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LibraryTitleDetail, type LibraryTitleDetailProps } from "./LibraryTitleDetail";
import type { GalleryImage } from "./gallery-images";
import { setLocale } from "./i18n";
import type { Stream } from "./types";

const poster = (url: string): GalleryImage => ({ url, label: "Poster", shape: "poster", kind: "poster" });
const still = (url: string): GalleryImage => ({ url, label: "Still 1", shape: "wide", kind: "still" });

const remote = (id: string, name: string, bytes?: number): Stream => ({
  sourceId: id, kind: "remote", playable: true, name, provider: "jellyfin",
  remoteItem: { libraryId: "l", itemId: "i", mediaSourceId: id, progressKey: "k" },
  behaviorHints: bytes === undefined ? undefined : { videoSize: bytes },
});

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
const startOverButton = () => [...host.querySelectorAll<HTMLButtonElement>(".library-detail-actions button")].find((button) => button.textContent?.includes("Play from the start")) ?? null;
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

  it("draws the play, favorite, watched and open-folder controls on one row", () => {
    const onToggleFavorite = vi.fn();
    const onToggleWatched = vi.fn();
    const onOpenFolder = vi.fn();
    render({ sources: [remote("s1", "1080p", 1)], favorite: true, watched: false, onToggleFavorite, onToggleWatched, onOpenFolder });
    const row = host.querySelector(".library-detail-actions")!;
    expect(row.querySelector(".library-detail-play button.primary")).not.toBeNull();
    click(row.querySelector('button[aria-label="Remove from favorites"]'));
    expect(onToggleFavorite).toHaveBeenCalledWith(false);
    click(row.querySelector('button[aria-label="Mark watched"]'));
    expect(onToggleWatched).toHaveBeenCalled();
    click([...row.querySelectorAll("button")].find((button) => button.textContent?.includes("Open folder")) ?? null);
    expect(onOpenFolder).toHaveBeenCalled();
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
    render({ sources: [remote("s1", "1080p", 1)], progress: { position: 90, duration: 60, sourceKey: "s1" } });
    const bar = host.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.querySelector<HTMLElement>("i")!.style.width).toBe("100%");
    expect(savedText()).toBe("1:30 of 1:00");
  });

  it("shows a completed position as a full bar", () => {
    render({ sources: [remote("s1", "1080p", 1)], progress: { position: 3600, duration: 3600, sourceKey: "s1" } });
    expect(host.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("100");
    expect(savedText()).toBe("1:00:00 of 1:00:00");
  });

  it("writes the position without a bar when the length is unknown or unusable", () => {
    render({ sources: [remote("s1", "1080p", 1)], progress: { position: 120, duration: 0, sourceKey: "s1" } });
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    expect(savedText()).toBe("Saved position: 2:00");
    rerender({ sources: [remote("s1", "1080p", 1)], progress: { position: 120, duration: Number.NaN, sourceKey: "s1" } });
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    expect(savedText()).toBe("Saved position: 2:00");
  });

  it("hides a zero, negative or non-finite position and a position of another source", () => {
    render({ sources: [remote("s1", "1080p", 1)], progress: { position: 0, duration: 100, sourceKey: "s1" } });
    expect(saved()).toBeNull();
    rerender({ sources: [remote("s1", "1080p", 1)], progress: { position: -70, duration: 100, sourceKey: "s1" } });
    expect(saved()).toBeNull();
    rerender({ sources: [remote("s1", "1080p", 1)], progress: { position: Number.NaN, duration: 100, sourceKey: "s1" } });
    expect(saved()).toBeNull();
    rerender({ sources: [remote("s1", "1080p", 1)], progress: { position: 120, duration: 600, sourceKey: "somewhere-else" } });
    expect(saved()).toBeNull();
  });

  it("plays the chosen source ordinarily and starts it over from the same source", () => {
    const onPlay = vi.fn();
    render({ sources: twoVersions(), progress: { position: 120, duration: 3600, sourceKey: "s2" }, onPlay });
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
    render({ sources: twoVersions(), progress: { position: 120, duration: 3600, sourceKey: "s2" }, onClearProgress });
    await act(async () => clearButton()!.click());
    expect(onClearProgress).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "s2" }));
    expect(clearButton()!.disabled).toBe(true);
    await act(async () => { held.resolve(true); await Promise.resolve(); });
    await flush();
    expect(saved()).toBeNull();
  });

  it("shows a new saved position after playback following a clear", async () => {
    const sources = [remote("s1", "1080p", 1)];
    render({ sources, progress: { position: 120, duration: 3600, sourceKey: "s1" }, onClearProgress: vi.fn().mockResolvedValue(true) });
    await clickAsync(clearButton());
    expect(saved()).toBeNull();
    rerender({ sources, progress: { position: 60, duration: 3600, sourceKey: "s1" } });
    expect(savedText()).toBe("1:00 of 1:00:00");
  });

  it("does not hide another title sharing a provider's version id after a late clear", async () => {
    const held = deferred<boolean>();
    const sources = [remote("s1", "1080p", 1)];
    render({ sources, progress: { position: 120, duration: 3600, sourceKey: "s1" }, onClearProgress: () => held.promise });
    await act(async () => clearButton()!.click());
    rerender({ identityKey: "another-title", sources, progress: { position: 60, duration: 300, sourceKey: "s1" } });
    await act(async () => { held.resolve(true); });
    expect(savedText()).toBe("1:00 of 5:00");
  });

  it("keeps the position when the write fails", async () => {
    const onClearProgress = vi.fn().mockResolvedValue(false);
    render({ sources: [remote("s1", "1080p", 1)], progress: { position: 120, duration: 3600, sourceKey: "s1" }, onClearProgress });
    await clickAsync(clearButton());
    expect(saved()).not.toBeNull();
    expect(clearButton()!.disabled).toBe(false);
  });

  it("does not erase another source's position when the selection changes while clearing", async () => {
    const held = deferred<boolean>();
    render({ sources: twoVersions(), progress: { position: 120, duration: 3600, sourceKey: "s2" }, onClearProgress: () => held.promise });
    await act(async () => clearButton()!.click());
    rerender({ sources: [remote("s1", "720p", 5_000_000_000), remote("s2", "1080p", 3_000_000_000)], progress: { position: 30, duration: 300, sourceKey: "s1" } });
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
