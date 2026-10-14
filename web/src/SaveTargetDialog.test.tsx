import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SaveTargetDialog } from "./SaveTargetDialog";
import { setLocale } from "./i18n";
import type { LibraryView } from "./types";

const library = (over: Partial<LibraryView> = {}): LibraryView => ({
  id: "lib_1", name: "Films", type: "mixed", enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: false, autoScanMetadata: false, unreachable: false, readOnly: false, writable: true,
  defaultMovie: true, defaultSeries: true, titles: 0, files: 0, bytes: 0, ...over,
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
const dialog = () => document.querySelector<HTMLElement>(".save-target-card");
const primary = () => dialog()?.querySelector<HTMLButtonElement>("footer button.primary") ?? null;

const render = (over: Partial<Parameters<typeof SaveTargetDialog>[0]> = {}) => {
  const onClose = vi.fn();
  const onSubmit = vi.fn(async () => true);
  const props: Parameters<typeof SaveTargetDialog>[0] = {
    label: "Heat", kind: "movie", title: "Heat", libraries: [library()], rule: undefined, onClose, onSubmit, ...over,
  };
  act(() => root.render(<SaveTargetDialog {...props}/>));
  return { onClose, onSubmit, props };
};

describe("SaveTargetDialog shell", () => {
  it("portals the overlay to the body so a container query cannot clip it", () => {
    render();
    expect(dialog()).not.toBeNull();
    expect(host.contains(dialog())).toBe(false);
    expect(document.body.contains(dialog())).toBe(true);
  });

  it("renders extra children above the destination and holds the primary back when asked", () => {
    render({ submitDisabled: true, children: <p className="version-pick">Pick a version</p> });
    expect(dialog()!.textContent).toContain("Pick a version");
    expect(primary()!.disabled).toBe(true);
  });

  it("enables the primary by default", () => {
    render();
    expect(primary()!.disabled).toBe(false);
  });

  it("closes on Escape and returns focus to the invoking control", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { onClose } = render();
    expect(document.activeElement).not.toBe(trigger);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.render(null));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("does not close while a submit is running", async () => {
    let release!: () => void;
    const held = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const onSubmit = vi.fn(() => held);
    const { onClose } = render({ onSubmit });
    await act(async () => { primary()!.click(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()!.querySelector<HTMLButtonElement>(".identify-head button")!.disabled).toBe(true);
    expect(primary()!.disabled).toBe(true);
    await act(async () => { release(); await held; });
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog and its error when the submit fails", async () => {
    const onSubmit = vi.fn(async () => { throw new Error("This source is already in the library."); });
    const { onClose } = render({ onSubmit });
    await act(async () => { primary()!.click(); });
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()!.textContent).toContain("This source is already in the library.");
    expect(primary()!.disabled).toBe(false);
  });
});

it("does not close a replacement dialog after an old submission finishes", async () => {
  let release!: (value: boolean) => void;
  const pending = new Promise<boolean>((resolve) => { release = resolve; });
  const previousClose = vi.fn();
  render({ onClose: previousClose, onSubmit: () => pending });
  await act(async () => { primary()!.click(); });
  const replacementClose = vi.fn();
  await act(async () => { root.render(<SaveTargetDialog key="replacement" label="New title" kind="movie" title="New title" libraries={[library()]} rule={undefined} onClose={replacementClose} onSubmit={async () => true}/>); });
  await act(async () => { release(true); });
  await flush();
  expect(previousClose).not.toHaveBeenCalled();
  expect(replacementClose).not.toHaveBeenCalled();
  expect(dialog()).not.toBeNull();
});

describe("SaveTargetDialog with no projected native destination", () => {
  it("refuses the automatic option, explains it and holds the submit until a library is picked", async () => {
    const { onSubmit } = render({ ruleUnavailable: true, rule: undefined });
    const automatic = [...dialog()!.querySelectorAll<HTMLInputElement>(".bulk-strategy label")][0]!;
    expect(automatic.querySelector("small")!.textContent).toBe("The default destination is unavailable. Choose another library.");
    expect(automatic.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    expect(automatic.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
    expect(primary()!.disabled).toBe(true);
    await act(async () => { primary()!.click(); });
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();

    // A manual pick is still available, enables the submit and travels as an explicit target.
    const custom = [...dialog()!.querySelectorAll<HTMLElement>(".bulk-strategy label")].find((label) => label.textContent?.includes("Somewhere else"))!;
    await act(async () => { custom.querySelector("input")!.click(); });
    await flush();
    expect(primary()!.disabled).toBe(false);
    await act(async () => { primary()!.click(); });
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({ libraryId: "lib_1", subfolder: "", layout: "structured" });
  });

  it("never draws a false default path preview when the rule is unavailable", () => {
    render({ ruleUnavailable: true, rule: undefined });
    expect(dialog()!.textContent).not.toContain("Default library › Heat");
    expect(dialog()!.textContent).not.toContain("Heat › Heat");
  });

  it("keeps the automatic option and its preview when a destination is projected", async () => {
    const { onSubmit } = render({ rule: { movie: { subfolder: "Filmy", layout: "structured", libraryId: "lib_1" }, series: { subfolder: "", layout: "structured", libraryId: "lib_1" } } });
    expect(dialog()!.textContent).toContain("Films › Filmy › Heat");
    await act(async () => { primary()!.click(); });
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(undefined);
  });
});
