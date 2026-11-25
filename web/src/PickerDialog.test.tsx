import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PickerDialog, type PickerGroup, type PickerOption } from "./PickerDialog";
import { setLocale } from "./i18n";

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

const option = (key: string, onChoose = () => undefined): PickerOption => ({
  key,
  label: key[0]!.toUpperCase() + key.slice(1),
  onChoose,
});

const groups = (): PickerGroup[] => [
  { key: "alpha", title: "Alpha addon", options: [option("alpha")] },
  { key: "beta", title: "Beta addon", options: [option("beta")] },
];

const optionLabels = () => [...host.querySelectorAll(".picker-option-label")].map((node) => node.textContent);

function Harness({ narrow, rail = false, accordion = false, openGroup }: {
  narrow: boolean;
  rail?: boolean;
  accordion?: boolean;
  openGroup?: string;
}) {
  const [query, setQuery] = useState("");
  const filtered = groups().map((group) => ({
    ...group,
    options: group.options.filter((item) => !query || String(item.label).toLowerCase().includes(query.toLowerCase())),
  })).filter((group) => group.options.length);
  return <PickerDialog label="Catalog" subtitle="Pick one" searchPlaceholder="Find"
    query={query} onQuery={setQuery} groups={filtered} rail={rail} accordion={accordion}
    openGroup={openGroup} onClose={() => undefined}/>;
}

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

describe("PickerDialog", () => {
  it("moves through visible options with the arrows and chooses with Enter", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(<PickerDialog label="Catalog" searchPlaceholder="Find" query="" onQuery={() => undefined}
        leading={[option("first", first), option("second", second)]} groups={[]} onClose={onClose}/>);
    });
    const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens the first group on a narrow screen when the current one is not listed, until folded", async () => {
    stubMedia(true);
    await act(async () => { root.render(<Harness narrow accordion openGroup="elsewhere"/>); });
    expect(optionLabels()).toEqual(["Alpha"]);
    const alpha = [...host.querySelectorAll<HTMLButtonElement>(".picker-accordion-head")]
      .find((button) => button.textContent?.includes("Alpha addon"))!;
    expect(alpha.getAttribute("aria-expanded")).toBe("true");
    await act(async () => { alpha.click(); });
    expect(optionLabels()).toEqual([]);
  });

  it("folds groups on a narrow screen until opened and shows every match while searching", async () => {
    stubMedia(true);
    await act(async () => { root.render(<Harness narrow accordion openGroup="alpha"/>); });
    expect(optionLabels()).toEqual(["Alpha"]);

    const beta = [...host.querySelectorAll<HTMLButtonElement>(".picker-accordion-head")]
      .find((button) => button.textContent?.includes("Beta addon"))!;
    await act(async () => { beta.click(); });
    expect(optionLabels()).toEqual(["Alpha", "Beta"]);

    const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "a");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(optionLabels()).toEqual(["Alpha", "Beta"]);
  });

  it("lists the groups in a wide-screen rail", async () => {
    await act(async () => { root.render(<Harness narrow={false} rail/>); });
    expect([...host.querySelectorAll<HTMLButtonElement>(".picker-rail > button")].map((button) => button.textContent))
      .toEqual(["Alpha addon", "Beta addon"]);
  });

  it("opens at the top, so the recent chips stay in view, and marks the current group in the rail", async () => {
    const scrolled: string[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this.textContent ?? ""); };
    try {
      await act(async () => { root.render(<Harness narrow={false} rail openGroup="beta"/>); });
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
    expect(scrolled.some((text) => text.includes("addon"))).toBe(false);
    expect(host.querySelector(".picker-rail [aria-current]")?.textContent).toContain("Beta addon");
  });
});
