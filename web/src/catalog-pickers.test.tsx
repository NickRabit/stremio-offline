import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CatalogPicker, type CatalogPickerPrefs } from "./CatalogPicker";
import { GenrePicker } from "./GenrePicker";
import { ScopePicker } from "./ScopePicker";
import { setLocale } from "./i18n";
import type { Catalog, SearchableCatalog } from "./types";

let root: Root;
let host: HTMLDivElement;

const stubMedia = (narrow: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({
  matches: query.includes("max-width") ? narrow : false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
}));

const catalog = (addonKey: string, addonName: string, type: string, id: string, name: string, extra?: Catalog["extra"]): Catalog =>
  ({ addonKey, addonName, type, id, name, ...(extra ? { extra } : {}) });

const catalogs: Catalog[] = [
  catalog("cinemeta", "Cinemeta", "movie", "top", "Top movies"),
  catalog("cinemeta", "Cinemeta", "series", "top", "Top series"),
  catalog("cinemeta", "Cinemeta", "series", "series-only", "Series only"),
  catalog("cinemeta", "Cinemeta", "movie", "netflix", "Netflix"),
  catalog("archive", "Archive", "movie", "classics", "Classics"),
];

const current = { addonKey: "cinemeta", type: "movie", id: "top" };
const prefs: CatalogPickerPrefs = { recentCount: 3, recent: [], hiddenAddons: [] };
const pickHandlers = () => ({
  onPick: vi.fn(),
  onPrefs: vi.fn(),
  onClose: vi.fn(),
});

