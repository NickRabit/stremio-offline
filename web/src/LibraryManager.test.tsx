import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LibraryManager } from "./LibraryManager";
import type { GrantBrowse, LibraryGrant, LibraryView } from "./types";
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

const library = (over: Partial<LibraryView> = {}): LibraryView => ({
  id: "lib_ab12cd34", name: "Films", type: "movie", root: "/downloads/Films",
  enabled: true, order: 0, addedAt: "2026-09-01T00:00:00.000Z", writeArtwork: true,
  unreachable: false, readOnly: false, defaultMovie: true, defaultSeries: false,
  titles: 12, files: 27, bytes: 48_500_000_000, ...over,
});

const render = async (...rows: LibraryView[]) => {
  fetchMock.mockResolvedValue(json(rows));
  await act(async () => {
    root.render(<LibraryManager restricted onError={vi.fn()} onNotify={vi.fn()}/>);
  });
  await act(async () => { await Promise.resolve(); });
};

it("reports the size on disk, not the number of files", async () => {
  await render(library());
  // 27 files through the byte formatter rounds to "0 kB", which is what the row used to show.
  expect(host.textContent).toContain("48.5 GB");
  expect(host.textContent).not.toContain("0 kB");
});

it("a library that holds nothing yet shows no size rather than a zero", async () => {
  await render(library({ titles: 0, files: 0, bytes: 0 }));
  expect(host.textContent).toContain("0 titles");
  expect(host.textContent).toContain("—");
});

const granted: LibraryGrant = { path: "/downloads", source: "env", grantedAt: "2026-09-01T00:00:00.000Z", writable: true };
const browseAt = (path: string): GrantBrowse => path
  ? { path, parent: null, entries: [
      { name: "Films", path: `${path}/Films`, writable: true, source: "env" },
      { name: "Series", path: `${path}/Series`, writable: true, source: "env" },
    ] }
  : { path: "", parent: null, entries: [{ name: "downloads", path: "/downloads", writable: true, source: "env" }] };

/** The picker adds a library over a folder that is not on disk yet by naming it here and
 *  letting the create request make it, inside the grant the browsed folder sits in. */
const clickIn = async (scope: ParentNode, text: string) => {
  const button = [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
  expect(button, `"${text}" is on screen`).toBeTruthy();
  await act(async () => { button!.click(); await Promise.resolve(); });
};

const fillIn = async (scope: ParentNode, label: string, value: string) => {
  const input = scope.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input, `${label} is on screen`).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input!.dispatchEvent(new Event("input", { bubbles: true })); });
};

/** Opens the picker and walks into the granted folder, which is where a library is added. */
const openPicker = async (posted: Record<string, unknown>[], enter = true) => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/libraries" && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      return json(library(), 201);
    }
    if (url === "/api/libraries") return json([]);
    if (url === "/api/libraries/grants") return json([granted]);
    if (String(url).startsWith("/api/libraries/browse")) {
      return json(browseAt(new URLSearchParams(String(url).split("?")[1]).get("path") ?? ""));
    }
    if (url === "/api/libraries/preview") return json({ root: "/downloads", type: "mixed", titles: 2, identified: 0, files: 3, truncated: false });
    return json({});
  });
  await act(async () => { root.render(<LibraryManager onError={vi.fn()} onNotify={vi.fn()}/>); });
  await act(async () => { await Promise.resolve(); });
  await clickIn(host, "Add library");
  if (enter) await clickIn(picker(), "downloads");
};

const clickLabelled = async (scope: ParentNode, label: string) => {
  const button = scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, `"${label}" is on screen`).toBeTruthy();
  await act(async () => { button!.click(); await Promise.resolve(); });
};

const picker = () => host.querySelector(".library-picker-card") as HTMLElement;

it("the picker can name a folder that does not exist yet, and the create request makes it", async () => {
  const posted: Record<string, unknown>[] = [];
  await openPicker(posted);

  await fillIn(picker(), "New folder", "Films");
  await clickIn(picker(), "New folder");

  expect(host.textContent).toContain("/downloads/Films");
  expect(host.textContent).toContain("This folder does not exist yet.");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value, "the library takes the folder's name").toBe("Films");

  await clickIn(picker(), "Add library");
  expect(posted).toEqual([{ name: "Films", type: "mixed", root: "/downloads/Films", create: true }]);
});

it("a folder that is already there is used as it is", async () => {
  const posted: Record<string, unknown>[] = [];
  await openPicker(posted);

  await clickIn(picker(), "Use this folder");
  await fillIn(picker(), "Name", "Downloads");
  await clickIn(picker(), "Add library");

  expect(posted, "nothing is created when the folder exists").toEqual([{ name: "Downloads", type: "mixed", root: "/downloads" }]);
});

