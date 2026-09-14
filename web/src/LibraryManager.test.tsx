import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LibraryManager } from "./LibraryManager";
import type { LibraryView } from "./types";
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
