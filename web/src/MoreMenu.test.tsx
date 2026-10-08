import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MoreMenu, type MoreItem } from "./MoreMenu";
import { setLocale } from "./i18n";

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

const item = (over: Partial<MoreItem> & Pick<MoreItem, "key">): MoreItem => ({ icon: null, label: over.key, active: false, onSelect: vi.fn(), ...over });

const render = async (items: MoreItem[], onSignOut = vi.fn()) => {
  await act(async () => {
    root.render(<MoreMenu items={items} badge={3} active={items.some((entry) => entry.active)} onSignOut={onSignOut}/>);
  });
  return { onSignOut };
};

const trigger = () => host.querySelector<HTMLButtonElement>(".nav-more")!;
const menu = () => document.querySelector<HTMLDivElement>(".more-menu");
const open = async () => { await act(async () => { trigger().click(); }); };

describe("MoreMenu", () => {
  it("opens the menu from a trigger that says whether it is open", async () => {
    await render([item({ key: "following" })]);
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(menu()).toBeNull();
    await open();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(menu()).not.toBeNull();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    await render([item({ key: "following" })]);
    await open();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(menu()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("chooses an item, closes and calls its handler", async () => {
    const settings = item({ key: "settings", label: "Settings" });
    await render([settings]);
    await open();
    await act(async () => { [...menu()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Settings")!.click(); });
    expect(settings.onSelect).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it("closes when a click lands outside it", async () => {
    await render([item({ key: "following" })]);
    await open();
    await act(async () => { document.body.click(); });
    expect(menu()).toBeNull();
  });

  it("signs out through the top bar's own handler", async () => {
    const { onSignOut } = await render([item({ key: "following" })]);
    await open();
    await act(async () => { [...menu()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Sign out")!.click(); });
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });
});
