import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MoveDialog } from "./MoveDialog";
import type { LibraryType, LibraryView } from "./types";
import { setLocale } from "./i18n";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const folders = (...names: string[]) => json({ path: "", folders: names.map((name) => ({ path: name, name })) });
const settle = async () => { await act(async () => { await Promise.resolve(); }); };
const confirmButton = () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Move here"))!;
const click = async (element: Element) => { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };

const open = async (path: string, label: string, onMoved = vi.fn()) => {
  await act(async () => { root.render(<MoveDialog path={path} label={label} onClose={vi.fn()} onMoved={onMoved}/>); });
  await settle();
  return onMoved;
};

it("opens in the folder the item sits in and refuses a move that changes nothing", async () => {
  fetchMock.mockResolvedValue(folders("Season 1", "Season 2"));
  await open("Friends/pilot.mkv", "pilot");
  expect(fetchMock.mock.calls[0]?.[0]).toContain("path=Friends");
  expect(confirmButton().disabled).toBe(true);
  expect(host.textContent).toContain("The item is already in this folder.");
});

it("a folder cannot be moved into itself", async () => {
  fetchMock.mockResolvedValue(folders("Friends", "Archive"));
  await open("Friends", "Friends");
  const intoItself = [...host.querySelectorAll(".move-list button")].find((button) => button.textContent?.includes("Friends"))!;
  expect((intoItself as HTMLButtonElement).disabled).toBe(true);
});

it("moves into the picked folder and reports the new path", async () => {
  fetchMock.mockImplementation((url: string, options?: RequestInit) =>
    Promise.resolve(options?.method === "POST" ? json({ path: "Archive/pilot.mkv" }) : folders("Archive")));
  const onMoved = await open("Friends/pilot.mkv", "pilot");

  const archive = [...host.querySelectorAll(".move-list button")].find((button) => button.textContent?.includes("Archive"))!;
  await click(archive);
  await settle();
  expect(confirmButton().disabled).toBe(false);

  await click(confirmButton());
  await settle();
  const post = fetchMock.mock.calls.find(([, options]) => (options as RequestInit | undefined)?.method === "POST")!;
  expect(post[0]).toBe("/api/library/move");
  expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ path: "Friends/pilot.mkv", folder: "Archive" });
  expect(onMoved).toHaveBeenCalledWith("Archive/pilot.mkv");
});

const library = (id: string, name: string, type: LibraryType, extra: Partial<LibraryView> = {}): LibraryView => ({
  id, name, type, root: `/media/${name}`, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: true, unreachable: false, readOnly: false, defaultMovie: false, defaultSeries: false,
  titles: 0, files: 0, bytes: 0, ...extra,
});

it("with several libraries it offers the ones that take this kind and moves into one", async () => {
  fetchMock.mockImplementation((url: string, options?: RequestInit) =>
    Promise.resolve(options?.method === "POST" ? json({ path: "lib_cccccccc/01.mkv" }) : folders("Archive")));
  const libraries = [
    library("lib_aaaaaaaa", "Films", "movie"),
    library("lib_bbbbbbbb", "Series", "series"),
    library("lib_cccccccc", "Mixed", "mixed"),
    library("lib_dddddddd", "Offline", "mixed", { unreachable: true }),
  ];
  const onMoved = vi.fn();
  await act(async () => {
    root.render(<MoveDialog path="lib_aaaaaaaa/Show/01.mkv" label="01" itemType="movie" libraries={libraries} onClose={vi.fn()} onMoved={onMoved}/>);
  });
  await settle();

  const chips = [...host.querySelectorAll(".move-libraries button")];
  expect(chips.map((chip) => chip.textContent)).toEqual(["Films", "Mixed"]);
  expect(host.querySelector(".move-crumbs button")!.textContent, "the root crumb names the library").toContain("Films");

  await click(chips[1]!);
  await settle();
  expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("path=lib_cccccccc");
  expect(host.textContent).toContain("Moves into Mixed.");
  expect(confirmButton().disabled, "the library root is a destination of its own").toBe(false);

  await click(confirmButton());
  await settle();
  const post = fetchMock.mock.calls.find(([, options]) => (options as RequestInit | undefined)?.method === "POST")!;
  expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ path: "lib_aaaaaaaa/Show/01.mkv", folder: "lib_cccccccc" });
  expect(onMoved).toHaveBeenCalledWith("lib_cccccccc/01.mkv");
});

it("the library root is a destination of its own", async () => {
  fetchMock.mockResolvedValue(folders("Archive"));
  await open("Friends/pilot.mkv", "pilot");
  const rootCrumb = host.querySelector(".move-crumbs button")!;
  await click(rootCrumb);
  await settle();
  expect(confirmButton().disabled).toBe(false);
  expect(host.textContent).toContain("Moves into Library.");
});

it("queues several selected items as one copy operation", async () => {
  fetchMock.mockImplementation((url: string, options?: RequestInit) => Promise.resolve(
    options?.method === "POST" ? json({ id: "job-1" }, 202) : folders("Archive"),
  ));
  const onQueued = vi.fn();
  await act(async () => {
    root.render(<MoveDialog path="Films/one.mkv" paths={["Films/one.mkv", "Films/two.mkv"]} copy label="2 items"
      onClose={vi.fn()} onMoved={vi.fn()} onQueued={onQueued}/>);
  });
  await settle();
  await click([...host.querySelectorAll(".move-list button")].find((button) => button.textContent?.includes("Archive"))!);
  await settle();
  await click([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Copy here"))!);
  await settle();
  const post = fetchMock.mock.calls.find(([, options]) => (options as RequestInit | undefined)?.method === "POST")!;
  expect(post[0]).toBe("/api/library/ops");
  expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ op: "copy", items: ["Films/one.mkv", "Films/two.mkv"], target: "Archive" });
  expect(onQueued).toHaveBeenCalled();
});

/** The list and the action used to share one scroller, so the wheel moved the folder list and
 *  then the card, and the confirm button left the screen on the way. The chips stay under the
 *  head, the list scrolls on its own, and the action sits outside it. */
it("keeps the chips and the confirm button outside the one scrolling region", async () => {
  fetchMock.mockResolvedValue(folders("Archive"));
  const onMoved = vi.fn();
  await act(async () => {
    root.render(<MoveDialog path="lib_aaaaaaaa/Show/01.mkv" label="01" itemType="movie" onClose={vi.fn()} onMoved={onMoved}
      libraries={[library("lib_aaaaaaaa", "Films", "movie"), library("lib_cccccccc", "Mixed", "mixed")]}/>);
  });
  await settle();

  const card = host.querySelector(".move-card")!;
  const body = card.querySelector(".dialog-body")!;
  expect(card.classList.contains("dialog-split")).toBe(true);
  expect(body.querySelector(".move-list")).toBeTruthy();
  expect(body.querySelector(".move-crumbs")).toBeTruthy();
  expect(body.querySelector(".move-libraries"), "the chips pin under the head").toBeNull();
  expect(card.querySelector(".move-libraries")).toBeTruthy();
  const confirm = confirmButton();
  expect(confirm.closest(".dialog-foot"), "the action is pinned outside the scroller").toBeTruthy();
  expect(confirm.closest(".dialog-body")).toBeNull();
});