const typeSearch = async (text: string) => {
  const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  stubMedia(false);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("CatalogPicker", () => {
  it("searches catalogs and picks a greyed row from another type", async () => {
    const handlers = pickHandlers();
    await act(async () => {
      root.render(<CatalogPicker catalogs={catalogs} current={current} prefs={prefs} {...handlers}/>);
    });
    await typeSearch("netf");
    expect([...host.querySelectorAll(".picker-group .picker-option-label")].map((node) => node.textContent)).toEqual(["Netflix"]);

    await typeSearch("");
    const greyRow = [...host.querySelectorAll<HTMLButtonElement>(".picker-option.picker-muted")]
      .find((button) => button.textContent?.includes("Series only"))!;
    await act(async () => { greyRow.click(); });
    expect(handlers.onPick).toHaveBeenCalledWith({ addonKey: "cinemeta", type: "series", id: "series-only" });
  });

  it("switches the listed type without choosing a catalog", async () => {
    const handlers = pickHandlers();
    await act(async () => {
      root.render(<CatalogPicker catalogs={catalogs} current={current} prefs={prefs} {...handlers}/>);
    });
    const series = [...host.querySelectorAll<HTMLButtonElement>('.picker-segments button')]
      .find((button) => button.textContent === "Series")!;
    await act(async () => { series.click(); });
    expect(handlers.onPick).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(series.getAttribute("aria-pressed")).toBe("true");
    // The series-only catalogue is now a normal row, no longer greyed out as another type.
    const seriesOnly = [...host.querySelectorAll<HTMLElement>(".picker-option")].find((node) => node.textContent?.includes("Series only"));
    expect(seriesOnly?.classList.contains("picker-muted")).toBe(false);
  });

  it("opens on the type it is given", async () => {
    const handlers = pickHandlers();
    await act(async () => {
      root.render(<CatalogPicker catalogs={catalogs} current={current} prefs={prefs} initialBucket="series" {...handlers}/>);
    });
    const pressed = host.querySelector<HTMLButtonElement>('.picker-segments button[aria-pressed="true"]');
    expect(pressed?.textContent).toBe("Series");
  });

  it("renders recent chips only while the preference allows them", async () => {
    const handlers = pickHandlers();
    const withRecent = {
      ...prefs,
      recent: [catalogs[3]!, catalogs[4]!].map((item) => ({ addonKey: item.addonKey, type: item.type, id: item.id })),
    };
    await act(async () => {
      root.render(<CatalogPicker catalogs={catalogs} current={current} prefs={withRecent} {...handlers}/>);
    });
    expect([...host.querySelectorAll(".picker-chip .picker-option-label")].map((node) => node.textContent))
      .toEqual(["Netflix", "Classics"]);

    await act(async () => {
      root.render(<CatalogPicker catalogs={catalogs} current={current} prefs={{ ...withRecent, recentCount: 0 }} {...handlers}/>);
    });
    expect(host.querySelector(".picker-chip")).toBeNull();
  });

  it("edits addon visibility and the recent count", async () => {
    const handlers = pickHandlers();
    await act(async () => {
      root.render(<CatalogPicker catalogs={catalogs} current={current} prefs={prefs} {...handlers}/>);
    });
    const edit = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit list")!;
    await act(async () => { edit.click(); });

    const cinemetaSwitch = host.querySelector<HTMLInputElement>(".picker-addon-row input")!;
    await act(async () => { cinemetaSwitch.click(); });
    expect(handlers.onPrefs).toHaveBeenCalledWith({ hiddenAddons: ["cinemeta"] });

    const off = [...host.querySelectorAll<HTMLButtonElement>(".picker-segments button")]
      .find((button) => button.textContent === "Off")!;
    await act(async () => { off.click(); });
    expect(handlers.onPrefs).toHaveBeenCalledWith({ recentCount: 0 });
  });
});

describe("GenrePicker", () => {
  it("hides All for a required genre", async () => {
    await act(async () => {
      root.render(<GenrePicker catalogName="Catalog" options={["Action", "Drama"]} required value="" onPick={() => undefined} onClose={() => undefined}/>);
    });
    expect([...host.querySelectorAll(".picker-option-label")].map((node) => node.textContent)).toEqual(["Action", "Drama"]);
  });

  it("adds search only above twelve options", async () => {
    const options = Array.from({ length: 12 }, (_, index) => `Genre ${index + 1}`);
    await act(async () => {
      root.render(<GenrePicker catalogName="Catalog" options={options} required={false} value="" onPick={() => undefined} onClose={() => undefined}/>);
    });
    expect(host.querySelector('[role="combobox"]')).toBeNull();

    await act(async () => {
      root.render(<GenrePicker catalogName="Catalog" options={[...options, "Genre 13"]} required={false} value="" onPick={() => undefined} onClose={() => undefined}/>);
    });
    expect(host.querySelector('[role="combobox"]')?.getAttribute("aria-label")).toBe("Find a genre");
  });
});

describe("ScopePicker", () => {
  const searchable: SearchableCatalog[] = [
    { addonKey: "cinemeta", addonName: "Cinemeta", globalSearch: true, type: "movie", id: "top", name: "Top movies" },
    { addonKey: "cinemeta", addonName: "Cinemeta", globalSearch: true, type: "series", id: "top", name: "Top series" },
    { addonKey: "manual", addonName: "Manual addon", globalSearch: false, type: "movie", id: "films", name: "Films" },
  ];

  it("summarises shared search, marks a manual addon and chooses its whole scope", async () => {
    const onPick = vi.fn();
    await act(async () => {
      root.render(<ScopePicker searchable={searchable} value="" type="" onPick={onPick} onClose={() => undefined}/>);
    });
    expect(host.querySelector(".picker-leading")?.textContent).toContain("Shared search");
    expect(host.querySelector(".picker-leading")?.textContent).toContain("Addons: 1;");

    const manual = host.querySelector<HTMLElement>('[role="group"][aria-label="Manual addon"]')!;
    expect(manual.querySelector(".picker-badge")?.textContent).toBe("manual only");
    const wholeAddon = [...manual.querySelectorAll<HTMLButtonElement>(".picker-option")]
      .find((button) => button.textContent?.includes("All catalogs of the addon"))!;
    await act(async () => { wholeAddon.click(); });
    expect(onPick).toHaveBeenCalledWith("addon:manual");
  });
});

function currentCatalog(): Catalog {
  return catalog("cinemeta", "Cinemeta", "movie", "top", "Top movies");
}
