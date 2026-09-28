import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SaveTargetFields } from "./SaveTargetFields";
import { setLocale } from "./i18n";
import type { AddonDownloadSettings, LibraryType, LibraryView } from "./types";
import type { SaveTarget } from "./save-target";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const library = (id: string, name: string, type: LibraryType, extra: Partial<LibraryView> = {}): LibraryView => ({
  id, name, type, root: `/media/${name}`, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: true, autoScanMetadata: true, unreachable: false, readOnly: false, defaultMovie: false, defaultSeries: false,
  titles: 0, files: 0, bytes: 0, ...extra,
});

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  fetchMock = vi.fn().mockResolvedValue(json({ path: "", folders: [] }));
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

const settle = async () => { await act(async () => { await Promise.resolve(); }); };
const click = async (element: Element) => { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };

let latest: SaveTarget | null = null;
function Harness({ libraries, rule }: { libraries: LibraryView[]; rule: AddonDownloadSettings | undefined }) {
  const [value, setValue] = useState<SaveTarget | null>(null);
  latest = value;
  return <SaveTargetFields kind="movie" title="Dune" libraries={libraries} rule={rule} value={value} onChange={setValue}/>;
}

it("starts from the rule and walks the chosen library with qualified wire paths", async () => {
  const libraries = [library("lib_films", "Films", "movie"), library("lib_studio", "Studio", "movie")];
  const rule: AddonDownloadSettings = { movie: { subfolder: "", layout: "structured", libraryId: "lib_films" }, series: { subfolder: "", layout: "structured" } };
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(url.includes("path=lib_films") ? json({ path: "lib_films", folders: [{ path: "lib_films/Kino", name: "Kino" }] }) : json({ path: "", folders: [] })));
  await act(async () => { root.render(<Harness libraries={libraries} rule={rule}/>); });
  await settle();

  expect(host.textContent).toContain("Films › Dune");

  const custom = host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!;
  await click(custom);
  await settle();
  expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("path=lib_films");

  const kino = [...host.querySelectorAll(".move-list button")].find((button) => button.textContent?.includes("Kino"))!;
  await click(kino);
  await settle();
  expect(host.querySelector(".save-target-preview")?.textContent).toContain("Films › Kino › Dune");

  const chips = [...host.querySelectorAll(".move-libraries button")];
  expect(chips.map((chip) => chip.textContent)).toEqual(["Films", "Studio"]);
});

it("disables the manual choice when no library takes the kind", async () => {
  const libraries = [library("lib_shows", "Shows", "series")];
  await act(async () => { root.render(<Harness libraries={libraries} rule={undefined}/>); });
  await settle();

  const custom = host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!;
  expect(custom.disabled).toBe(true);
  expect(host.textContent).toContain("No library you can write to takes this kind of title.");
});

it("keeps the subfolder relative when the one visible library answers with qualified paths", async () => {
  // Two libraries exist, this account sees one: the server still names the library in paths.
  const libraries = [library("lib_films", "Films", "movie")];
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(url.includes("path=lib_films") ? json({ path: "lib_films", folders: [{ path: "lib_films/Kino", name: "Kino" }] }) : json({ path: "", folders: [] })));
  await act(async () => { root.render(<Harness libraries={libraries} rule={undefined}/>); });
  await settle();

  await click(host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!);
  await settle();
  const kino = [...host.querySelectorAll(".move-list button")].find((button) => button.textContent?.includes("Kino"))!;
  await click(kino);
  await settle();

  expect(latest?.subfolder).toBe("Kino");
  expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("path=lib_films%2FKino");
  expect([...host.querySelectorAll(".move-crumbs button")].map((button) => button.textContent?.trim())).toEqual(["Films", "Kino"]);
});
