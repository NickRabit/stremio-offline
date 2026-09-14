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
  ? { path, parent: null, entries: [] }
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
const openPicker = async (posted: Record<string, unknown>[]) => {
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
  await clickIn(picker(), "downloads");
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