it("shows library details before the folder browser and keeps manual grants secondary", async () => {
  await openPicker([]);

  const sections = picker().querySelectorAll(".library-picker-section");
  expect(sections[0].textContent).toContain("Library details");
  expect(sections[1].textContent).toContain("Folder");
  expect(picker().querySelector<HTMLInputElement>('input[aria-label="Filter folders"]')?.readOnly).toBe(true);
  expect(picker().querySelector<HTMLDetailsElement>(".library-picker-advanced")?.open).toBe(false);
});

it("filters the folders in the current location", async () => {
  await openPicker([]);

  await act(async () => { picker().querySelector<HTMLInputElement>('input[aria-label="Filter folders"]')?.focus(); });
  await fillIn(picker(), "Filter folders", "seri");

  expect([...picker().querySelectorAll(".move-list button")].some((button) => button.textContent?.includes("Series"))).toBe(true);
  expect([...picker().querySelectorAll(".move-list button")].some((button) => button.textContent?.includes("Films"))).toBe(false);
});

it("a granted root is selectable from the list, without opening it first", async () => {
  const posted: Record<string, unknown>[] = [];
  await openPicker(posted, false);

  expect(picker().textContent, "nothing is preselected at the top level").toContain("Nothing selected yet.");
  await clickLabelled(picker(), "Select downloads");
  await fillIn(picker(), "Name", "Downloads");
  await clickIn(picker(), "Add library");

  expect(posted).toEqual([{ name: "Downloads", type: "mixed", root: "/downloads" }]);
});

/** Re-rooting used to hide the create control, so a library could only be moved into a
 *  folder somebody had made outside the app. */
it("re-rooting can name a folder that does not exist yet", async () => {
  const patched: Record<string, unknown>[] = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/libraries/lib_ab12cd34") && init?.method === "PATCH") {
      patched.push(JSON.parse(String(init.body)));
      return json(library({ root: "/downloads/Archive" }));
    }
    if (url === "/api/libraries") return json([library()]);
    if (url === "/api/libraries/grants") return json([granted]);
    if (String(url).startsWith("/api/libraries/browse")) {
      return json(browseAt(new URLSearchParams(String(url).split("?")[1]).get("path") ?? ""));
    }
    if (url === "/api/libraries/preview") return json({ root: "/downloads", type: "movie", titles: 2, identified: 0, files: 3, truncated: false });
    return json({});
  });
  await act(async () => { root.render(<LibraryManager onError={vi.fn()} onNotify={vi.fn()}/>); });
  await act(async () => { await Promise.resolve(); });

  await clickIn(host, "Change folder");
  await clickIn(picker(), "downloads");
  await fillIn(picker(), "New folder", "Archive");
  await clickIn(picker(), "New folder");
  await clickIn(picker(), "Move to this folder");

  expect(patched).toEqual([{ root: "/downloads/Archive", create: true }]);
});

it("the libraries can be reordered, and the order is written as a sequence", async () => {
  const patched: { id: string; body: Record<string, unknown> }[] = [];
  const rows = [library({ id: "lib_11111111", name: "Films", order: 3 }), library({ id: "lib_22222222", name: "Series", order: 7 })];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      patched.push({ id: String(url).split("/").pop()!, body: JSON.parse(String(init.body)) });
      return json(rows[0]);
    }
    return json(rows);
  });
  await act(async () => { root.render(<LibraryManager onError={vi.fn()} onNotify={vi.fn()}/>); });
  await act(async () => { await Promise.resolve(); });

  await clickLabelled(host, "Move Series up");

  expect(patched).toEqual([
    { id: "lib_22222222", body: { order: 0 } },
    { id: "lib_11111111", body: { order: 1 } },
  ]);
});

it("the picker scrolls in one place, with the selection next to the button that acts on it", async () => {
  await openPicker([], false);

  const card = picker();
  const body = card.querySelector(".dialog-body")!;
  expect(card.classList.contains("dialog-split")).toBe(true);
  expect(body.querySelector(".move-list"), "the folder list scrolls with the rest of the body").toBeTruthy();
  expect(body.querySelector(".library-picker-selection"), "the selection is not in the scroller").toBeNull();
  const footer = card.querySelector(".library-picker-footer")!;
  expect(footer.querySelector(".library-picker-selection")).toBeTruthy();
  expect(footer.querySelector("button.primary")).toBeTruthy();
});

it("the mosaic of covers can be turned off for one library", async () => {
  const patched: Record<string, unknown>[] = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") { patched.push(JSON.parse(String(init.body))); return json(library({ mosaic: false })); }
    return json([library()]);
  });
  await act(async () => { root.render(<LibraryManager onError={vi.fn()} onNotify={vi.fn()}/>); });
  await act(async () => { await Promise.resolve(); });

  const box = [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
    .find((input) => input.closest("label")?.textContent?.includes("Show a mosaic of covers"))!;
  expect(box, "the switch is on the library card").toBeTruthy();
  expect(box.checked, "a library that never said otherwise keeps its mosaic").toBe(true);
  await act(async () => { box.click(); await Promise.resolve(); });

  expect(patched).toEqual([{ mosaic: false }]);
});
