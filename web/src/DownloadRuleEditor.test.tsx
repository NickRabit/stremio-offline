import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DownloadRuleEditor, type DownloadRuleKind } from "./DownloadRuleEditor";
import { setLocale } from "./i18n";
import type { AddonDownloadSettings, DownloadTargetSettings, LibraryView } from "./types";

const library = (over: Partial<LibraryView> = {}): LibraryView => ({
  id: "lib_a", name: "Films", type: "movie", root: "/media/films", enabled: true, order: 0,
  addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false, autoScanMetadata: false, unreachable: false,
  readOnly: false, writable: true, defaultMovie: false, defaultSeries: false, titles: 0, files: 0, bytes: 0, ...over,
});

const settings = (movie: Partial<DownloadTargetSettings> = {}, series: Partial<DownloadTargetSettings> = {}): AddonDownloadSettings => ({
  movie: { subfolder: "", layout: "structured", ...movie },
  series: { subfolder: "", layout: "structured", ...series },
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

const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
const blocks = () => [...host.querySelectorAll<HTMLElement>(".download-rule")];
const librarySelect = (index = 0) => blocks()[index]!.querySelectorAll<HTMLSelectElement>("select")[0]!;
const layoutSelect = (index = 0) => blocks()[index]!.querySelectorAll<HTMLSelectElement>("select")[1]!;
const subfolder = (index = 0) => blocks()[index]!.querySelector<HTMLInputElement>("input")!;
const preview = (index = 0) => blocks()[index]!.querySelector(".path-preview code")!.textContent;

const render = (over: Partial<Parameters<typeof DownloadRuleEditor>[0]> = {}) => {
  const onChange = vi.fn();
  const props: Parameters<typeof DownloadRuleEditor>[0] = {
    settings: settings(), libraries: [library()], disabled: false, onChange, ...over,
  };
  act(() => root.render(<DownloadRuleEditor {...props}/>));
  return { onChange, props };
};

const change = async (element: HTMLSelectElement | HTMLInputElement, value: string) => {
  await act(async () => {
    if (element instanceof HTMLSelectElement) { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); }
    else {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await flush();
};

describe("DownloadRuleEditor", () => {
  it("draws Films and Series for an addon by default, one section per requested kind", () => {
    render();
    expect(blocks().map((block) => block.querySelector("b")!.textContent)).toEqual(["Movies", "Series"]);
    renderEditor(["series"]);
    expect(blocks().map((block) => block.querySelector("b")!.textContent)).toEqual(["Series"]);
  });

  it("offers only the writable libraries of the kind, the flagged default leading the empty option", () => {
    render({ libraries: [library({ id: "lib_a", name: "Films" }), library({ id: "lib_b", name: "Box", type: "mixed" }), library({ id: "lib_c", name: "Shows", type: "series" })] });
    expect([...librarySelect(0).options].map((option) => option.textContent)).toEqual(["Default · Films", "Films", "Box"]);
    expect(librarySelect(0).value).toBe("");
  });

  it("names the caller's own default destination for a kind without a second editor", () => {
    render({ libraries: [library({ id: "lib_a", name: "Films" }), library({ id: "lib_b", name: "Box", type: "mixed" })], defaultLibraryIds: { movie: "lib_b", series: "lib_b" } });
    expect([...librarySelect(0).options].map((option) => option.textContent)).toEqual(["Default · Box", "Films", "Box"]);
  });

  it("keeps an unavailable stored selection visible and selected, even for a deleted library", () => {
    render({ settings: settings({ libraryId: "lib_gone" }), libraries: [library({ id: "lib_a", name: "Films" })] });
    expect(librarySelect(0).value).toBe("lib_gone");
    expect([...librarySelect(0).options].find((option) => option.value === "lib_gone")!.textContent)
      .toBe("lib_gone (not available right now)");
    expect(preview()).not.toContain("/media/films");
    expect(blocks()[0]!.querySelector(".folder-field code")!.textContent).toBe("/");
  });

  it("reports each edit as a patch for that kind, leaving the other rule alone", async () => {
    const { onChange } = render({ libraries: [library({ id: "lib_a", name: "Films" })] });
    await change(librarySelect(0), "lib_a");
    expect(onChange).toHaveBeenLastCalledWith("movie", { libraryId: "lib_a" });
    await change(subfolder(0), "Filmy/2024");
    expect(onChange).toHaveBeenLastCalledWith("movie", { subfolder: "Filmy/2024" });
    await change(layoutSelect(1), "flat");
    expect(onChange).toHaveBeenLastCalledWith("series", { layout: "flat" });
  });

  it("draws a path example per kind and layout, rooted at the chosen library", () => {
    render({
      libraries: [library({ id: "lib_a", name: "Films" }), library({ id: "lib_b", name: "Shows", type: "series" })],
      settings: settings({ libraryId: "lib_a", subfolder: "Filmy" }, { libraryId: "lib_b", layout: "flat" }),
    });
    expect(preview(0)).toBe("/media/films/Filmy/Movie title (2024)/Movie title (2024).mkv");
    expect(preview(1)).toBe("/media/films/Series title - S01E01 - Episode title.mkv");
  });

  it("holds every control back while disabled", () => {
    render({ disabled: true });
    expect(librarySelect(0).disabled).toBe(true);
    expect(subfolder(0).disabled).toBe(true);
    expect(layoutSelect(0).disabled).toBe(true);
  });
});

/** A tiny helper so the "one applicable kind" case reads as clearly as the default two. */
function renderEditor(kinds: readonly DownloadRuleKind[]) {
  act(() => root.render(<DownloadRuleEditor settings={settings()} libraries={[library()]} disabled={false} kinds={kinds} onChange={vi.fn()}/>));
}
